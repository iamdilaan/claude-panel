import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { getSession, openDb, scan, type DB } from '@cpanel/core';
import { archiveFile, archiveSession, buildArchiveText, pruneArchives, readArchive } from '../src/archive.ts';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const user = (content: unknown, extra = {}) => ({ type: 'user', cwd: '/Users/test/app', timestamp: '2026-01-01T10:00:00Z', message: { content }, ...extra });
const asst = (content: object[]) => ({ type: 'assistant', cwd: '/Users/test/app', timestamp: '2026-01-01T10:01:00Z', message: { content } });

// Secretos sintéticos, uno por familia de patrón. Ninguno es real.
const SECRETS = {
  anthropic: 'sk-ant-api03-' + 'A'.repeat(40),
  openai: 'sk-proj-' + 'b'.repeat(40),
  stripe: 'sk_live_' + 'c'.repeat(24),
  github: 'ghp_' + 'd'.repeat(36),
  aws: 'AKIA' + 'E'.repeat(16),
  google: 'AIza' + 'f'.repeat(35),
  slack: 'xoxb-' + '1'.repeat(12) + '-abcdefghij',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'g'.repeat(20),
  bearer: 'Bearer ' + 'h'.repeat(32),
  urlPass: 'postgres://admin:hunter2secret@db.local:5432/x',
  envLine: 'DATABASE_PASSWORD=supersecretvalue123',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\n-----END RSA PRIVATE KEY-----',
};
const RAW_VALUES = [
  SECRETS.anthropic,
  SECRETS.openai,
  SECRETS.stripe,
  SECRETS.github,
  SECRETS.aws,
  SECRETS.google,
  SECRETS.slack,
  SECRETS.jwt,
  'h'.repeat(32),
  'hunter2secret',
  'supersecretvalue123',
  'MIIEowIBAAKCAQEAxyz',
];

function transcript(dir: string, lines: object[]): string {
  mkdirSync(join(dir, 'proj'), { recursive: true });
  const p = join(dir, 'proj', `${ID}.jsonl`);
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return p;
}

let root: string;
let archDir: string;
let db: DB;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cpanel-arch-'));
  archDir = join(mkdtempSync(join(tmpdir(), 'cpanel-arch-out-')), 'archive');
  db = openDb(':memory:');
});

const lines = () => [
  user(`Arregla el login. Mi clave es ${SECRETS.anthropic} y la de OpenAI ${SECRETS.openai}`),
  asst([
    { type: 'text', text: `Vale. Veo ${SECRETS.stripe} en el código y ${SECRETS.urlPass}.` },
    { type: 'tool_use', name: 'Read', input: { file_path: '/Users/test/app/.env' } },
    { type: 'tool_use', name: 'Bash', input: { command: `curl -H "Authorization: ${SECRETS.bearer}" https://api.x` } },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/Users/test/app/src/login.ts' } },
    { type: 'tool_use', name: 'Write', input: { file_path: '/Users/test/app/.env.local' } },
  ]),
  // salida normal de herramienta (p. ej. el contenido del .env): nunca se archiva
  user([{ type: 'tool_result', content: `${SECRETS.envLine}\nOTHER=valor-no-secreto-pero-salida`, is_error: false }]),
  // error con un secreto dentro: se archiva, redactado
  user([{ type: 'tool_result', content: `fatal: auth failed for ${SECRETS.github}`, is_error: true }]),
  user(`pego esto:\n${SECRETS.envLine}\n${SECRETS.pem}\naws ${SECRETS.aws} google ${SECRETS.google} slack ${SECRETS.slack} jwt ${SECRETS.jwt}`),
  // subagente: fuera del archivo
  { ...asst([{ type: 'text', text: 'texto de subagente' }]), isSidechain: true },
  asst([{ type: 'text', text: 'Hecho: login arreglado; falta el test de regresión.' }]),
];

describe('buildArchiveText', () => {
  it('redacta todos los secretos y nunca incluye salidas de herramientas', async () => {
    const p = transcript(root, lines());
    const { text, redactions } = await buildArchiveText(p, {
      session_id: ID, title: 'Login', display_project: 'app', project_name: 'app', cwd: '/Users/test/app',
      launch_cwd: '/Users/test/app', started_at: null, last_activity_at: null, entrypoint: 'cli',
    });
    for (const v of RAW_VALUES) expect(text, `se coló ${v}`).not.toContain(v);
    expect(redactions).toBeGreaterThanOrEqual(12);
    expect(text).not.toContain('valor-no-secreto-pero-salida');
    expect(text).not.toContain('texto de subagente');
    // lo útil sigue ahí
    expect(text).toContain('USUARIO: Arregla el login');
    expect(text).toContain('Bash: curl');
    expect(text).toContain('Edit /Users/test/app/src/login.ts');
    expect(text).toContain('error: fatal: auth failed for [REDACTED:github-token]');
    expect(text).toContain('CLAUDE: Hecho: login arreglado');
  });
});

describe('archiveSession', () => {
  it('escribe gzip 0600 en carpeta 0700, lo anota en la DB y se puede releer', async () => {
    transcript(root, lines());
    await scan(db, { root, procs: false });
    const row = getSession(db, ID)!;
    const res = await archiveSession(db, row, archDir);
    expect(res!.bytes).toBeGreaterThan(0);
    const file = archiveFile(ID, archDir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(archDir).mode & 0o777).toBe(0o700);
    const text = gunzipSync(readFileSync(file)).toString('utf8');
    expect(readArchive(ID, archDir)).toBe(text);
    for (const v of RAW_VALUES) expect(text).not.toContain(v);
    const after = getSession(db, ID)!;
    expect(after.archive_bytes).toBe(res!.bytes);
    expect(after.archive_src_size).toBe(after.transcript_size);
  });

  it('rechaza ids que no son UUID (sin path traversal)', () => {
    expect(() => archiveFile('../../etc/passwd', archDir)).toThrow();
    expect(() => archiveFile(`${ID}/../x`, archDir)).toThrow();
  });
});

describe('pruneArchives', () => {
  it('borra solo lo inactivo hace más de N días; --dry-run no borra', async () => {
    transcript(root, lines());
    await scan(db, { root, procs: false });
    await archiveSession(db, getSession(db, ID)!, archDir);
    const now = Date.parse('2026-01-01T10:01:00Z');

    expect(pruneArchives(db, { olderThanDays: 30, now: now + 10 * 86_400_000, dir: archDir }).removed).toEqual([]);
    const dry = pruneArchives(db, { olderThanDays: 30, now: now + 40 * 86_400_000, dir: archDir, dryRun: true });
    expect(dry.removed).toEqual([ID]);
    expect(readArchive(ID, archDir)).not.toBeNull();

    const real = pruneArchives(db, { olderThanDays: 30, now: now + 40 * 86_400_000, dir: archDir });
    expect(real.removed).toEqual([ID]);
    expect(readArchive(ID, archDir)).toBeNull();
    // la sesión sigue en la DB, sin copia
    expect(getSession(db, ID)!.archive_bytes).toBeNull();
    expect(getSession(db, ID)!.title).toBeTruthy();
  });
});
