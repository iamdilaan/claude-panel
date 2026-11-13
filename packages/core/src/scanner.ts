import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { DB } from './db/schema.ts';
import { getScanCursor, isDeleted, markMissing, upsertScanned } from './db/sessions.ts';
import { emptyState, foldRecord, isPrUrl, isSummarizerSession, sessionTitle, type SessionScanState } from './jsonl/extract.ts';
import { readJsonl } from './jsonl/reader.ts';
import { refreshStatuses, type LiveProc } from './liveness.ts';
import { claudeProjectsDir } from './paths.ts';
import { makeGitRootFinder, pickProject, projectName } from './project.ts';

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export interface ScanStats {
  files: number;
  parsed: number;
  unchanged: number;
  fullRescans: number;
  bytesRead: number;
  badLines: number;
  hidden: number;
  /** Saltadas por estar borradas a mano. */
  deleted: number;
  missing: number;
  statusChanges: number;
  ms: number;
}

export interface TranscriptFile {
  sessionId: string;
  path: string;
  mtimeMs: number;
  size: number;
}

async function statTranscript(path: string): Promise<TranscriptFile | null> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    return { sessionId: basename(path, '.jsonl'), path, mtimeMs: Math.floor(s.mtimeMs), size: s.size };
  } catch {
    return null;
  }
}

/** Solo `<proyecto>/<uuid>.jsonl`; las carpetas subagents/ y tool-results/ no son sesiones. */
export async function listTranscripts(root = claudeProjectsDir()): Promise<TranscriptFile[]> {
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return [];
  }
  const out: TranscriptFile[] = [];
  for (const p of projects) {
    const dir = join(root, p);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !SESSION_FILE.test(e.name)) continue;
      const t = await statTranscript(join(dir, e.name));
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * Ruta de transcript segura para un session_id: debe ser
 * <root>/<carpeta>/<session_id>.jsonl. Rechaza cualquier otra ruta que llegue
 * de fuera (hooks), para que nadie pueda hacernos leer archivos arbitrarios.
 */
export function validTranscriptPath(path: string, sessionId: string, root = claudeProjectsDir()): boolean {
  if (!SESSION_ID_RE.test(sessionId)) return false;
  const abs = resolve(path);
  return abs === path && basename(abs) === `${sessionId}.jsonl` && dirname(dirname(abs)) === resolve(root) && !abs.includes(`${sep}..`);
}

export async function findTranscript(sessionId: string, root = claudeProjectsDir()): Promise<TranscriptFile | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return null;
  }
  for (const p of projects) {
    const t = await statTranscript(join(root, p, `${sessionId}.jsonl`));
    if (t) return t;
  }
  return null;
}

interface Ctx {
  stats: ScanStats;
  gitRoot: (dir: string) => string | null;
  full: boolean;
}

function newStats(files: number): ScanStats {
  return { files, parsed: 0, unchanged: 0, fullRescans: 0, bytesRead: 0, badLines: 0, hidden: 0, deleted: 0, missing: 0, statusChanges: 0, ms: 0 };
}

