import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DB } from './db/schema.ts';
import { setStatus, type SessionRow, type SessionStatus, type StatusSource } from './db/sessions.ts';
import { claudeSessionsDir } from './paths.ts';

export interface LiveProc {
  pid: number;
  /** Conocido si viene del registro ~/.claude/sessions; null si solo lo vimos en ps. */
  sessionId: string | null;
  cwd: string | null;
  /** status del registro ("busy" = trabajando); null si se desconoce. */
  busy: boolean | null;
  source: 'registry' | 'ps';
}

function run(cmd: string, args: string[], timeout = 2000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout, maxBuffer: 8 << 20, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
      (err, stdout) => resolve(err && !stdout ? '' : stdout),
    );
  });
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

interface PsEntry {
  lstart: string;
  comm: string;
}

/** pid → arranque (UTC, locale C) y ejecutable, de todos los procesos del usuario. */
async function psTable(): Promise<Map<number, PsEntry>> {
  const out = await run('ps', ['-x', '-o', 'pid=,lstart=,comm=']);
  const map = new Map<number, PsEntry>();
  for (const line of out.split('\n')) {
    // " 69504 Wed Nov 11 14:36:49 2026 claude"
    const m = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    if (m) map.set(Number(m[1]), { lstart: norm(m[2]), comm: m[3].trim() });
  }
  return map;
}

const isClaudeExe = (comm: string) => /^claude(\.exe)?$/.test(basename(comm));

async function cwdsOf(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!pids.length) return map;
  const out = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn']);
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) map.set(pid, line.slice(1));
  }
  return map;
}

/**
 * Procesos de Claude Code vivos. Fuente principal: el registro de Claude Code
 * (<pid>.json, que trae el sessionId), validado con ps para descartar PIDs
 * reutilizados. Respaldo: procesos `claude` sin entrada en el registro,
 * con su cwd vía lsof. Nunca se leen los archivos .key del registro.
 */
export async function liveClaudeProcesses(registryDir = claudeSessionsDir()): Promise<LiveProc[]> {
  const ps = await psTable();
  const out: LiveProc[] = [];
  const covered = new Set<number>();

  let files: string[] = [];
  try {
    files = (await readdir(registryDir)).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    // sin registro (versiones antiguas de Claude Code)
  }
  for (const f of files) {
    try {
      const j = JSON.parse(await readFile(join(registryDir, f), 'utf8')) as Record<string, unknown>;
      const pid = Number(j.pid);
      const p = ps.get(pid);
      if (!p) continue; // muerto
      const procStart = typeof j.procStart === 'string' ? norm(j.procStart) : null;
      if (procStart ? procStart !== p.lstart : !isClaudeExe(p.comm)) continue; // PID reutilizado
      covered.add(pid);
      out.push({
        pid,
        sessionId: typeof j.sessionId === 'string' ? j.sessionId : null,
        cwd: typeof j.cwd === 'string' ? j.cwd : null,
        busy: typeof j.status === 'string' ? j.status === 'busy' : null,
        source: 'registry',
      });
    } catch {
      // archivo a medio escribir: se ignora en esta pasada
    }
  }

  const orphans = [...ps].filter(([pid, e]) => isClaudeExe(e.comm) && !covered.has(pid)).map(([pid]) => pid);
  const cwds = await cwdsOf(orphans);
  for (const pid of orphans) {
    out.push({ pid, sessionId: null, cwd: cwds.get(pid) ?? null, busy: null, source: 'ps' });
  }
  return out;
}

export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

type Decision = { status: SessionStatus; source: StatusSource; pid: number | null };

/**
 * Decide el estado de cada sesión:
 *  1. proceso vivo con su sessionId → active (busy) / paused (idle)
 *  2. proceso `claude` sin registro → la sesión más reciente lanzada en su cwd
 *  3. SessionEnd recibido después de la última actividad → closed
 *  4. actividad hace < 15 min → active (heurística); si no → closed
 */
export function decideStatuses(
  rows: Pick<SessionRow, 'session_id' | 'launch_cwd' | 'last_activity_at' | 'ended_at'>[],
  procs: LiveProc[],
  now = Date.now(),
): Map<string, Decision> {
  const res = new Map<string, Decision>();
  const lastMs = (r: (typeof rows)[number]) => (r.last_activity_at ? Date.parse(r.last_activity_at) : 0);
  // SessionEnd posterior a la última actividad manda: el hook llega mientras el
  // proceso aún está saliendo y sigue unos instantes en el registro.
  for (const r of rows) {
    if (r.ended_at && r.ended_at >= lastMs(r)) res.set(r.session_id, { status: 'closed', source: 'hook', pid: null });
  }
  const byId = new Map(procs.filter((p) => p.sessionId).map((p) => [p.sessionId!, p]));
  for (const r of rows) {
    const p = byId.get(r.session_id);
    if (p && !res.has(r.session_id)) {
      res.set(r.session_id, { status: p.busy === false ? 'paused' : 'active', source: 'process', pid: p.pid });
    }
  }
  for (const p of procs) {
    if (p.sessionId || !p.cwd) continue;
    const cand = rows
      .filter((r) => r.launch_cwd === p.cwd && !res.has(r.session_id))
      .sort((a, b) => lastMs(b) - lastMs(a))[0];
    if (cand) {
      const recent = now - lastMs(cand) < 2 * 60 * 1000;
      res.set(cand.session_id, { status: recent ? 'active' : 'paused', source: 'process', pid: p.pid });
    }
  }
  for (const r of rows) {
    if (res.has(r.session_id)) continue;
    const last = lastMs(r);
    if (now - last < ACTIVE_WINDOW_MS) res.set(r.session_id, { status: 'active', source: 'heuristic', pid: null });
    else res.set(r.session_id, { status: 'closed', source: 'heuristic', pid: null });
  }
  return res;
}

export async function refreshStatuses(db: DB, procs?: LiveProc[], now = Date.now()): Promise<number> {
  const live = procs ?? (await liveClaudeProcesses());
  const rows = db
    .prepare('SELECT session_id, launch_cwd, last_activity_at, ended_at FROM sessions WHERE hidden = 0')
    .all() as Pick<SessionRow, 'session_id' | 'launch_cwd' | 'last_activity_at' | 'ended_at'>[];
  const decisions = decideStatuses(rows, live, now);
  let changed = 0;
  db.transaction(() => {
    for (const [id, d] of decisions) if (setStatus(db, id, d.status, d.source, d.pid)) changed++;
  })();
  return changed;
}
