import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const HOOK_MARK = 'cpanel-hook';
export const HOOK_EVENTS = ['Stop', 'SessionEnd'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

interface HookCmd {
  type: 'command';
  command: string;
  timeout?: number;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCmd[];
  [k: string]: unknown;
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

const q = (s: string) => (/^[\w./@:+-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

export function hookCommand(nodePath: string, scriptPath: string, event: HookEvent): string {
  return `${q(nodePath)} ${q(scriptPath)} ${event}`;
}

const isOurs = (h: HookCmd) => typeof h?.command === 'string' && h.command.includes(HOOK_MARK);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Error de forma en settings.json: nombra la clave culpable. */
export class SettingsShapeError extends Error {}

const shapeError = (key: string, want: string) =>
  new SettingsShapeError(`"${key}" debería ser ${want}; no lo toco. Corrígelo y vuelve a intentarlo.`);

/**
 * Comprueba que `hooks` tenga la forma que espera Claude Code
 * ({ Evento: [{ hooks: [{...}] }] }) antes de transformarlo, para fallar con
 * un mensaje claro en vez de un TypeError a medias.
 */
export function assertHooksShape(settings: Settings): void {
  if (!('hooks' in settings) || settings.hooks === undefined) return;
  const hooks: unknown = settings.hooks;
  if (!isObject(hooks)) throw shapeError('hooks', 'un objeto');
  for (const [ev, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw shapeError(`hooks.${ev}`, 'una lista');
    groups.forEach((g: unknown, i) => {
      if (!isObject(g)) throw shapeError(`hooks.${ev}[${i}]`, 'un objeto');
      if (g.hooks === undefined) return;
      if (!Array.isArray(g.hooks)) throw shapeError(`hooks.${ev}[${i}].hooks`, 'una lista');
      g.hooks.forEach((h: unknown, j) => {
        if (!isObject(h)) throw shapeError(`hooks.${ev}[${i}].hooks[${j}]`, 'un objeto');
      });
    });
  }
}

/** Devuelve una copia de settings sin ningún hook nuestro (los ajenos quedan intactos). */
export function withoutOurHooks(settings: Settings): Settings {
  assertHooksShape(settings);
  const s = structuredClone(settings);
  if (!s.hooks) return s;
  for (const ev of Object.keys(s.hooks)) {
    const groups = (s.hooks[ev] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (groups.length) s.hooks[ev] = groups;
    else delete s.hooks[ev];
  }
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  return s;
}

/**
 * Añade nuestros hooks. Idempotente: si ya están exactamente como toca, no
 * cambia nada (ni de sitio); si hay versiones antiguas, las sustituye.
 */
export function withOurHooks(settings: Settings, cmdFor: (ev: HookEvent) => string): Settings {
  assertHooksShape(settings);
  const already = HOOK_EVENTS.every((ev) => {
    const ours = (settings.hooks?.[ev] ?? []).flatMap((g) => g.hooks ?? []).filter(isOurs);
    return ours.length === 1 && ours[0].command === cmdFor(ev);
  });
  if (already) return structuredClone(settings);
  const s = withoutOurHooks(settings);
  s.hooks ??= {};
  for (const ev of HOOK_EVENTS) {
    (s.hooks[ev] ??= []).push({ hooks: [{ type: 'command', command: cmdFor(ev), timeout: 5 }] });
  }
  return s;
}

export const serialize = (s: Settings) => `${JSON.stringify(s, null, 2)}\n`;

export function unifiedDiff(before: string, after: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cpanel-diff-'));
  try {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    writeFileSync(a, before);
    writeFileSync(b, after);
    const r = spawnSync('diff', ['-u', '--label', `${label} (actual)`, '--label', `${label} (nuevo)`, a, b], { encoding: 'utf8' });
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ApplyOptions {
  settingsPath: string;
  backupDir: string;
  transform: (s: Settings) => Settings;
  label?: string;
  /** Pide confirmación; devuelve true para escribir. */
  confirm: (diff: string) => Promise<boolean>;
  dryRun?: boolean;
}

export interface ApplyResult {
  changed: boolean;
  written: boolean;
  diff: string;
  backup: string | null;
  /** Archivo real que se lee y escribe (distinto de settingsPath si es un enlace). */
  target: string;
}

/**
 * Si settings.json es un enlace simbólico (dotfiles), trabajamos sobre el
 * archivo real para no sustituir el enlace por una copia.
 */
function resolveTarget(p: string): string {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return p; // no existe: se creará como archivo normal
  }
  if (!st.isSymbolicLink()) return p;
  try {
    return realpathSync(p);
  } catch {
    throw new Error(`${p} es un enlace simbólico roto; no lo toco. Corrígelo y vuelve a intentarlo.`);
  }
}

const suffix = () => `${process.pid}.${randomBytes(6).toString('hex')}`;

/** Crea `path` en exclusiva (O_CREAT|O_EXCL: nunca sigue un enlace ni reutiliza un archivo) y escribe `data`. */
function writeExclusive(path: string, data: string, mode: number): void {
  const fd = openSync(path, 'wx', mode);
  try {
    fchmodSync(fd, mode); // el umask podría haber recortado el modo
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Prepara el directorio de backups: nunca a través de un enlace, y en 0700.
 * Si es el propio directorio de settings.json (uninstall --purge), no le
 * cambiamos los permisos: es de Claude Code, no nuestro.
 */
function prepareBackupDir(dir: string, settingsDir: string): void {
  if (resolve(dir) === resolve(settingsDir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`El directorio de backups ${dir} es un enlace simbólico o no es un directorio; no escribo ahí.`);
  }
  chmodSync(dir, 0o700);
}

function writeBackup(dir: string, settingsDir: string, original: string): string {
  prepareBackupDir(dir, settingsDir);
  const path = join(dir, `settings.json.${new Date().toISOString().replace(/[:.]/g, '-')}.${suffix()}.bak`);
  writeExclusive(path, original, 0o600);
  return path;
}

/** Escritura atómica: temporal único junto al destino y rename encima. */
function writeAtomic(target: string, data: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const tmp = `${target}.${suffix()}.tmp`;
  try {
    writeExclusive(tmp, data, mode);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const readOr = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/**
 * Lee settings.json, aplica la transformación, muestra el diff y, si se
 * confirma, hace backup y escribe de forma atómica. Si el archivo cambió
 * mientras tanto, aborta antes de pisarlo.
 */
export async function applySettings(o: ApplyOptions): Promise<ApplyResult> {
  const target = resolveTarget(o.settingsPath);
  const original = readOr(target);
  let current: Settings;
  try {
    current = original.trim() ? (JSON.parse(original) as Settings) : {};
  } catch {
    throw new Error(`${o.settingsPath} no es JSON válido; no lo toco. Corrígelo y vuelve a intentarlo.`);
  }
  if (!isObject(current)) throw new Error(`${o.settingsPath} no es un objeto JSON; no lo toco.`);

  let transformed: Settings;
  try {
    transformed = o.transform(current);
  } catch (e) {
    if (e instanceof SettingsShapeError) throw new Error(`${o.settingsPath}: ${e.message}`);
    throw e;
  }
  const next = serialize(transformed);
  // compara contra la serialización del actual para no reescribir por formato
  const same = next === serialize(current);
  const label = o.label ?? 'settings.json';
  const diff = same ? '' : unifiedDiff(original, next, target === o.settingsPath ? label : `${label} → ${target}`);
  if (same) return { changed: false, written: false, diff, backup: null, target };
  if (o.dryRun || !(await o.confirm(diff))) return { changed: true, written: false, diff, backup: null, target };

  if (resolveTarget(o.settingsPath) !== target || readOr(target) !== original) {
    throw new Error('settings.json ha cambiado mientras tanto; vuelve a ejecutar el comando.');
  }
  const backup = original ? writeBackup(o.backupDir, dirname(o.settingsPath), original) : null;
  writeAtomic(target, next);
  return { changed: true, written: true, diff, backup, target };
}