async function scanTranscript(db: DB, f: TranscriptFile, ctx: Ctx): Promise<void> {
  const { stats } = ctx;
  if (isDeleted(db, f.sessionId)) {
    stats.deleted++;
    return;
  }
  const cur = ctx.full ? undefined : getScanCursor(db, f.sessionId);
  // Un estado guardado sirve solo si es de esta versión del parser y el
  // archivo no ha encogido (reescrito). Si no, se relee desde 0.
  let saved: SessionScanState | null = null;
  if (cur?.scan_state && cur.scan_offset <= f.size) {
    try {
      const parsed = JSON.parse(cur.scan_state) as SessionScanState;
      if (parsed.v === emptyState().v) saved = parsed;
    } catch {
      // estado corrupto → relectura completa
    }
  }
  if (saved && cur?.transcript_size === f.size && cur.transcript_mtime === f.mtimeMs) {
    stats.unchanged++;
    // El nombre depende también del disco (¿se hizo git init?) y de las
    // reglas: se recalcula desde el estado guardado, sin releer el archivo.
    const info = pickProject(saved.cwdCounts, saved.firstCwd, ctx.gitRoot);
    const proj = projectName(info, saved);
    db.prepare(
      `UPDATE sessions SET cwd = ?, project_name = ?, project_kind = ?
       WHERE session_id = ? AND (cwd IS NOT ? OR project_name IS NOT ? OR project_kind IS NOT ?)`,
    ).run(info?.projectCwd ?? null, proj.name, proj.kind, f.sessionId, info?.projectCwd ?? null, proj.name, proj.kind);
    return;
  }
  const state: SessionScanState = saved ?? emptyState();
  const offset = saved ? cur!.scan_offset : 0;
  if (offset === 0) stats.fullRescans++;
  const res = await readJsonl(f.path, offset, (rec) => foldRecord(state, rec));
  stats.parsed++;
  stats.bytesRead += res.endOffset - offset;
  stats.badLines += res.badLines;

  const hidden = isSummarizerSession(state) ? 1 : 0;
  stats.hidden += hidden;
  const info = pickProject(state.cwdCounts, state.firstCwd, ctx.gitRoot);
  const proj = projectName(info, state);

  upsertScanned(db, {
    session_id: f.sessionId,
    transcript_path: f.path,
    launch_cwd: state.firstCwd,
    cwd: info?.projectCwd ?? null,
    project_name: proj.name,
    project_kind: proj.kind,
    entrypoint: state.entrypoint,
    claude_version: state.version,
    title: sessionTitle(state),
    ai_title: state.aiTitle,
    custom_title: state.customTitle,
    first_prompt: state.firstPrompt,
    last_prompt: state.lastPrompt,
    started_at: state.startedAt,
    last_activity_at: state.lastActivityAt ?? state.lastAnyAt,
    last_message_at: state.lastMessageAt,
    message_count: state.userPrompts + state.assistantReplies,
    compactions: state.compactions,
    away_summary: state.awaySummary,
    away_summary_at: state.awaySummaryAt,
    pr_links: JSON.stringify(state.prLinks.filter(isPrUrl)), // estados antiguos pueden traer enlaces no válidos
    hidden,
    transcript_mtime: f.mtimeMs,
    transcript_size: f.size,
    scan_offset: res.endOffset,
    scan_state: JSON.stringify(state),
  });
}

export interface ScanOptions {
  root?: string;
  /** Ignora los offsets guardados y relee todo. */
  full?: boolean;
  concurrency?: number;
  /** Procesos vivos ya calculados (tests); si se omite se consultan. false = no refrescar estados. */
  procs?: LiveProc[] | false;
  now?: number;
}

export async function scan(db: DB, opts: ScanOptions = {}): Promise<ScanStats> {
  const t0 = performance.now();
  const files = await listTranscripts(opts.root);
  const ctx: Ctx = { stats: newStats(files.length), gitRoot: makeGitRootFinder(), full: !!opts.full };

  // los más recientes primero: si el scan se corta, lo útil ya está indexado
  const queue = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const n = Math.max(1, opts.concurrency ?? 4);
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) await scanTranscript(db, f, ctx);
    }),
  );

  ctx.stats.missing = markMissing(db, new Set(files.map((f) => f.sessionId)));
  if (opts.procs !== false) ctx.stats.statusChanges = await refreshStatuses(db, opts.procs, opts.now);
  ctx.stats.ms = Math.round(performance.now() - t0);
  return ctx.stats;
}

/** Indexa una sola sesión (eventos de hook). Devuelve false si no hay transcript. */
export async function scanOne(db: DB, sessionId: string, hintPath?: string, root = claudeProjectsDir()): Promise<boolean> {
  const f =
    (hintPath && validTranscriptPath(hintPath, sessionId, root) ? await statTranscript(hintPath) : null) ??
    (await findTranscript(sessionId, root));
  if (!f || isDeleted(db, sessionId)) return false;
  await scanTranscript(db, f, { stats: newStats(1), gitRoot: makeGitRootFinder(), full: false });
  return true;
}
