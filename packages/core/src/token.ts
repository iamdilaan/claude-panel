import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tokenPath } from './paths.ts';

/** Token local (0600) que exigen los endpoints que escriben o lanzan procesos. */
export function ensureToken(path = tokenPath()): string {
  try {
    const t = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch {
    // no existe todavía
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const t = randomBytes(32).toString('hex');
  writeFileSync(path, `${t}\n`, { mode: 0o600 });
  return t;
}

export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
