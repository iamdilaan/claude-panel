import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArchiveText } from '../src/archive.ts';
import { buildDigest, digestFromArchive } from '../src/digest.ts';

// clave falsa: 13 de prefijo + 72 de cuerpo
const KEY_BODY = 'Zq9Xw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0EdCbA';
const ANTH = `sk-ant-api03-${KEY_BODY}${KEY_BODY}`;
const ts = '2026-01-01T10:00:00Z';
const user = (content: unknown) => ({ type: 'user', timestamp: ts, cwd: '/tmp/x', message: { content } });
const asst = (content: object[]) => ({ type: 'assistant', timestamp: ts, cwd: '/tmp/x', message: { content } });
const META = {
  session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', title: 'T', display_project: null, project_name: null,
  cwd: null, launch_cwd: null, started_at: null, last_activity_at: null, entrypoint: null,
} as never;

function transcript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cpanel-redact-order-'));
  const p = join(dir, 't.jsonl');
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return p;
}

/** Ningún trozo de la clave (prefijo + algo del cuerpo) sobrevive al corte. */
const noPartialKey = (s: string | null | undefined) => {
  expect(s ?? '').not.toContain('sk-ant-api03-Z');
  expect(s ?? '').not.toContain(KEY_BODY.slice(0, 6));
};

describe('se redacta antes de recortar', () => {
  it('digest: clave partida por el corte de 1200 del mensaje de usuario', async () => {
    const p = transcript([user('x'.repeat(1180) + ' ' + ANTH + ' tail'), asst([{ type: 'text', text: 'ok' }])]);
    const d = await buildDigest(p, {});
    noPartialKey(d.text);
    noPartialKey(d.lastUserPrompt);
    expect(d.text).toContain('[REDACTED:'); // el marcador puede quedar cortado; la clave no
    expect(d.redactions).toBeGreaterThanOrEqual(1);
  });

  it('digest: clave partida por el corte de 700 de la respuesta y el de 300 de lastAssistantText', async () => {
    const p = transcript([user('go'), asst([{ type: 'text', text: 'y'.repeat(280) + ' ' + ANTH + ' ' + 'z'.repeat(400) + ' ' + ANTH }])]);
    const d = await buildDigest(p, {});
    noPartialKey(d.text);
    noPartialKey(d.lastAssistantText);
  });

  it('digest: comando Bash partido por el corte de 160', async () => {
    const p = transcript([
      user('go'),
      asst([{ type: 'tool_use', name: 'Bash', input: { command: 'echo ' + 'y'.repeat(135) + ' ' + ANTH } }]),
      asst([{ type: 'text', text: 'done' }]),
    ]);
    const d = await buildDigest(p, {});
    expect(d.text).toContain('Bash:');
    noPartialKey(d.text);
  });

  it('digest: error de herramienta partido por el corte de 200', async () => {
    const p = transcript([
      user('go'),
      { type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', is_error: true, content: 'e'.repeat(180) + ' ' + ANTH }] } },
      asst([{ type: 'text', text: 'done' }]),
    ]);
    const d = await buildDigest(p, {});
    expect(d.text).toContain('error:');
    noPartialKey(d.text);
  });

  it('digest: primer mensaje partido por el corte de 1500', async () => {
    const p = transcript([user('go'), asst([{ type: 'text', text: 'ok' }])]);
    const d = await buildDigest(p, { firstPrompt: 'f'.repeat(1480) + ' ' + ANTH });
    noPartialKey(d.text);
  });

  it('digestFromArchive: líneas y primer mensaje recortados después de redactar', () => {
    const archive = `# cabecera\n\nUSUARIO: ${'u'.repeat(280)} ${ANTH}\nCLAUDE: ${'c'.repeat(280)} ${ANTH}\n`;
    const d = digestFromArchive(archive, { firstPrompt: 'f'.repeat(1480) + ' ' + ANTH });
    noPartialKey(d.text);
    noPartialKey(d.lastUserPrompt);
    noPartialKey(d.lastAssistantText);
  });

  it('archivo: mensaje partido por el tope de 20 000 caracteres', async () => {
    const p = transcript([user('x'.repeat(19_980) + ' ' + ANTH), asst([{ type: 'text', text: 'ok' }])]);
    const { text, redactions } = await buildArchiveText(p, META);
    noPartialKey(text);
    expect(redactions).toBeGreaterThanOrEqual(1);
  });

  it('archivo: resumen de compactación partido por el tope', async () => {
    const p = transcript([
      { type: 'user', isCompactSummary: true, timestamp: ts, message: { content: 'p'.repeat(19_980) + ' ' + ANTH } },
      user('go'),
    ]);
    const { text } = await buildArchiveText(p, META);
    expect(text).toContain('[resumen de compactación]');
    noPartialKey(text);
  });
});

describe('compactSummary', () => {
  it('sale redactado, igual que text', async () => {
    const p = transcript([
      { type: 'user', isCompactSummary: true, timestamp: ts, message: { content: 'prior: ' + ANTH } },
      user('go'),
      asst([{ type: 'text', text: 'ok' }]),
    ]);
    const d = await buildDigest(p, {});
    expect(d.compactSummary).toContain('[REDACTED:anthropic-key]');
    expect(d.compactSummary).not.toContain(KEY_BODY);
    expect(d.text).not.toContain(KEY_BODY);
  });
});

describe('redactar antes de recortar no bloquea el daemon (R2-2)', () => {
  it('un error de herramienta de 120 KB adversarial se digiere en menos de 200 ms', async () => {
    const p = transcript([
      user('run the build'),
      asst([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat data.txt; false' } }]),
      user([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'a.'.repeat(60_000) }]),
      asst([{ type: 'text', text: 'failed' }]),
    ]);
    const t = performance.now();
    const d = await buildDigest(p, {});
    expect(performance.now() - t).toBeLessThan(200);
    expect(d.text).toContain('error:');
  });

  it('archivo: un mensaje de 200 KB adversarial no tarda segundos', async () => {
    const p = transcript([user('secret ' + 'a.'.repeat(100_000)), asst([{ type: 'text', text: 'ok' }])]);
    const t = performance.now();
    await buildArchiveText(p, META);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
