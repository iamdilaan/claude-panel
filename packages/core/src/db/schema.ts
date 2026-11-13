import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbPath } from '../paths.ts';

export type DB = Database.Database;

/**
 * Migraciones en orden; PRAGMA user_version guarda cuántas se han aplicado.
 * Nunca editar una migración publicada: añadir otra.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    session_id          TEXT PRIMARY KEY,
    transcript_path     TEXT NOT NULL,
    transcript_present  INTEGER NOT NULL DEFAULT 1,   -- 0 si Claude Code lo borró
    launch_cwd          TEXT,                         -- primer cwd: donde se ejecuta --resume
    cwd                 TEXT,                         -- directorio principal de trabajo
    project_name        TEXT,
    git_branch          TEXT,                         -- caché de git en vivo; nunca del JSONL
    git_checked_at      INTEGER,
    entrypoint          TEXT,                         -- cli | claude-desktop | …
    claude_version      TEXT,
    title               TEXT,                         -- custom > ai > primer prompt
    ai_title            TEXT,
    custom_title        TEXT,
    first_prompt        TEXT,
    last_prompt         TEXT,
    started_at          TEXT,
    last_activity_at    TEXT,
    last_message_at     TEXT,
    message_count       INTEGER NOT NULL DEFAULT 0,   -- prompts humanos + respuestas de texto
    compactions         INTEGER NOT NULL DEFAULT 0,
    away_summary        TEXT,
    away_summary_at     TEXT,
    pr_links            TEXT NOT NULL DEFAULT '[]',   -- JSON array de URLs
    summary_json        TEXT,                         -- {objetivo, hecho[], estado_actual, siguiente_paso, archivos_tocados[]}
    summary_source      TEXT,                         -- away | haiku | heuristic
    summary_updated_at  INTEGER,
    user_note           TEXT,
    status              TEXT NOT NULL DEFAULT 'closed' CHECK (status IN ('active','paused','closed')),
    pinned              INTEGER NOT NULL DEFAULT 0,
    archived            INTEGER NOT NULL DEFAULT 0,
    hidden              INTEGER NOT NULL DEFAULT 0,   -- sesiones del propio resumidor
    transcript_mtime    INTEGER,                      -- ms
    transcript_size     INTEGER,
    scan_offset         INTEGER NOT NULL DEFAULT 0,
    scan_state          TEXT,                         -- estado incremental del parser
    indexed_at          INTEGER NOT NULL
  );
  CREATE INDEX sessions_activity ON sessions(last_activity_at DESC);
  CREATE INDEX sessions_project  ON sessions(project_name);
  `,
  // 2 — alias de proyecto, estado vivo, control de resúmenes
  `
  ALTER TABLE sessions ADD COLUMN project_kind TEXT;            -- git | title | dir | none
  ALTER TABLE sessions ADD COLUMN status_source TEXT;           -- process | hook | heuristic
  ALTER TABLE sessions ADD COLUMN status_at INTEGER;
  ALTER TABLE sessions ADD COLUMN live_pid INTEGER;
  ALTER TABLE sessions ADD COLUMN ended_at INTEGER;             -- SessionEnd recibido
  ALTER TABLE sessions ADD COLUMN summary_covers_at TEXT;       -- last_activity_at que cubre el resumen
  ALTER TABLE sessions ADD COLUMN summary_error TEXT;

  -- Editable por la persona; el scanner nunca la toca.
  -- key = ruta absoluta (cwd de trabajo) o nombre de proyecto derivado.
  CREATE TABLE project_alias (
    key         TEXT PRIMARY KEY,
    alias       TEXT NOT NULL CHECK (length(trim(alias)) > 0),
    updated_at  INTEGER NOT NULL
  );

  -- Proyecto que se muestra: alias por ruta > alias por nombre > nombre derivado.
  CREATE VIEW sessions_v AS
  SELECT s.*,
         COALESCE(ac.alias, an.alias, s.project_name) AS display_project
  FROM sessions s
  LEFT JOIN project_alias ac ON ac.key = s.cwd
  LEFT JOIN project_alias an ON an.key = s.project_name;
  `,
  // 3 — copia local de transcripts y borrado definitivo
  `
  ALTER TABLE sessions ADD COLUMN archive_bytes INTEGER;          -- tamaño del .txt.gz
  ALTER TABLE sessions ADD COLUMN archive_src_size INTEGER;       -- transcript_size que cubre la copia
  ALTER TABLE sessions ADD COLUMN archive_updated_at INTEGER;

  -- Sesiones borradas a mano: el scanner no las vuelve a indexar aunque el JSONL siga ahí.
  CREATE TABLE deleted_sessions (
    session_id  TEXT PRIMARY KEY,
    deleted_at  INTEGER NOT NULL
  );
  `,
];

export function openDb(path = dbPath()): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}
