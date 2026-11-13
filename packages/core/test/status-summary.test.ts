import { describe, expect, it } from 'vitest';
import { decideStatuses } from '../src/liveness.ts';
import { isSecretFile, redact } from '../src/redact.ts';
import { needsSummary, summaryView } from '../src/summary-view.ts';

describe('redact', () => {
  // Valores sintéticos con forma de secreto; ninguno es real.
  const cases: [string, string][] = [
    ['clave sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA fin', 'sk-ant-api03'],
    ['token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ghp_aaaa'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
    ['ANTHROPIC_API_KEY=abc123def456ghi', 'abc123def456ghi'],
    ['export STRIPE_SECRET="sk_live_xxxxxxxxxxxxxxxxxxxx"', 'sk_live_xxx'],
    ['{"apiKey": "zzzzzzzzzzzzzz"}', 'zzzzzzzzzzzzzz'],
    ['postgres://user:hunter2pass@db.example.com/x', 'hunter2pass'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----', 'AAAA'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'dozjgNryP4J3'],
    ['password: correcthorse', 'correcthorse'],
    ['mysql -u root --password s3cr3tpass db', 's3cr3tpass'],
    ['deploy --api-key abcdef123456 --verbose', 'abcdef123456'],
  ];
  it.each(cases)('tapa %s', (input, secret) => {
    const r = redact(input);
    expect(r.text).not.toContain(secret);
    expect(r.count).toBeGreaterThan(0);
  });
  it('no toca texto normal', () => {
    const s = 'git commit -m "fix token parsing" && npm test -- --max-tokens 4096; ver https://github.com/o/r/pull/7';
    expect(redact(s)).toEqual({ text: s, count: 0 });
  });
  it('reconoce archivos secretos', () => {
    for (const f of ['/a/.env', '/a/.env.local', '/a/id_ed25519', '/a/cert.pem', '/a/credentials.json']) expect(isSecretFile(f)).toBe(true);
    for (const f of ['/a/env.ts', '/a/README.md', '/a/.envrc.example.md']) expect(isSecretFile(f)).toBe(false);
  });
});

describe('decideStatuses', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const row = (id: string, last: string, extra: Partial<{ launch_cwd: string; ended_at: number }> = {}) => ({
    session_id: id,
    launch_cwd: extra.launch_cwd ?? '/h',
    last_activity_at: last,
    ended_at: extra.ended_at ?? null,
  });
  it('proceso con sessionId: busy → active, idle → paused', () => {
    const d = decideStatuses(
      [row('a', '2026-01-01T08:00:00Z'), row('b', '2026-01-01T08:00:00Z')],
      [
        { pid: 1, sessionId: 'a', cwd: '/h', busy: true, source: 'registry' },
        { pid: 2, sessionId: 'b', cwd: '/h', busy: false, source: 'registry' },
      ],
      now,
    );
    expect(d.get('a')).toMatchObject({ status: 'active', source: 'process', pid: 1 });
    expect(d.get('b')).toMatchObject({ status: 'paused', source: 'process', pid: 2 });
  });
  it('SessionEnd posterior a la actividad gana aunque el proceso siga en el registro', () => {
    const d = decideStatuses(
      [row('a', '2026-01-01T11:59:00Z', { ended_at: Date.parse('2026-01-01T11:59:30Z') })],
      [{ pid: 1, sessionId: 'a', cwd: '/h', busy: false, source: 'registry' }],
      now,
    );
    expect(d.get('a')).toMatchObject({ status: 'closed', source: 'hook' });
  });
  it('actividad tras un SessionEnd antiguo (sesión reanudada) ya no cuenta como cerrada', () => {
    const d = decideStatuses([row('a', '2026-01-01T11:58:00Z', { ended_at: Date.parse('2026-01-01T09:00:00Z') })], [], now);
    expect(d.get('a')).toMatchObject({ status: 'active', source: 'heuristic' });
  });
  it('proceso sin registro → sesión más reciente lanzada en su cwd', () => {
    const d = decideStatuses(
      [row('old', '2026-01-01T07:00:00Z', { launch_cwd: '/p' }), row('new', '2026-01-01T10:00:00Z', { launch_cwd: '/p' })],
      [{ pid: 9, sessionId: null, cwd: '/p', busy: null, source: 'ps' }],
      now,
    );
    expect(d.get('new')).toMatchObject({ status: 'paused', source: 'process', pid: 9 });
    expect(d.get('old')).toMatchObject({ status: 'closed', source: 'heuristic' });
  });
  it('heurística de 15 minutos', () => {
    const d = decideStatuses([row('a', '2026-01-01T11:50:00Z'), row('b', '2026-01-01T11:40:00Z')], [], now);
    expect(d.get('a')?.status).toBe('active');
    expect(d.get('b')?.status).toBe('closed');
  });
});

describe('summaryView / needsSummary', () => {
  const base = {
    away_summary: null as string | null,
    away_summary_at: null as string | null,
    last_activity_at: '2026-01-01T10:00:00Z',
    summary_json: null as string | null,
    summary_source: null as 'haiku' | 'heuristic' | null,
    summary_covers_at: null as string | null,
    last_prompt: 'último',
    hidden: 0,
    transcript_present: 1,
    user_note: null,
  };
  const S = JSON.stringify({ objetivo: 'o', hecho: [], estado_actual: 'e', siguiente_paso: 's', archivos_tocados: [] });

  it('away_summary vigente: se muestra y no se pide Haiku', () => {
    const r = { ...base, away_summary: 'recap', away_summary_at: '2026-01-01T10:05:00Z' };
    expect(summaryView(r)).toEqual({ kind: 'away', text: 'recap' });
    expect(needsSummary(r)).toBe(false);
  });
  it('away_summary desfasado y sin resumen propio → «resumen antiguo» y se pide Haiku', () => {
    const r = { ...base, away_summary: 'recap', away_summary_at: '2026-01-01T09:00:00Z' };
    expect(summaryView(r)).toMatchObject({ kind: 'stale', lastPrompt: 'último' });
    expect(needsSummary(r)).toBe(true);
  });
  it('resumen Haiku vigente gana a away desfasado', () => {
    const r = { ...base, away_summary: 'recap', away_summary_at: '2026-01-01T09:00:00Z', summary_json: S, summary_source: 'haiku' as const, summary_covers_at: '2026-01-01T10:00:00Z' };
    expect(summaryView(r).kind).toBe('haiku');
    expect(needsSummary(r)).toBe(false);
  });
  it('resumen Haiku desfasado → stale con el anterior disponible', () => {
    const r = { ...base, summary_json: S, summary_source: 'haiku' as const, summary_covers_at: '2026-01-01T09:00:00Z' };
    expect(summaryView(r)).toMatchObject({ kind: 'stale', previous: { objetivo: 'o' } });
    expect(needsSummary(r)).toBe(true);
  });
  it('ocultas o sin transcript no se resumen', () => {
    expect(needsSummary({ ...base, hidden: 1 })).toBe(false);
    expect(needsSummary({ ...base, transcript_present: 0 })).toBe(false);
  });
});
