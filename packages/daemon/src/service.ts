import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  SESSION_ID_RE,
  getSession,
  listSessions,
  markEnded,
  needsSummary,
  queueDir,
  refreshStatuses,
  saveSummary,
  scanOne,
  setStatus,
  type DB,
  type Logger,
  type SessionRow,
} from '@cpanel/core';
import {
  LaunchError,
  assertDir,
  buildContinuePrompt,
  continueCommand,
  continueDir,
  launchDir,
  openInTerminal,
  resumeBlockReason,
  resumeCommand,
  sessionsNeedingArchive,
  writeLaunchPrompt,
  type Runner,
} from '@cpanel/core';
import { archiveFile, archiveSession, pruneArchives, readArchive, summarizeSession, type SummarizeDeps } from '@cpanel/summarizer';
import { existsSync } from 'node:fs';

export const HookEventSchema = z
  .object({
    hook_event_name: z.enum(['Stop', 'SessionEnd']),
    session_id: z.string().regex(SESSION_ID_RE),
    transcript_path: z.string().max(4096).optional(),
    cwd: z.string().max(4096).optional(),
    reason: z.string().max(200).optional(),
  })
  .loose();
export type HookEvent = z.infer<typeof HookEventSchema>;

/** Tras un Stop, esperar este tiempo sin más eventos antes de resumir. */
export const STOP_SUMMARY_DEBOUNCE_MS = 5 * 60 * 1000;
export const BACKFILL_RECENT = 30;

type Priority = 'high' | 'low';

/**
 * Cola de resúmenes: sin duplicados, prioridad alta (SessionEnd, petición
 * explícita) delante de baja (backfill), concurrencia limitada.
 */
export class SummaryQueue {
  private high: string[] = [];
  private low: string[] = [];
  private queued = new Set<string>();
  private forced = new Set<string>();
  private running = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private idleWaiters: (() => void)[] = [];
  private db: DB;
  private log: Logger;
  private concurrency: number;
  private deps: SummarizeDeps;

  private archiveDir: string | undefined;

  constructor(db: DB, log: Logger, opts: { concurrency?: number; deps?: SummarizeDeps; archiveDir?: string } = {}) {
    this.db = db;
    this.log = log;
    this.concurrency = opts.concurrency ?? 2;
    this.deps = opts.deps ?? {};
    this.archiveDir = opts.archiveDir;
  }

  enqueue(id: string, priority: Priority = 'low', force = false): boolean {
    if (force) this.forced.add(id);
    if (this.queued.has(id) || this.running.has(id)) {
      if (priority === 'high' && this.low.includes(id)) {
        this.low = this.low.filter((x) => x !== id);
        this.high.push(id);
      }
      return false;
    }
    this.queued.add(id);
    (priority === 'high' ? this.high : this.low).push(id);
    queueMicrotask(() => this.pump());
    return true;
  }

