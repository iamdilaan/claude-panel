import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, getSession, openDb, scan, type DB } from '@cpanel/core';
import { createApp } from '../src/app.ts';
import { SummaryQueue } from '../src/service.ts';

const FIXTURE = join(import.meta.dirname, '..', '..', 'core', 'test', 'fixtures', 'basic.jsonl');
const ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'a'.repeat(64);
const PORT = 7437;
const log = createLogger('test', { dir: mkdtempSync(join(tmpdir(), 'cpanel-log-')) });

let db: DB;
let root: string;
let work: string;
let ui: string;
let calls: { file: string; args: string[] }[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cpanel-p3-'));
  mkdirSync(join(root, 'proj'));
  copyFileSync(FIXTURE, join(root, 'proj', `${ID}.jsonl`));
  process.env.CPANEL_CLAUDE_PROJECTS = root;
  process.env.CPANEL_CLAUDE_HOME = mkdtempSync(join(tmpdir(), 'cpanel-ch-'));
  process.env.CPANEL_HOME = mkdtempSync(join(tmpdir(), 'cpanel-home-'));
  db = openDb(':memory:');
  await scan(db, { root, procs: false });
  work = mkdtempSync(join(tmpdir(), "cpanel-work it's-"));
  db.prepare('UPDATE sessions SET cwd = ?, launch_cwd = ?').run(work, work);
  ui = mkdtempSync(join(tmpdir(), 'cpanel-ui-'));
  mkdirSync(join(ui, 'assets'));
  writeFileSync(join(ui, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
  writeFileSync(join(ui, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(root, 'secret.txt'), 'NO');
  calls = [];
});
afterEach(() => {
  delete process.env.CPANEL_CLAUDE_PROJECTS;
  delete process.env.CPANEL_CLAUDE_HOME;
  delete process.env.CPANEL_HOME;
});

const app = () =>
  createApp({
    db,
    log,
    queue: new SummaryQueue(db, log),
    token: TOKEN,
    port: PORT,
    uiDir: ui,
    run: async (file, args) => {
      calls.push({ file, args });
    },
  });
const req = (path: string, init: RequestInit & { host?: string } = {}) =>
  app().request(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers: { host: init.host ?? `127.0.0.1:${PORT}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
const launch = (mode: string, headers: Record<string, string> = { 'x-cpanel-token': TOKEN }, extra = {}) =>
  req(`/api/sessions/${ID}/launch`, { method: 'POST', body: JSON.stringify({ mode, ...extra }), headers });

describe('token en endpoints que lanzan procesos', () => {
  const endpoints: [string, string, string?][] = [
    ['POST', `/api/sessions/${ID}/launch`, '{"mode":"continue"}'],
    ['POST', `/api/sessions/${ID}/launch`, '{"mode":"resume"}'],
    ['POST', `/api/sessions/${ID}/reveal`],
    ['POST', `/api/sessions/${ID}/summarize`],
    ['POST', '/api/scan'],
    ['PATCH', `/api/sessions/${ID}`, '{"pinned":true}'],
    ['DELETE', `/api/sessions/${ID}`],
  ];
  it.each(endpoints)('%s %s: sin token 401, token erróneo 401, de otra longitud 401', async (method, path, body) => {
    for (const headers of [{}, { 'x-cpanel-token': 'b'.repeat(64) }, { 'x-cpanel-token': 'a'.repeat(63) }, { 'x-cpanel-token': '' }]) {
      const r = await req(path, { method, body, headers: headers as Record<string, string> });
      expect(r.status).toBe(401);
    }
    expect(calls).toEqual([]);
    expect(getSession(db, ID)).toBeTruthy();
  });
  it.each(endpoints)('%s %s: Origin externo 403 aunque lleve token', async (method, path, body) => {
    const r = await req(path, { method, body, headers: { 'x-cpanel-token': TOKEN, origin: 'http://evil.example' } });
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
  });
  it('Host ajeno (DNS rebinding) 403 incluso con token', async () => {
    const r2 = await req(`/api/sessions/${ID}/launch`, {
      method: 'POST',
      body: '{"mode":"continue"}',
      host: 'evil.example:7437',
      headers: { 'x-cpanel-token': TOKEN },
    });
    expect(r2.status).toBe(403);
    expect(calls).toEqual([]);
  });
  it('el token del propio origen sí funciona', async () => {
    const r = await launch('continue', { 'x-cpanel-token': TOKEN, origin: `http://localhost:${PORT}` });
    expect(r.status).toBe(200);
  });
});

