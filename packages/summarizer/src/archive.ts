import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  SESSION_ID_RE,
  archiveDir,
  listSessions,
  readJsonl,
  redact,
  saveArchiveInfo,
  type DB,
  type SessionRow,
} from '@cpanel/core';
import { TranscriptCollector, redactCut, tilde, type Item } from './digest.ts';

/**
 * Copia local (opción C): el texto legible de la sesión —prompts, respuestas,
 * una línea por herramienta y solo los errores de sus salidas— redactado y en
 * gzip. Nunca se guardan salidas de herramientas ni el contenido de archivos
 * leídos, y las rutas de archivos secretos no se listan como «tocadas».
 * No sirve para `--resume`: no es un JSONL de Claude Code.
 */

/** Tope por mensaje: un pegado de 2 MB no aporta nada al archivo. */
const MAX_ITEM_CHARS = 20_000;
const MAX_TOOL_LINES = 40;

export function archiveFile(id: string, dir = archiveDir()): string {
  if (!SESSION_ID_RE.test(id)) throw new Error(`session_id inválido: ${JSON.stringify(id)}`);
  return join(dir, `${id.toLowerCase()}.txt.gz`);
}

type Meta = Pick<
  SessionRow,
  'session_id' | 'title' | 'display_project' | 'project_name' | 'cwd' | 'launch_cwd' | 'started_at' | 'last_activity_at' | 'entrypoint'
>;

/** Cada mensaje se redacta antes de recortarlo al tope (si no, el corte puede partir una clave). */
function render(i: Item): { text: string; count: number } {
  if (i.kind === 'tools') {
    return { text: i.lines.map((l) => `  · ${l}`).join('\n') + (i.extra ? `\n  · (+${i.extra} acciones más)` : ''), count: i.redactions };
  }
  const r = redactCut(i.text, MAX_ITEM_CHARS);
  return { text: `${i.kind === 'user' ? 'USUARIO' : 'CLAUDE'}: ${r.text}`, count: r.count };
}

/** Texto archivable de un transcript, ya redactado. Lee en streaming (hay JSONL de >100 MB). */
export async function buildArchiveText(transcriptPath: string, meta: Meta): Promise<{ text: string; redactions: number }> {
  const c = new TranscriptCollector({ maxToolLines: MAX_TOOL_LINES });
  await readJsonl(transcriptPath, 0, (r) => c.add(r));
  const head = [
    '# ClaudePanel · copia local de sesión (filtrada y redactada; no reanudable)',
    `session_id: ${meta.session_id}`,
    meta.title ? `título: ${meta.title}` : null,
    `proyecto: ${meta.display_project ?? meta.project_name ?? '—'}`,
    meta.cwd ? `directorio: ${meta.cwd}` : null,
    meta.launch_cwd && meta.launch_cwd !== meta.cwd ? `lanzada en: ${meta.launch_cwd}` : null,
    `inicio: ${meta.started_at ?? '—'} · última actividad: ${meta.last_activity_at ?? '—'}`,
    meta.entrypoint ? `origen: ${meta.entrypoint}` : null,
  ].filter(Boolean);
  const body = c.items.map(render);
  if (c.compact) {
    const r = redactCut(c.compact, MAX_ITEM_CHARS);
    body.unshift({ text: `[resumen de compactación]\n${r.text}`, count: r.count });
  }
  // última pasada sobre todo: cabecera (título, rutas) y lo que cruce de un mensaje a otro
  const { text, count } = redact(tilde(`${head.join('\n')}\n\n${body.map((b) => b.text).join('\n')}\n`));
  return { text, redactions: count + body.reduce((n, b) => n + b.count, 0) };
}

function writePrivate(path: string, data: Buffer): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export interface ArchiveResult {
  bytes: number;
  redactions: number;
}

/** Escribe (o reescribe) la copia de una sesión y lo anota en la DB. */
export async function archiveSession(db: DB, row: SessionRow, dir = archiveDir()): Promise<ArchiveResult | null> {
  if (row.hidden || !row.transcript_present) return null;
  const { text, redactions } = await buildArchiveText(row.transcript_path, row);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const gz = gzipSync(text, { level: 9 });
  writePrivate(archiveFile(row.session_id, dir), gz);
  saveArchiveInfo(db, row.session_id, gz.length, row.transcript_size);
  return { bytes: gz.length, redactions };
}

export function readArchive(id: string, dir = archiveDir()): string | null {
  try {
    return gunzipSync(readFileSync(archiveFile(id, dir))).toString('utf8');
  } catch {
    return null;
  }
}

export function removeArchive(id: string, dir = archiveDir()): boolean {
  try {
    unlinkSync(archiveFile(id, dir));
    return true;
  } catch {
    return false;
  }
}

export interface PruneOptions {
  olderThanDays: number;
  dryRun?: boolean;
  now?: number;
  dir?: string;
}

/**
 * Borra las copias de sesiones sin actividad en N días (y las huérfanas, sin
 * fila en la DB, por fecha del archivo). No toca la DB salvo para anotar que
 * ya no hay copia: el título, el resumen y la nota se conservan.
 */
export function pruneArchives(db: DB, opts: PruneOptions): { removed: string[]; bytes: number } {
  const dir = opts.dir ?? archiveDir();
  if (!(opts.olderThanDays > 0)) throw new Error('olderThanDays debe ser > 0');
  const cutoff = (opts.now ?? Date.now()) - opts.olderThanDays * 86_400_000;
  const rows = new Map(listSessions(db, { includeArchived: true, includeHidden: true }).map((r) => [r.session_id, r]));
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.txt.gz'));
  } catch {
    return { removed: [], bytes: 0 };
  }
  const removed: string[] = [];
  let bytes = 0;
  for (const f of files) {
    const id = f.slice(0, -'.txt.gz'.length);
    if (!SESSION_ID_RE.test(id)) continue;
    const p = join(dir, f);
    const st = statSync(p);
    const row = rows.get(id);
    const last = row?.last_activity_at ? Date.parse(row.last_activity_at) : st.mtimeMs;
    if (last >= cutoff) continue;
    removed.push(id);
    bytes += st.size;
    if (opts.dryRun) continue;
    unlinkSync(p);
    if (row) saveArchiveInfo(db, id, null, null);
  }
  return { removed, bytes };
}
