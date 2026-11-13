import type { DB } from './schema.ts';

export type SessionStatus = 'active' | 'paused' | 'closed';
export type StatusSource = 'process' | 'hook' | 'heuristic';
export type SummarySource = 'haiku' | 'heuristic';

export interface SessionRow {
  session_id: string;
  transcript_path: string;
  transcript_present: number;
  launch_cwd: string | null;
  cwd: string | null;
  project_name: string | null;
  project_kind: string | null;
  /** Solo en lecturas desde sessions_v: alias aplicado. */
  display_project: string | null;
  git_branch: string | null;
  entrypoint: string | null;
  claude_version: string | null;
  title: string | null;
  ai_title: string | null;
  custom_title: string | null;
  first_prompt: string | null;
  last_prompt: string | null;
  started_at: string | null;
  last_activity_at: string | null;
  last_message_at: string | null;
  message_count: number;
  compactions: number;
  away_summary: string | null;
  away_summary_at: string | null;
  pr_links: string;
  summary_json: string | null;
  summary_source: SummarySource | null;
  summary_updated_at: number | null;
  summary_covers_at: string | null;
  summary_error: string | null;
  user_note: string | null;
  status: SessionStatus;
  status_source: StatusSource | null;
  status_at: number | null;
  live_pid: number | null;
  ended_at: number | null;
  pinned: number;
  archived: number;
  hidden: number;
  transcript_mtime: number | null;
  transcript_size: number | null;
  scan_offset: number;
  scan_state: string | null;
  indexed_at: number;
  archive_bytes: number | null;
  archive_src_size: number | null;
  archive_updated_at: number | null;
}

/** Columnas que pertenecen al scanner. Las de la persona y las de estado nunca se pisan aquí. */
export type ScannedFields = Pick<
  SessionRow,
  | 'session_id' | 'transcript_path' | 'launch_cwd' | 'cwd' | 'project_name' | 'project_kind' | 'entrypoint'
  | 'claude_version' | 'title' | 'ai_title' | 'custom_title' | 'first_prompt' | 'last_prompt'
  | 'started_at' | 'last_activity_at' | 'last_message_at' | 'message_count' | 'compactions'
  | 'away_summary' | 'away_summary_at' | 'pr_links' | 'hidden' | 'transcript_mtime'
  | 'transcript_size' | 'scan_offset' | 'scan_state'
>;

const SCANNED_COLS: (keyof ScannedFields)[] = [
  'session_id', 'transcript_path', 'launch_cwd', 'cwd', 'project_name', 'project_kind', 'entrypoint',
  'claude_version', 'title', 'ai_title', 'custom_title', 'first_prompt', 'last_prompt',
  'started_at', 'last_activity_at', 'last_message_at', 'message_count', 'compactions',
  'away_summary', 'away_summary_at', 'pr_links', 'hidden', 'transcript_mtime',
  'transcript_size', 'scan_offset', 'scan_state',
];

export function upsertScanned(db: DB, f: ScannedFields): void {
  const cols = [...SCANNED_COLS, 'indexed_at', 'transcript_present'];
  const updates = cols
    .filter((c) => c !== 'session_id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  db.prepare(
    `INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})
     ON CONFLICT(session_id) DO UPDATE SET ${updates}`,
  ).run({ ...f, indexed_at: Date.now(), transcript_present: 1 });
}

export function getScanCursor(
  db: DB,
  sessionId: string,
): Pick<SessionRow, 'transcript_mtime' | 'transcript_size' | 'scan_offset' | 'scan_state'> | undefined {
  return db
    .prepare('SELECT transcript_mtime, transcript_size, scan_offset, scan_state FROM sessions WHERE session_id = ?')
    .get(sessionId) as never;
}

export function markMissing(db: DB, presentIds: Set<string>): number {
  const rows = db.prepare('SELECT session_id FROM sessions WHERE transcript_present = 1').all() as { session_id: string }[];
  const upd = db.prepare('UPDATE sessions SET transcript_present = 0 WHERE session_id = ?');
  let n = 0;
  db.transaction(() => {
    for (const r of rows) if (!presentIds.has(r.session_id)) n += upd.run(r.session_id).changes;
  })();
  return n;
}

export function getSession(db: DB, id: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions_v WHERE session_id = ?').get(id) as SessionRow | undefined;
}

/** Acepta un id completo o un prefijo único (≥ 6 caracteres), como git. */
export function resolveSessionId(db: DB, idOrPrefix: string): string | null {
  if (!/^[0-9a-f-]{6,36}$/i.test(idOrPrefix)) return null;
  const rows = db
    .prepare("SELECT session_id FROM sessions WHERE session_id LIKE ? || '%' LIMIT 2")
    .all(idOrPrefix.toLowerCase()) as { session_id: string }[];
  return rows.length === 1 ? rows[0].session_id : null;
}

