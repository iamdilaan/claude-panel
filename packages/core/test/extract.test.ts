import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanPrompt,
  emptyState,
  foldRecord,
  freshAwaySummary,
  isPrUrl,
  isSummarizerSession,
  MAX_PR_LINKS,
  sessionTitle,
} from '../src/jsonl/extract.ts';
import { readJsonl } from '../src/jsonl/reader.ts';
import { SUMMARIZER_MARKER } from '../src/paths.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'basic.jsonl');

async function stateOf(path: string) {
  const st = emptyState();
  const res = await readJsonl(path, 0, (r) => foldRecord(st, r));
  return { st, res };
}

describe('cleanPrompt', () => {
  it('quita system-reminder y envoltorios de pegado', () => {
    expect(cleanPrompt('<system-reminder>x</system-reminder> hola')).toBe('hola');
    expect(cleanPrompt('<pasted_content id="a1">\ntexto\n</pasted_content id="a1">')).toBe('texto');
  });
  it('convierte comandos y bash-input', () => {
    expect(cleanPrompt('<command-name>/mcp</command-name>\n<command-message>mcp</command-message>\n<command-args></command-args>')).toBe('/mcp');
    expect(cleanPrompt('<command-name>/model</command-name><command-args>haiku</command-args>')).toBe('/model haiku');
    expect(cleanPrompt('<bash-input>ls -la</bash-input>')).toBe('! ls -la');
  });
  it('descarta lo que no escribió la persona', () => {
    for (const s of [
      '<bash-stdout>x</bash-stdout>',
      '<local-command-stdout>x</local-command-stdout>',
      '<task-notification>x</task-notification>',
      '[Request interrupted by user]',
      '<system-reminder>solo esto</system-reminder>',
      '   ',
    ]) expect(cleanPrompt(s)).toBeNull();
  });
});

describe('foldRecord sobre fixture', () => {
  it('extrae metadatos y es tolerante a basura', async () => {
    const { st, res } = await stateOf(FIXTURE);
    expect(res.badLines).toBe(1);
    expect(st.firstCwd).toBe('/Users/test');
    expect(st.cwdCounts['/Users/test/otro']).toBeUndefined(); // sidechain fuera
    expect(st.cwdCounts['/Users/test/app']).toBeGreaterThan(0);
    expect(st.entrypoint).toBe('cli');
    expect(st.userPrompts).toBe(3); // pegado, ! git status, arregla el test
    expect(st.assistantReplies).toBe(2);
    expect(st.firstPrompt).toBe('# Plan del proyecto haz cosas');
    expect(st.lastPrompt).toBe('arregla el test');
    expect(st.aiTitle).toBe('Título IA');
    expect(st.prLinks).toEqual(['https://github.com/o/app/pull/7']);
    expect(st.awaySummary).toBe('Arreglamos el test. Siguiente: publicar.');
    expect(st.startedAt).toBe('2026-01-01T10:00:00.000Z');
    // el system/informational de días después no cuenta como actividad
    expect(st.lastActivityAt).toBe('2026-01-01T10:04:00.000Z');
    expect(st.lastAnyAt).toBe('2026-01-09T00:00:00.000Z');
  });

  it('prioridad de título: custom > ai > primer prompt', () => {
    const st = emptyState();
    st.firstPrompt = 'primer prompt';
    expect(sessionTitle(st)).toBe('primer prompt');
    st.aiTitle = 'ia';
    expect(sessionTitle(st)).toBe('ia');
    st.customTitle = 'mío';
    expect(sessionTitle(st)).toBe('mío');
  });

  it('away_summary caduca si hubo conversación después', async () => {
    const { st } = await stateOf(FIXTURE);
    expect(freshAwaySummary(st)).toBe('Arreglamos el test. Siguiente: publicar.');
    foldRecord(st, {
      type: 'user',
      timestamp: '2026-01-01T11:00:00.000Z',
      message: { role: 'user', content: 'otra cosa' },
    });
    expect(freshAwaySummary(st)).toBeNull();
  });

  it('detecta sesiones del resumidor por su primer mensaje', () => {
    const st = emptyState();
    foldRecord(st, { type: 'user', message: { content: `${SUMMARIZER_MARKER}\nResume esto` } });
    expect(isSummarizerSession(st)).toBe(true);
  });
});

