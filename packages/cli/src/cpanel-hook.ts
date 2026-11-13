#!/usr/bin/env node
/**
 * Hook de Claude Code para Stop y SessionEnd.
 *
 * Contrato: salir rápido (<200 ms), no escribir nada en stdout/stderr y salir
 * siempre con 0, pase lo que pase: nunca debe bloquear ni alterar a Claude Code.
 * Autónomo a propósito (sin importar @cpanel/core) para arrancar en pocos ms.
 */
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync, closeSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 1. Guard anti-recursión: el resumidor lanza `claude -p` con esta variable.
if (process.env.CLAUDE_PANEL_SUMMARIZING) process.exit(0);

const HOME = process.env.CPANEL_HOME ?? join(homedir(), '.claude-panel');
const PORT = Number(process.env.CPANEL_PORT ?? 7437);
const STOP_DEBOUNCE_MS = 60_000;
const POST_TIMEOUT_MS = 150;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readStdin(maxMs = 500): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => resolve(data);
    const t = setTimeout(done, maxMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      if (data.length < 1_000_000) data += d;
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      done();
    });
  });
}

/** Stop llega en cada turno: como mucho uno por sesión cada 60 s. */
function debounced(sessionId: string): boolean {
  const dir = join(HOME, 'hook-state');
  const f = join(dir, `${sessionId}.stop`);
  const now = Date.now();
  try {
    if (now - statSync(f).mtimeMs < STOP_DEBOUNCE_MS) return true;
  } catch {
    // primera vez
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    closeSync(openSync(f, 'a', 0o600));
    utimesSync(f, now / 1000, now / 1000);
  } catch {
    // sin estado: mejor enviar de más que de menos
  }
  return false;
}

function enqueue(ev: Record<string, unknown>): void {
  const dir = join(HOME, 'queue');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${String(ev.session_id)}-${String(ev.hook_event_name)}.json`;
  writeFileSync(join(dir, name), JSON.stringify(ev), { mode: 0o600 });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : process.argv[2];
  const sessionId = input.session_id;
  if ((event !== 'Stop' && event !== 'SessionEnd') || typeof sessionId !== 'string' || !UUID.test(sessionId)) return;
  if (event === 'Stop' && debounced(sessionId)) return;

  // Solo lo necesario: nada del contenido de la conversación sale de aquí.
  const ev: Record<string, unknown> = {
    hook_event_name: event,
    session_id: sessionId,
    transcript_path: typeof input.transcript_path === 'string' ? input.transcript_path : undefined,
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    reason: typeof input.reason === 'string' ? input.reason : undefined,
  };

  let token = '';
  try {
    token = readFileSync(join(HOME, 'token'), 'utf8').trim();
  } catch {
    // sin token el daemon rechazaría: directo a la cola
  }
  if (token) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cpanel-token': token },
        body: JSON.stringify(ev),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (res.ok) return;
    } catch {
      // daemon caído o lento
    }
  }
  enqueue(ev);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
