// Regresiones de la auditoría de seguridad (W1): HTTP-1, HTTP-2/MISC-S2, HTTP-3.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, openDb, scan, type DB } from '@cpanel/core';
import { createApp, openUi, uiUrl } from '../src/app.ts';
import { SummaryQueue } from '../src/service.ts';

const FIXTURE = join(import.meta.dirname, '..', '..', 'core', 'test', 'fixtures', 'basic.jsonl');
const ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'c'.repeat(64);
const PORT = 7437;
const log = createLogger('test', { dir: mkdtempSync(join(tmpdir(), 'cpanel-log-')) });

let db: DB;
let ui: string;
let queue: SummaryQueue;
let calls: number;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'cpanel-sec-'));
  mkdirSync(join(root, 'proj'));
  copyFileSync(FIXTURE, join(root, 'proj', `${ID}.jsonl`));
  process.env.CPANEL_CLAUDE_PROJECTS = root;
  process.env.CPANEL_CLAUDE_HOME = mkdtempSync(join(tmpdir(), 'cpanel-ch-'));
  process.env.CPANEL_HOME = mkdtempSync(join(tmpdir(), 'cpanel-home-'));
  db = openDb(':memory:');
  await scan(db, { root, procs: false });
  ui = mkdtempSync(join(tmpdir(), 'cpanel-ui-'));
  writeFileSync(join(ui, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
  queue = new SummaryQueue(db, log);
  calls = 0;
});
afterEach(() => {
  queue.stop();
  delete process.env.CPANEL_CLAUDE_PROJECTS;
  delete process.env.CPANEL_CLAUDE_HOME;
  delete process.env.CPANEL_HOME;
});

const app = () =>
  createApp({
    db,
    log,
    queue,
    token: TOKEN,
    port: PORT,
    uiDir: ui,
    run: async () => {
      calls++;
    },
  });
const req = (path: string, headers: Record<string, string> = {}, host = `127.0.0.1:${PORT}`) =>
  app().request(`http://127.0.0.1:${PORT}${path}`, { headers: { host, ...headers } });

describe('HTTP-1: el token nunca va en una respuesta sin autenticar', () => {
  it('GET / no contiene el token', async () => {
    const r = await req('/');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain('cpanel-token');
  });
  it('ningún endpoint sin token devuelve el token', async () => {
    for (const p of ['/', '/api/health', '/api/stats', '/api/sessions', '/api/git', '/api/aliases', '/assets/x.js', '/nada']) {
      expect(await (await req(p)).text(), p).not.toContain(TOKEN);
    }
  });
  it('la URL del navegador lleva el token en el fragmento (no llega al servidor)', () => {
    const u = new URL(uiUrl(PORT, TOKEN));
    expect(u.origin).toBe(`http://127.0.0.1:${PORT}`);
    expect(u.pathname).toBe('/');
    expect(u.search).toBe('');
    expect(u.hash).toBe(`#t=${TOKEN}`);
  });
  it('`cpanel open` pasa la URL por stdin, nunca en argv (visible en ps)', async () => {
    const seen: { file: string; args: string[]; input: string }[] = [];
    const url = await openUi({ port: PORT, token: TOKEN, run: async (file, args, input) => void seen.push({ file, args, input }) });
    expect(url).toBe(`http://127.0.0.1:${PORT}/#t=${TOKEN}`);
    expect(seen).toHaveLength(1);
    expect(seen[0].file).toBe('/usr/bin/osascript');
    expect(seen[0].args.join(' ')).not.toContain(TOKEN);
    expect(seen[0].input).toBe(`open location "${url}"\n`);
  });
});

describe('HTTP-2 / MISC-S2: todo /api/* salvo /api/health exige token', () => {
  const reads = ['/api/git', '/api/sessions', '/api/sessions?archived=1', `/api/sessions/${ID}`, `/api/sessions/${ID}/prompt`, '/api/stats', '/api/aliases'];
  it.each(reads)('GET %s sin token → 401; con token → 200', async (p) => {
    for (const h of [{}, { 'x-cpanel-token': 'b'.repeat(64) }, { 'x-cpanel-token': '' }] as Record<string, string>[]) {
      const r = await req(p, h);
      expect(r.status, JSON.stringify(h)).toBe(401);
    }
    expect((await req(p, { 'x-cpanel-token': TOKEN })).status).toBe(200);
  });
  it.each(reads)('GET %s con Origin externo → 403 aunque lleve token', async (p) => {
    expect((await req(p, { 'x-cpanel-token': TOKEN, origin: 'https://evil.example' })).status).toBe(403);
  });
  it('/api/git sin token no lanza ningún git (sin efecto)', async () => {
    const r = await req('/api/git');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'token inválido' });
  });
  it('/api/health sigue abierto (lo usan la app y el CLI para saber si hay daemon)', async () => {
    expect((await req('/api/health')).status).toBe(200);
  });
  it('rutas /api desconocidas también exigen token antes del 404', async () => {
    expect((await req('/api/nada')).status).toBe(401);
  });
});

describe('HTTP-3: cabeceras de seguridad en todas las respuestas', () => {
  it.each(['/api/health', '/api/stats', '/', '/assets/no.js'])('%s', async (p) => {
    const r = await req(p);
    expect(r.headers.get('content-security-policy'), p).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-content-type-options'), p).toBe('nosniff');
  });
  it('también en el 403 por Host ajeno', async () => {
    const r = await req('/api/health', {}, 'evil.example:7437');
    expect(r.status).toBe(403);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  });
  it('el stub de Runner no se ha usado', () => {
    expect(calls).toBe(0);
  });
});