describe('readJsonl incremental', () => {
  it('no consume la última línea a medio escribir y retoma desde el offset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpanel-'));
    const p = join(dir, 'a.jsonl');
    const l1 = JSON.stringify({ type: 'user', message: { content: 'uno' } });
    const l2 = JSON.stringify({ type: 'user', message: { content: 'dos' } });
    writeFileSync(p, `${l1}\n${l2.slice(0, 10)}`);
    const st = emptyState();
    const r1 = await readJsonl(p, 0, (r) => foldRecord(st, r));
    expect(st.userPrompts).toBe(1);
    expect(r1.endOffset).toBe(Buffer.byteLength(l1) + 1);
    appendFileSync(p, `${l2.slice(10)}\n`);
    const r2 = await readJsonl(p, r1.endOffset, (r) => foldRecord(st, r));
    expect(st.userPrompts).toBe(2);
    expect(st.lastPrompt).toBe('dos');
    expect(r2.badLines).toBe(0);
  });

  it('maneja líneas más grandes que el buffer y UTF-8 partido entre chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpanel-'));
    const p = join(dir, 'big.jsonl');
    const big = 'ñ'.repeat(1_500_000); // ~3 MB, cruza varios chunks de 1 MiB
    writeFileSync(p, `${JSON.stringify({ type: 'user', message: { content: big } })}\n`);
    const st = emptyState();
    await readJsonl(p, 0, (r) => foldRecord(st, r));
    expect(st.userPrompts).toBe(1);
    expect(st.firstPrompt?.startsWith('ñññ')).toBe(true);
  });
});

describe('prompts recortados en el índice (R2-4)', () => {
  const KEY = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(4);
  const user = (content: string) => ({ type: 'user', timestamp: '2026-01-01T10:00:00Z', message: { content } });

  it('se redactan antes del corte de 300: no queda un trozo de clave', () => {
    const st = emptyState();
    foldRecord(st, user('x'.repeat(280) + ' ' + KEY + ' tail'));
    foldRecord(st, { type: 'last-prompt', lastPrompt: 'y'.repeat(285) + ' ' + KEY });
    expect(st.firstPrompt).not.toContain('sk-ant-api03-A');
    expect(st.firstPrompt!.length).toBeLessThanOrEqual(300);
    expect(st.lastPrompt).not.toContain('sk-ant-api03-A');
    expect(sessionTitle(st)).not.toContain('sk-ant');
  });

  it('el título (corte de 80) sale del primer prompt ya redactado', () => {
    const st = emptyState();
    foldRecord(st, user('deploy with ' + 'z'.repeat(60) + ' PASSWORD=hunter2hunter2 now'));
    expect(st.firstPrompt).toContain('PASSWORD=[REDACTED]');
    expect(sessionTitle(st)).not.toContain('hunter2');
  });
});

describe('enlaces de PR', () => {
  const GOOD = [
    'https://github.com/o/app/pull/7',
    'https://github.com/my-org/my.repo/pull/1234',
    'https://gitlab.com/grupo/sub/proyecto/-/merge_requests/42',
  ];
  const BAD = [
    'javascript:alert(document.cookie)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'http://github.com/o/app/pull/7',
    'https://evil.example/x/pull/42',
    'https://github.com.evil.example/o/app/pull/7',
    'https://user:pw@github.com/o/app/pull/7',
    'https://github.com/o/app/pull/7/../../../evil',
    'https://github.com/o/app/pull/7?x=<script>',
    'https://github.com/o/app/issues/7',
    'https://github.com/../app/pull/7',
    ' https://github.com/o/app/pull/7',
    'https://github.com/o/app/pull/7\n',
  ];

  it('isPrUrl acepta solo PRs de github.com y MRs de gitlab.com por https', () => {
    for (const u of GOOD) expect(isPrUrl(u), u).toBe(true);
    for (const u of BAD) expect(isPrUrl(u), u).toBe(false);
  });

  it('foldRecord descarta los enlaces no válidos y limita cuántos guarda', () => {
    const st = emptyState();
    for (const u of [...BAD, ...GOOD]) foldRecord(st, { type: 'pr-link', prUrl: u });
    expect(st.prLinks).toEqual(GOOD);
    for (let i = 0; i < 50; i++) foldRecord(st, { type: 'pr-link', prUrl: `https://github.com/o/app/pull/${100 + i}` });
    expect(st.prLinks).toHaveLength(MAX_PR_LINKS);
    // se queda con los más recientes (la tarjeta muestra el último)
    expect(st.prLinks.at(-1)).toBe('https://github.com/o/app/pull/149');
  });
});
