import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, getSession, openDb, type DB } from '@cpanel/core';
import { createApp } from '../src/app.ts';
import { drainQueue, handleHookEvent, SummaryQueue } from '../src/service.ts';

const FIXTURE = join(import.meta.dirname, '..', '..', 'core', 'test', 'fixtures', 'basic.jsonl');
const ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'a'.repeat(64);
const PORT = 7437;
const VALID = { objetivo: 'o', hecho: ['h'], estado_actual: 'e', siguiente_paso: 's', archivos_tocados: [] };

let db: DB;
let root: string;
let queue: SummaryQueue;
let calls: number;
const log = createLogger('test', { dir: mkdtempSync(join(tmpdir(), 'cpanel-log-')) });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cpanel-d-'));
  mkdirSync(join(root, 'proj'));
  copyFileSync(FIXTURE, join(root, 'proj', `${ID}.jsonl`));
  process.env.CPANEL_CLAUDE_PROJECTS = root;
  process.env.CPANEL_CLAUDE_HOME = mkdtempSync(join(tmpdir(), 'cpanel-ch-')); // registro de procesos vacío
  db = openDb(':memory:');
  calls = 0;
  queue = new SummaryQueue(db, log, {
    deps: {
      run: async () => {
        calls++;
        return JSON.stringify(VALID);
      },
    },
  });
});
afterEach(() => {
  queue.stop();
  delete process.env.CPANEL_CLAUDE_PROJECTS;
  delete process.env.CPANEL_CLAUDE_HOME;
});

const app = () => createApp({ db, log, queue, token: TOKEN, port: PORT });
const req = (path: string, init: RequestInit & { host?: string } = {}) =>
  app().request(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers: { host: init.host ?? `127.0.0.1:${PORT}`, ...(init.headers as Record<string, string>) },
  });
const hookBody = (ev: string) => JSON.stringify({ hook_event_name: ev, session_id: ID, transcript_path: join(root, 'proj', `${ID}.jsonl`) });

describe('seguridad HTTP', () => {
  it('rechaza Host ajeno (DNS rebinding)', async () => {
    expect((await req('/api/health', { host: 'evil.example:7437' })).status).toBe(403);
    expect((await req('/api/health', { host: `localhost:${PORT}` })).status).toBe(200);
  });
  it('escrituras exigen token', async () => {
    const r = await req('/api/hook', { method: 'POST', body: hookBody('Stop'), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(401);
    const bad = await req('/api/hook', { method: 'POST', body: hookBody('Stop'), headers: { 'x-cpanel-token': 'b'.repeat(64) } });
    expect(bad.status).toBe(401);
  });
  it('escrituras con Origin externo se rechazan aunque lleven token', async () => {
    const r = await req('/api/scan', { method: 'POST', headers: { 'x-cpanel-token': TOKEN, origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
  });
  it('evento de hook inválido → 400', async () => {
    const r = await req('/api/hook', { method: 'POST', body: '{"hook_event_name":"Stop","session_id":"../x"}', headers: { 'x-cpanel-token': TOKEN } });
    expect(r.status).toBe(400);
  });
});

describe('flujo de hooks', () => {
  it('SessionEnd con away_summary vigente: indexa y cierra, sin llamar a Haiku', async () => {
    const r = await req('/api/hook', { method: 'POST', body: hookBody('SessionEnd'), headers: { 'x-cpanel-token': TOKEN } });
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 100));
    await queue.idle();
    const row = getSession(db, ID)!;
    expect(row).toMatchObject({ status: 'closed', status_source: 'hook', summary_source: null });
    expect(row.ended_at).toBeGreaterThan(0);
    expect(calls).toBe(0);
    const list = (await (await req('/api/sessions', { headers: { 'x-cpanel-token': TOKEN } })).json()) as { session_id: string; summary: { kind: string } }[];
    expect(list[0]).toMatchObject({ session_id: ID, summary: { kind: 'away' } });
  });

  it('SessionEnd con recap desfasado: resume con Haiku y cubre la última actividad', async () => {
    const p = join(root, 'proj', `${ID}.jsonl`);
    writeFileSync(
      p,
      `${readFileSync(FIXTURE, 'utf8')}${JSON.stringify({ type: 'user', cwd: '/w', timestamp: '2026-01-01T11:00:00.000Z', message: { content: 'otra cosa' } })}\n`,
    );
    await handleHookEvent({ hook_event_name: 'SessionEnd', session_id: ID, transcript_path: p }, { db, log, queue });
    await queue.idle();
    const row = getSession(db, ID)!;
    expect(row).toMatchObject({ summary_source: 'haiku', summary_covers_at: '2026-01-01T11:00:00.000Z', summary_error: null });
    expect(calls).toBe(1);
    const dto = (await (await req(`/api/sessions/${ID.slice(0, 8)}`, { headers: { 'x-cpanel-token': TOKEN } })).json()) as { summary: { kind: string } };
    expect(dto.summary.kind).toBe('haiku');
  });

  it('Stop: pausa y programa el resumen con debounce', async () => {
    const deps = { db, log, queue, stopDebounceMs: 400 };
    const p = join(root, 'proj', `${ID}.jsonl`);
    writeFileSync(p, `${JSON.stringify({ type: 'user', cwd: '/w', timestamp: '2026-01-01T11:00:00.000Z', message: { content: 'hola' } })}\n`);
    await handleHookEvent({ hook_event_name: 'Stop', session_id: ID, transcript_path: p }, deps);
    expect(getSession(db, ID)?.status).toBe('closed'); // sin proceso vivo y actividad antigua → heurística
    expect(queue.size.scheduled).toBe(1);
    expect(calls).toBe(0);
    await new Promise((res) => setTimeout(res, 600));
    await queue.idle();
    expect(getSession(db, ID)?.summary_source).toBe('haiku');
  });

  it('drainQueue procesa eventos encolados y descarta los inválidos', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpanel-q-'));
    writeFileSync(join(dir, '1.json'), hookBody('SessionEnd'));
    writeFileSync(join(dir, '2.json'), '{"basura":true}');
    const n = await drainQueue({ db, log, queue }, dir);
    expect(n).toBe(1);
    expect(getSession(db, ID)?.status).toBe('closed');
  });

  it('ignora transcript_path fuera de ~/.claude/projects y busca por id', async () => {
    await handleHookEvent({ hook_event_name: 'SessionEnd', session_id: ID, transcript_path: '/etc/passwd' }, { db, log, queue });
    expect(getSession(db, ID)?.transcript_path).toBe(join(root, 'proj', `${ID}.jsonl`));
  });
});

describe('backfillSummaries', () => {
  it('salta las sesiones activas y respeta el límite de recientes', async () => {
    const { backfillSummaries } = await import('../src/service.ts');
    const p = join(root, 'proj', `${ID}.jsonl`);
    writeFileSync(p, `${JSON.stringify({ type: 'user', cwd: '/w', timestamp: '2026-01-01T11:00:00.000Z', message: { content: 'hola' } })}\n`);
    await handleHookEvent({ hook_event_name: 'SessionEnd', session_id: ID, transcript_path: p }, { db, log, queue });
    queue.stop();
    db.prepare(`UPDATE sessions SET status = 'active', summary_json = NULL, summary_covers_at = NULL`).run();
    expect(backfillSummaries(db, queue)).toBe(0);
    db.prepare(`UPDATE sessions SET status = 'closed'`).run();
    expect(backfillSummaries(db, queue, 0)).toBe(0);
    expect(backfillSummaries(db, queue)).toBe(1);
  });
});
