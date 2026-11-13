import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from './paths.ts';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log JSONL con rotación por tamaño (name.log → name.log.1 … .3).
 * Nunca registrar contenido de transcripts: solo ids, rutas y métricas.
 */
export function createLogger(name: string, opts: { dir?: string; echo?: boolean } = {}) {
  let dir: string | null = null;
  const file = () => {
    if (!dir) {
      dir = opts.dir ?? logsDir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return join(dir, `${name}.log`);
  };
  const rotate = (path: string) => {
    try {
      if (statSync(path).size < MAX_BYTES) return;
    } catch {
      return;
    }
    const last = `${path}.${KEEP}`;
    if (existsSync(last)) unlinkSync(last);
    for (let i = KEEP - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    renameSync(path, `${path}.1`);
  };
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
    try {
      const path = file();
      rotate(path);
      appendFileSync(path, `${line}\n`, { mode: 0o600 });
    } catch {
      // el log nunca debe tumbar el proceso
    }
    if (opts.echo) (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
    info: (m: string, f?: Record<string, unknown>) => write('info', m, f),
    warn: (m: string, f?: Record<string, unknown>) => write('warn', m, f),
    error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
  };
}

export type Logger = ReturnType<typeof createLogger>;