export function listSessions(db: DB, opts: { includeHidden?: boolean; includeArchived?: boolean } = {}): SessionRow[] {
  const where: string[] = [];
  if (!opts.includeHidden) where.push('hidden = 0');
  if (!opts.includeArchived) where.push('archived = 0');
  return db
    .prepare(
      `SELECT * FROM sessions_v ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY pinned DESC, last_activity_at DESC`,
    )
    .all() as SessionRow[];
}

export function setStatus(
  db: DB,
  id: string,
  status: SessionStatus,
  source: StatusSource,
  livePid: number | null = null,
): boolean {
  return (
    db
      .prepare(
        `UPDATE sessions SET status = ?, status_source = ?, status_at = ?, live_pid = ?
         WHERE session_id = ? AND (status IS NOT ? OR status_source IS NOT ? OR live_pid IS NOT ?)`,
      )
      .run(status, source, Date.now(), livePid, id, status, source, livePid).changes > 0
  );
}

export function markEnded(db: DB, id: string): void {
  db.prepare('UPDATE sessions SET ended_at = ? WHERE session_id = ?').run(Date.now(), id);
}

export function saveSummary(
  db: DB,
  id: string,
  summary: unknown,
  source: SummarySource,
  coversAt: string | null,
  error: string | null = null,
): void {
  db.prepare(
    `UPDATE sessions SET summary_json = ?, summary_source = ?, summary_updated_at = ?,
       summary_covers_at = ?, summary_error = ? WHERE session_id = ?`,
  ).run(JSON.stringify(summary), source, Date.now(), coversAt, error, id);
}

// ── alias de proyecto ────────────────────────────────────────────────────────

export interface AliasRow {
  key: string;
  alias: string;
  updated_at: number;
}

export function setAlias(db: DB, key: string, alias: string): void {
  db.prepare(
    `INSERT INTO project_alias (key, alias, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET alias = excluded.alias, updated_at = excluded.updated_at`,
  ).run(key, alias.trim(), Date.now());
}

export function removeAlias(db: DB, key: string): boolean {
  return db.prepare('DELETE FROM project_alias WHERE key = ?').run(key).changes > 0;
}

export function listAliases(db: DB): AliasRow[] {
  return db.prepare('SELECT * FROM project_alias ORDER BY alias, key').all() as AliasRow[];
}

// ── campos de la persona ─────────────────────────────────────────────────────

export interface UserFields {
  user_note?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

export function updateUserFields(db: DB, id: string, f: UserFields): boolean {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (f.user_note !== undefined) {
    const note = f.user_note?.trim() ? f.user_note.trim() : null;
    sets.push('user_note = ?');
    vals.push(note);
  }
  if (f.pinned !== undefined) {
    sets.push('pinned = ?');
    vals.push(f.pinned ? 1 : 0);
  }
  if (f.archived !== undefined) {
    sets.push('archived = ?');
    vals.push(f.archived ? 1 : 0);
  }
  if (!sets.length) return false;
  return db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE session_id = ?`).run(...vals, id).changes > 0;
}

// ── copia local y borrado ────────────────────────────────────────────────────

export function saveArchiveInfo(db: DB, id: string, bytes: number | null, srcSize: number | null): void {
  db.prepare('UPDATE sessions SET archive_bytes = ?, archive_src_size = ?, archive_updated_at = ? WHERE session_id = ?').run(
    bytes,
    srcSize,
    bytes === null ? null : Date.now(),
    id,
  );
}

/** Sesiones cuyo transcript existe y ha crecido (o nunca se copió). */
export function sessionsNeedingArchive(db: DB): SessionRow[] {
  return db
    .prepare(
      `SELECT * FROM sessions_v WHERE hidden = 0 AND transcript_present = 1
       AND (archive_src_size IS NULL OR archive_src_size != transcript_size)
       ORDER BY last_activity_at DESC`,
    )
    .all() as SessionRow[];
}

export function isDeleted(db: DB, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM deleted_sessions WHERE session_id = ?').get(id);
}

/** Borra la fila y deja una lápida para que el scanner no la reindexe. */
export function deleteSession(db: DB, id: string): boolean {
  return db.transaction(() => {
    const n = db.prepare('DELETE FROM sessions WHERE session_id = ?').run(id).changes;
    db.prepare('INSERT OR REPLACE INTO deleted_sessions (session_id, deleted_at) VALUES (?, ?)').run(id, Date.now());
    return n > 0;
  })();
}