describe('lanzador vía API', () => {
  it('continue: escribe el prompt 0600 y llama a osascript con el comando en argv', async () => {
    const r = await launch('continue');
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('/usr/bin/osascript');
    const cmd = calls[0].args.at(-1)!;
    const promptPath = join(process.env.CPANEL_HOME!, 'launch', `${ID}.md`);
    expect(cmd).toBe(`printf '\\033]0;%s\\007' 'ClaudePanel: Título IA' && cd '${work.replace(/'/g, `'\\''`)}' && claude "$(cat '${promptPath}')"`);
    const prompt = readFileSync(promptPath, 'utf8');
    expect(prompt.startsWith('Retomamos una sesión anterior.')).toBe(true);
    // nada del transcript en el script ni en el comando
    expect(calls[0].args.join('\n')).not.toContain('Retomamos');
  });

  it('resume: usa launch_cwd y el id', async () => {
    const r = await launch('resume');
    expect(r.status).toBe(200);
    expect(calls[0].args.at(-1)).toBe(`printf '\\033]0;%s\\007' 'ClaudePanel: Título IA' && cd '${work.replace(/'/g, `'\\''`)}' && claude --resume ${ID}`);
  });

  it('resume en sesión Desktop: 409 con aviso y sin lanzar', async () => {
    db.prepare("UPDATE sessions SET entrypoint = 'claude-desktop'").run();
    const r = await launch('resume');
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe('resume-blocked');
    expect(calls).toEqual([]);
    const dto = (await (await req(`/api/sessions/${ID}`, { headers: { 'x-cpanel-token': TOKEN } })).json()) as { resume_blocked: string };
    expect(dto.resume_blocked).toMatch(/Desktop/);
  });

  it('resume de una sesión abierta en otro proceso pide confirmación (force)', async () => {
    db.prepare("UPDATE sessions SET status = 'active', status_source = 'process'").run();
    expect((await launch('resume')).status).toBe(409);
    expect((await launch('resume', undefined, { force: true })).status).toBe(200);
  });

  it('también si está en pausa pero con proceso vivo; no si la heurística la marcó', async () => {
    db.prepare("UPDATE sessions SET status = 'paused', status_source = 'process'").run();
    expect((await launch('resume')).status).toBe(409);
    db.prepare("UPDATE sessions SET status = 'paused', status_source = 'hook'").run();
    expect((await launch('resume')).status).toBe(200);
  });

  it('directorio desaparecido: 409', async () => {
    db.prepare("UPDATE sessions SET cwd = '/no/existe', launch_cwd = '/no/existe'").run();
    expect((await launch('continue')).status).toBe(409);
    expect((await launch('resume')).status).toBe(409);
    expect(calls).toEqual([]);
  });

  it('modo inválido o campos extra: 400', async () => {
    expect((await launch('rm -rf')).status).toBe(400);
    expect((await launch('continue', undefined, { cmd: 'x' })).status).toBe(400);
  });

  it('id no UUID ni prefijo: 404', async () => {
    const r = await req('/api/sessions/..%2F..%2Fetc/launch', { method: 'POST', body: '{"mode":"resume"}', headers: { 'x-cpanel-token': TOKEN } });
    expect(r.status).toBe(404);
  });
});

describe('edición y borrado', () => {
  it('PATCH guarda nota, fijado y archivado', async () => {
    const r = await req(`/api/sessions/${ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ user_note: '  probar en staging  ', pinned: true, archived: true }),
      headers: { 'x-cpanel-token': TOKEN },
    });
    expect(r.status).toBe(200);
    expect(getSession(db, ID)).toMatchObject({ user_note: 'probar en staging', pinned: 1, archived: 1 });
    expect(((await (await req('/api/sessions', { headers: { 'x-cpanel-token': TOKEN } })).json()) as unknown[]).length).toBe(0);
    expect(((await (await req('/api/sessions?archived=1', { headers: { 'x-cpanel-token': TOKEN } })).json()) as unknown[]).length).toBe(1);
    await req(`/api/sessions/${ID}`, { method: 'PATCH', body: '{"user_note":""}', headers: { 'x-cpanel-token': TOKEN } });
    expect(getSession(db, ID)?.user_note).toBeNull();
  });

  it('DELETE quita la sesión y el scanner no la reindexa', async () => {
    expect((await req(`/api/sessions/${ID}`, { method: 'DELETE', headers: { 'x-cpanel-token': TOKEN } })).status).toBe(200);
    expect(getSession(db, ID)).toBeUndefined();
    const stats = await scan(db, { root, procs: false, full: true });
    expect(stats.deleted).toBe(1);
    expect(getSession(db, ID)).toBeUndefined();
    // el transcript sigue intacto
    expect(readFileSync(join(root, 'proj', `${ID}.jsonl`), 'utf8')).toBe(readFileSync(FIXTURE, 'utf8'));
  });
});

describe('UI estática', () => {
  it('no lleva el token y pone cabeceras de seguridad', async () => {
    const r = await req('/');
    const html = await r.text();
    expect(html).not.toContain(TOKEN);
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
  it('sirve assets y bloquea path traversal', async () => {
    expect((await req('/assets/app.js')).status).toBe(200);
    for (const p of ['/assets/../../secret.txt', '/assets/..%2f..%2fsecret.txt', '/assets/%2e%2e/index.html']) {
      const r = await req(p);
      expect(r.status, p).toBe(404);
    }
  });
  it('la página no se sirve con Host ajeno (el token no se filtra)', async () => {
    const r = await req('/', { host: 'evil.example:7437' });
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain(TOKEN);
  });
});

describe('stats para el icono', () => {
  it('cuenta por estado (con token, como la app)', async () => {
    db.prepare("UPDATE sessions SET status = 'active'").run();
    expect((await req('/api/stats')).status).toBe(401);
    expect(await (await req('/api/stats', { headers: { 'x-cpanel-token': TOKEN } })).json()).toEqual({ active: 1, paused: 0, closed: 0 });
  });
});
