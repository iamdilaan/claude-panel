import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/schema.ts';
import { getSession, listSessions, removeAlias, setAlias } from '../src/db/sessions.ts';
import { NO_PROJECT, pickProject, projectName } from '../src/project.ts';
import { scan, scanOne, validTranscriptPath } from '../src/scanner.ts';
import { SUMMARIZER_MARKER } from '../src/paths.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'basic.jsonl');
const ID = '11111111-2222-3333-4444-555555555555';
const ID2 = '99999999-2222-3333-4444-555555555555';
const NOW = Date.parse('2026-02-01T00:00:00Z');
const HOME = '/Users/test';

describe('pickProject / projectName', () => {
  const git = (d: string) => (d.startsWith('/Users/test/app') ? '/Users/test/app' : null);
  const noTitles = { customTitle: null, aiTitle: null };

  it('agrupa por raíz git e ignora $HOME, ~/.claude y node_modules', () => {
    const p = pickProject(
      {
        '/Users/test': 500,
        '/Users/test/.claude/projects/x/memory': 400,
        '/Users/test/app': 100,
        '/Users/test/app/ios/App': 100,
        '/Users/test/app/node_modules/foo': 50,
        '/Users/test/research': 200,
      },
      HOME,
      git,
      HOME,
    );
    expect(p).toEqual({ projectCwd: '/Users/test/app', isGitRoot: true });
    // con repo, manda el nombre del repo aunque haya título
    expect(projectName(p, { customTitle: 'Mi título', aiTitle: null }, HOME)).toEqual({ name: 'app', kind: 'git' });
  });

  it('sin git: título > directorio con más trabajo (sin agrupar en el padre)', () => {
    const p = pickProject({ '/Users/test/webs': 490, '/Users/test/webs/lut': 492 }, null, () => null, HOME);
    expect(p).toEqual({ projectCwd: '/Users/test/webs/lut', isGitRoot: false });
    expect(projectName(p, noTitles, HOME)).toEqual({ name: 'lut', kind: 'dir' });
    expect(projectName(p, { customTitle: null, aiTitle: 'Conversor LUT' }, HOME)).toEqual({ name: 'Conversor LUT', kind: 'title' });
    expect(projectName(p, { customTitle: 'Mío', aiTitle: 'IA' }, HOME).name).toBe('Mío');
  });

  it('cwd = ~ sin repo → «Sin proyecto», aunque tenga título', () => {
    const p = pickProject({ '/Users/test': 3 }, HOME, () => null, HOME);
    expect(projectName(p, { customTitle: null, aiTitle: 'Televisor lento' }, HOME)).toEqual({ name: NO_PROJECT, kind: 'none' });
  });
});

describe('validTranscriptPath', () => {
  const root = '/r/projects';
  it('solo acepta <root>/<carpeta>/<id>.jsonl', () => {
    expect(validTranscriptPath(`${root}/-Users-x/${ID}.jsonl`, ID, root)).toBe(true);
    expect(validTranscriptPath(`${root}/-Users-x/${ID2}.jsonl`, ID, root)).toBe(false);
    expect(validTranscriptPath(`${root}/-Users-x/../../etc/${ID}.jsonl`, ID, root)).toBe(false);
    expect(validTranscriptPath(`/etc/${ID}.jsonl`, ID, root)).toBe(false);
    expect(validTranscriptPath(`${root}/a/b/${ID}.jsonl`, ID, root)).toBe(false);
    expect(validTranscriptPath(`${root}/a/${ID}.jsonl`, '../x', root)).toBe(false);
  });
});

