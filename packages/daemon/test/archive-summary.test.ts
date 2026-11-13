import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, getSession, openDb, scan } from '@cpanel/core';
import { archiveSession } from '@cpanel/summarizer';
import { SummaryQueue } from '../src/service.ts';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const VALID = { objetivo: 'o', hecho: ['h'], estado_actual: 'e', siguiente_paso: 's', archivos_tocados: [] };
const log = createLogger('test', { dir: mkdtempSync(join(tmpdir(), 'cpanel-log-')) });

describe('resumen desde la copia local', () => {
  it('si Claude Code borró el transcript, «Regenerar» usa el archivo y no filtra secretos', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cpanel-p5-'));
    mkdirSync(join(root, 'proj'));
    const p = join(root, 'proj', `${ID}.jsonl`);
    const rec = (type: string, content: unknown) => JSON.stringify({ type, cwd: '/Users/test/app', timestamp: '2026-01-01T10:00:00Z', message: { content } });
    writeFileSync(
      p,
      [
        rec('user', `Arregla el login con la clave sk-ant-api03-${'Z'.repeat(40)}`),
        rec('assistant', [{ type: 'text', text: 'Hecho; falta el test.' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/Users/test/app/src/login.ts' } }]),
      ].join('\n') + '\n',
    );
    const db = openDb(':memory:');
    await scan(db, { root, procs: false });
    const arch = join(mkdtempSync(join(tmpdir(), 'cpanel-a-')), 'archive');
    await archiveSession(db, getSession(db, ID)!, arch);

    rmSync(p);
    await scan(db, { root, procs: false });
    expect(getSession(db, ID)!.transcript_present).toBe(0);

    const prompts: string[] = [];
    const queue = new SummaryQueue(db, log, { archiveDir: arch, deps: { run: async (pr) => (prompts.push(pr), JSON.stringify(VALID)) } });
    queue.enqueue(ID, 'high'); // sin force: no hace nada
    await queue.idle();
    expect(prompts).toHaveLength(0);

    queue.enqueue(ID, 'high', true);
    await queue.idle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('copia local');
    expect(prompts[0]).toContain('USUARIO: Arregla el login');
    expect(prompts[0]).not.toContain('Z'.repeat(40));
    expect(getSession(db, ID)!.summary_source).toBe('haiku');
  });
});