  /** Programa un resumen tras `delay` ms; cada llamada reinicia el temporizador. */
  debounce(id: string, delay: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.enqueue(id, 'high');
      }, delay).unref(),
    );
  }

  get size() {
    return { queued: this.queued.size, running: this.running.size, scheduled: this.timers.size };
  }

  /** Resuelve cuando no queda nada en cola ni ejecutándose (tests, CLI). */
  idle(): Promise<void> {
    if (!this.queued.size && !this.running.size) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.high = [];
    this.low = [];
    this.queued.clear();
  }

  private pump(): void {
    while (this.running.size < this.concurrency) {
      const id = this.high.shift() ?? this.low.shift();
      if (!id) break;
      this.queued.delete(id);
      this.running.add(id);
      void this.run(id).finally(() => {
        this.running.delete(id);
        this.pump();
        if (!this.queued.size && !this.running.size) for (const w of this.idleWaiters.splice(0)) w();
      });
    }
  }

  private async run(id: string): Promise<void> {
    const force = this.forced.delete(id);
    const row = getSession(this.db, id);
    if (!row || row.hidden) return;
    // Sin transcript (Claude Code lo borró): solo a petición, y desde la copia local si la hay.
    let archiveText: string | undefined;
    if (!row.transcript_present) {
      if (!force) return;
      archiveText = readArchive(id, this.archiveDir) ?? undefined;
      if (archiveText === undefined) return;
    } else if (!force && !needsSummary(row)) return;
    const coversAt = row.last_activity_at; // lo que llegue durante el resumen lo dejará desfasado
    try {
      const res = await summarizeSession(row, { ...this.deps, archiveText });
      saveSummary(this.db, id, res.summary, res.source, coversAt, res.error);
      this.log.info('summary', { id, source: res.source, ms: res.ms, redactions: res.redactions, error: res.error ?? undefined });
    } catch (e) {
      this.log.error('summary failed', { id, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

export interface ServiceDeps {
  db: DB;
  log: Logger;
  queue: SummaryQueue;
  stopDebounceMs?: number;
  /** Copia local de transcripts (opción C). Por defecto activada. */
  archive?: ArchiveWorker;
}

export async function handleHookEvent(ev: HookEvent, deps: ServiceDeps): Promise<{ indexed: boolean }> {
  const { db, queue, log } = deps;
  const id = ev.session_id;
  const indexed = await scanOne(db, id, ev.transcript_path);
  if (!indexed) {
    log.warn('hook sin transcript', { id, event: ev.hook_event_name });
    return { indexed };
  }
  if (ev.hook_event_name === 'SessionEnd') {
    markEnded(db, id);
    setStatus(db, id, 'closed', 'hook');
    queue.enqueue(id, 'high');
    deps.archive?.request(id);
  } else {
    setStatus(db, id, 'paused', 'hook');
    queue.debounce(id, deps.stopDebounceMs ?? STOP_SUMMARY_DEBOUNCE_MS);
  }
  await refreshStatuses(db);
  log.info('hook', { id, event: ev.hook_event_name, reason: ev.reason });
  return { indexed };
}

/** Procesa los eventos que cpanel-hook dejó en disco cuando el daemon no respondía. */
export async function drainQueue(deps: ServiceDeps, dir = queueDir()): Promise<number> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const p = join(dir, f);
    try {
      const ev = HookEventSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
      await handleHookEvent(ev, deps);
      n++;
    } catch (e) {
      deps.log.warn('evento en cola inválido, se descarta', { file: f, error: e instanceof Error ? e.message : String(e) });
    }
    try {
      unlinkSync(p);
    } catch {
      // ya borrado
    }
  }
  return n;
}

/**
 * Encola resúmenes para las N sesiones más recientes que lo necesiten; el resto,
 * bajo demanda. Las que están trabajando ahora (active) se saltan: su resumen
 * caducaría enseguida; las cubren el Stop con debounce y el SessionEnd.
 */
export function backfillSummaries(db: DB, queue: SummaryQueue, recent = BACKFILL_RECENT): number {
  let n = 0;
  for (const r of listSessions(db).slice(0, recent)) {
    if (r.status !== 'active' && needsSummary(r) && queue.enqueue(r.session_id, 'low')) n++;
  }
  return n;
}

// ── copia local (opción C) ───────────────────────────────────────────────────

/**
 * Mantiene ~/.claude-panel/archive al día, de una en una para no competir con
 * el resumidor: lee transcripts de cientos de MB.
 */
export class ArchiveWorker {
  private db: DB;
  private log: Logger;
  private dir: string | undefined;
  private pending = new Set<string>();
  private running: Promise<void> | null = null;

  constructor(db: DB, log: Logger, opts: { dir?: string } = {}) {
    this.db = db;
    this.log = log;
    this.dir = opts.dir;
  }

  request(id: string): void {
    this.pending.add(id);
    this.kick();
  }

  /** Encola todas las sesiones cuyo transcript creció desde la última copia. */
  requestStale(): number {
    const rows = sessionsNeedingArchive(this.db);
    for (const r of rows) this.pending.add(r.session_id);
    this.kick();
    return rows.length;
  }

  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private kick(): void {
    if (this.running) return;
    this.running = (async () => {
      for (let id = this.next(); id; id = this.next()) {
        const row = getSession(this.db, id);
        if (!row) continue;
        try {
          const res = await archiveSession(this.db, row, this.dir);
          if (res) this.log.info('archive', { id, bytes: res.bytes, redactions: res.redactions });
        } catch (e) {
          this.log.warn('archive falló', { id, error: e instanceof Error ? e.message : String(e) });
        }
      }
    })().finally(() => {
      this.running = null;
      if (this.pending.size) this.kick();
    });
  }

  private next(): string | undefined {
    const id = this.pending.values().next().value;
    if (id) this.pending.delete(id);
    return id;
  }

  prune(days: number) {
    return pruneArchives(this.db, { olderThanDays: days, dir: this.dir });
  }

  has(id: string): boolean {
    return existsSync(archiveFile(id, this.dir));
  }
}

// ── lanzador ─────────────────────────────────────────────────────────────────

export type LaunchMode = 'continue' | 'resume';

export interface LaunchResult {
  mode: LaunchMode;
  command: string;
  promptPath?: string;
}

export function continuePromptFor(row: SessionRow, archive?: ArchiveWorker): string {
  return buildContinuePrompt(row, { archiveExists: archive?.has(row.session_id) ?? false });
}

/**
 * Abre Terminal.app con la sesión. Lanza LaunchError con un código que la API
 * traduce a 4xx. `force` permite reanudar una sesión que sigue abierta.
 */
export async function launchSession(
  db: DB,
  id: string,
  mode: LaunchMode,
  opts: { run?: Runner; force?: boolean; archive?: ArchiveWorker; launchDir?: string } = {},
): Promise<LaunchResult> {
  const row = getSession(db, id);
  if (!row) throw new LaunchError('invalid', 'sesión no encontrada');
  if (mode === 'resume') {
    const blocked = resumeBlockReason(row);
    if (blocked) throw new LaunchError('resume-blocked', blocked);
    if (!opts.force && row.status !== 'closed' && row.status_source === 'process') {
      throw new LaunchError('active', 'Esta sesión sigue abierta en otro terminal. Reanudarla aquí abriría dos procesos sobre el mismo transcript.');
    }
    const command = resumeCommand(assertDir(row.launch_cwd, 'directorio de lanzamiento'), row.session_id, row.display_project ?? 'Sin proyecto');
    await openInTerminal(command, opts.run);
    return { mode, command };
  }
  const dir = assertDir(continueDir(row), 'directorio del proyecto');
  const promptPath = writeLaunchPrompt(row.session_id, continuePromptFor(row, opts.archive), opts.launchDir ?? launchDir());
  const command = continueCommand(dir, promptPath, row.display_project ?? 'Sin proyecto');
  await openInTerminal(command, opts.run);
  return { mode, command, promptPath };
}