describe('scan', () => {
  let root: string;
  let db: DB;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cpanel-scan-'));
    mkdirSync(join(root, '-Users-test', ID, 'subagents'), { recursive: true });
    copyFileSync(FIXTURE, join(root, '-Users-test', `${ID}.jsonl`));
    // subagentes y archivos que no son sesiones: se ignoran
    copyFileSync(FIXTURE, join(root, '-Users-test', ID, 'subagents', 'agent-abc.jsonl'));
    writeFileSync(join(root, '-Users-test', 'notas.jsonl'), '{}\n');
    db = openDb(':memory:');
  });

  it('indexa, es incremental y no pisa los campos de la persona', async () => {
    const s1 = await scan(db, { root, procs: [], now: NOW });
    expect(s1).toMatchObject({ files: 1, parsed: 1, fullRescans: 1 });
    let [row] = listSessions(db);
    expect(row).toMatchObject({
      session_id: ID,
      launch_cwd: '/Users/test',
      title: 'Título IA',
      status: 'closed',
      status_source: 'heuristic',
      message_count: 5,
      last_activity_at: '2026-01-01T10:04:00.000Z',
    });
    expect(JSON.parse(row.pr_links)).toHaveLength(1);

    db.prepare("UPDATE sessions SET user_note = 'mi nota', pinned = 1, summary_json = '{}' WHERE session_id = ?").run(ID);

    const s2 = await scan(db, { root, procs: [], now: NOW });
    expect(s2).toMatchObject({ parsed: 0, unchanged: 1 });

    appendFileSync(
      join(root, '-Users-test', `${ID}.jsonl`),
      `${JSON.stringify({ type: 'custom-title', customTitle: 'Renombrada' })}\n` +
        `${JSON.stringify({ type: 'user', timestamp: '2026-01-02T09:00:00.000Z', message: { content: 'seguimos' } })}\n`,
    );
    const s3 = await scan(db, { root, procs: [], now: NOW });
    expect(s3).toMatchObject({ parsed: 1, fullRescans: 0 });
    expect(s3.bytesRead).toBeLessThan(500);
    [row] = listSessions(db);
    expect(row).toMatchObject({
      title: 'Renombrada',
      last_prompt: 'seguimos',
      message_count: 6,
      user_note: 'mi nota',
      pinned: 1,
      summary_json: '{}',
    });
  });

  it('marca activa por proceso vivo con su sessionId', async () => {
    await scan(db, { root, procs: [{ pid: 42, sessionId: ID, cwd: '/Users/test', busy: false, source: 'registry' }], now: NOW });
    expect(getSession(db, ID)).toMatchObject({ status: 'paused', status_source: 'process', live_pid: 42 });
  });

  it('conserva la sesión cuando Claude Code borra el transcript', async () => {
    await scan(db, { root, procs: [] });
    rmSync(join(root, '-Users-test', `${ID}.jsonl`));
    const s = await scan(db, { root, procs: [] });
    expect(s.missing).toBe(1);
    const [row] = listSessions(db);
    expect(row).toMatchObject({ session_id: ID, transcript_present: 0, title: 'Título IA' });
  });

  it('oculta las sesiones creadas por el resumidor', async () => {
    writeFileSync(
      join(root, '-Users-test', `${ID2}.jsonl`),
      `${JSON.stringify({ type: 'user', cwd: '/Users/test', message: { content: `${SUMMARIZER_MARKER}\nresume` } })}\n`,
    );
    const s = await scan(db, { root, procs: [] });
    expect(s.hidden).toBe(1);
    expect(listSessions(db).map((r) => r.session_id)).toEqual([ID]);
    expect(listSessions(db, { includeHidden: true })).toHaveLength(2);
  });

  it('scanOne indexa una sola sesión por id', async () => {
    expect(await scanOne(db, ID, undefined, root)).toBe(true);
    expect(await scanOne(db, ID2, undefined, root)).toBe(false);
    expect(getSession(db, ID)?.title).toBe('Título IA');
  });

  it('relee desde cero si el estado guardado es de otra versión', async () => {
    await scan(db, { root, procs: [] });
    db.prepare(`UPDATE sessions SET scan_state = json_set(scan_state, '$.v', 1)`).run();
    const s = await scan(db, { root, procs: [] });
    expect(s).toMatchObject({ parsed: 1, unchanged: 0, fullRescans: 1 });
  });
});

describe('project_alias', () => {
  it('alias por ruta > alias por nombre > nombre derivado; el scanner no los toca', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cpanel-alias-'));
    mkdirSync(join(root, 'p'));
    copyFileSync(FIXTURE, join(root, 'p', `${ID}.jsonl`));
    const db = openDb(':memory:');
    await scan(db, { root, procs: [] });
    const base = getSession(db, ID)!;
    expect(base.display_project).toBe(base.project_name);

    setAlias(db, base.project_name!, 'POR NOMBRE');
    expect(getSession(db, ID)!.display_project).toBe('POR NOMBRE');
    setAlias(db, base.cwd!, 'POR RUTA');
    expect(getSession(db, ID)!.display_project).toBe('POR RUTA');

    await scan(db, { root, procs: [], full: true });
    expect(getSession(db, ID)!.display_project).toBe('POR RUTA');
    removeAlias(db, base.cwd!);
    expect(getSession(db, ID)!.display_project).toBe('POR NOMBRE');
  });
});
