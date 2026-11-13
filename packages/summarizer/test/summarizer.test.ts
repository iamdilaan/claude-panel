import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUMMARIZER_MARKER } from '@cpanel/core';
import { buildDigest } from '../src/digest.ts';
import { buildPrompt, claudeArgs, childEnv, parseModelSummary, summarizeSession } from '../src/summarize.ts';

const VALID = {
  objetivo: 'Arreglar el test',
  hecho: ['Se corrigió el parser'],
  estado_actual: 'Tests en verde',
  siguiente_paso: 'Publicar la versión',
  archivos_tocados: ['src/a.ts'],
};

function transcript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cpanel-sum-'));
  const p = join(dir, 't.jsonl');
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return p;
}

const user = (text: string, extra = {}) => ({ type: 'user', message: { content: text }, ...extra });
const asst = (content: object[]) => ({ type: 'assistant', message: { content } });

describe('buildDigest', () => {
  it('se queda con las últimas N interacciones, resume herramientas y redacta secretos', async () => {
    const lines: object[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(user(`prompt ${i}`), asst([{ type: 'text', text: `respuesta ${i}` }]));
    }
    lines.push(
      asst([
        { type: 'tool_use', name: 'Read', input: { file_path: '/p/.env' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/p/src/a.ts' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'deploy --token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      ]),
      user('', { message: { content: [{ type: 'tool_result', content: 'SECRET_KEY=topsecretvalue', is_error: false }] } }),
      user('', { message: { content: [{ type: 'tool_result', content: 'boom', is_error: true }] } }),
      user('mi clave es sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB, arréglalo'),
      user('subagente', { isSidechain: true }),
    );
    const d = await buildDigest(transcript(lines), { title: 'T', firstPrompt: 'prompt 0' }, { interactions: 10 });
    expect(d.interactions).toBe(10);
    expect(d.text).not.toContain('prompt 20\n'); // fuera de la ventana
    expect(d.text).toContain('respuesta 29');
    expect(d.text).toContain('Edit /p/src/a.ts');
    expect(d.text).toContain('error: boom');
    expect(d.text).not.toContain('topsecretvalue'); // salidas normales nunca se envían
    expect(d.text).not.toContain('ghp_aaaa');
    expect(d.text).not.toContain('sk-ant-api03-BBBB');
    expect(d.text).not.toContain('subagente');
    expect(d.redactions).toBeGreaterThanOrEqual(2);
    expect(d.filesTouched).toEqual(['/p/src/a.ts']); // .env leído pero no listado
    expect(d.lastUserPrompt).toContain('[REDACTED');
  });
});

describe('parseModelSummary', () => {
  it('acepta JSON con vallas y texto alrededor', () => {
    expect(parseModelSummary('```json\n' + JSON.stringify(VALID) + '\n```')).toEqual(VALID);
    expect(parseModelSummary('Aquí va: ' + JSON.stringify(VALID))).toEqual(VALID);
  });
  it('rechaza JSON sin las claves', () => {
    expect(() => parseModelSummary('{"objetivo":"x"}')).toThrow();
    expect(() => parseModelSummary('no hay json')).toThrow();
  });
});

describe('summarizeSession', () => {
  const row = (p: string) => ({
    transcript_path: p,
    title: 'Título',
    first_prompt: 'arregla el test',
    last_prompt: 'publica',
    display_project: 'app',
    project_name: 'app',
    cwd: '/p',
  });
  const t = () => transcript([user('arregla el test'), asst([{ type: 'text', text: 'hecho' }]), user('publica')]);

  it('el prompt empieza por la marca del resumidor', async () => {
    let seen = '';
    const r = await summarizeSession(row(t()), {
      run: async (p) => {
        seen = p;
        return JSON.stringify(VALID);
      },
    });
    expect(seen.startsWith(SUMMARIZER_MARKER)).toBe(true);
    expect(r).toMatchObject({ source: 'haiku', error: null, summary: VALID });
  });

  it('reintenta una vez si la respuesta no es válida', async () => {
    let calls = 0;
    const r = await summarizeSession(row(t()), {
      run: async () => (++calls === 1 ? 'lo siento' : JSON.stringify(VALID)),
    });
    expect(calls).toBe(2);
    expect(r.source).toBe('haiku');
  });

  it('tras dos fallos usa el heurístico', async () => {
    const r = await summarizeSession(row(t()), {
      run: async () => {
        throw new Error('sin red');
      },
    });
    expect(r.source).toBe('heuristic');
    expect(r.error).toContain('sin red');
    expect(r.summary.siguiente_paso).toContain('publica');
  });
});

describe('aislamiento del subproceso', () => {
  it('marca el entorno y desactiva hooks, herramientas y persistencia', () => {
    const prev = process.env.CLAUDECODE;
    process.env.CLAUDECODE = '1';
    const env = childEnv();
    if (prev === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = prev;
    expect(env.CLAUDE_PANEL_SUMMARIZING).toBe('1');
    expect(env.CLAUDECODE).toBeUndefined();
    const args = claudeArgs(true);
    expect(args).toContain('--no-session-persistence');
    expect(args).toEqual(expect.arrayContaining(['--model', 'haiku', '--tools', '', '--strict-mcp-config']));
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true });
    expect(claudeArgs(false)).not.toContain('--no-session-persistence');
  });

  it('buildPrompt no interpola nada antes de la marca', () => {
    expect(buildPrompt({ text: 'x', redactions: 0, interactions: 0, filesTouched: [], lastUserPrompt: null, lastAssistantText: null, compactSummary: null }).split('\n')[0]).toBe(
      SUMMARIZER_MARKER,
    );
  });
});
