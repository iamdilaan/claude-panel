import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applySettings, hookCommand, serialize, withOurHooks, withoutOurHooks } from '../src/install-hooks.ts';

// Regresiones de seguridad de la auditoría (MISC-2, MISC-3, MISC-4, MISC-7).

const cmd = (ev: string) => hookCommand('/usr/bin/node', '/opt/cp/cpanel-hook.ts', ev as never);
const mode = (p: string) => statSync(p).mode & 0o777;

function sandbox() {
  const d = mkdtempSync(join(tmpdir(), 'cpanel-safety-'));
  const claude = join(d, 'claude');
  mkdirSync(claude);
  const settingsPath = join(claude, 'settings.json');
  const backupDir = join(d, 'panel', 'backups');
  const opts = (extra = {}) => ({
    settingsPath,
    backupDir,
    transform: (s: Parameters<typeof withOurHooks>[0]) => withOurHooks(s, cmd),
    confirm: async () => true,
    ...extra,
  });
  return { d, claude, settingsPath, backupDir, opts };
}

afterEach(() => vi.useRealTimers());

describe('MISC-2: archivo temporal', () => {
  it('no sigue un symlink plantado en el nombre temporal antiguo', async () => {
    const s = sandbox();
    writeFileSync(s.settingsPath, JSON.stringify({ model: 'opus' }));
    const victim = join(s.d, 'victim.txt');
    writeFileSync(victim, 'ORIGINAL');
    symlinkSync(victim, `${s.settingsPath}.cpanel-tmp`);
    await applySettings(s.opts());
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL');
    expect(lstatSync(s.settingsPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(s.settingsPath, 'utf8')).toContain('cpanel-hook');
  });

  it('conserva el modo 0600 aunque haya un temporal viejo con 0644', async () => {
    const s = sandbox();
    writeFileSync(s.settingsPath, JSON.stringify({ model: 'opus' }), { mode: 0o600 });
    writeFileSync(`${s.settingsPath}.cpanel-tmp`, 'stale', { mode: 0o644 });
    await applySettings(s.opts());
    expect(mode(s.settingsPath)).toBe(0o600);
  });

  it('no deja temporales detrás', async () => {
    const s = sandbox();
    writeFileSync(s.settingsPath, '{}');
    await applySettings(s.opts());
    expect(readdirSync(s.claude)).toEqual(['settings.json']);
  });
});

describe('MISC-3: backups', () => {
  it('nombre impredecible: un symlink plantado en el nombre previsible no se sigue', async () => {
    const s = sandbox();
    writeFileSync(s.settingsPath, JSON.stringify({ model: 'opus', secretish: 'x' }));
    const fixed = new Date('2030-01-02T03:04:05.678Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fixed);
    mkdirSync(s.backupDir, { recursive: true });
    const victim = join(s.d, 'victim2.txt');
    writeFileSync(victim, 'VICTIM2', { mode: 0o644 });
    const predicted = join(s.backupDir, `settings.json.${fixed.toISOString().replace(/[:.]/g, '-')}.bak`);
    symlinkSync(victim, predicted);
    const r = await applySettings(s.opts());
    expect(r.backup).not.toBe(predicted);
    expect(readFileSync(victim, 'utf8')).toBe('VICTIM2');
    expect(mode(victim)).toBe(0o644);
    expect(readFileSync(r.backup!, 'utf8')).toBe(JSON.stringify({ model: 'opus', secretish: 'x' }));
    expect(lstatSync(r.backup!).isFile()).toBe(true);
    expect(mode(r.backup!)).toBe(0o600);
  });

  it('el directorio de backups queda en 0700 aunque existiera con 0755', async () => {
    const s = sandbox();
    writeFileSync(s.settingsPath, '{}');
    mkdirSync(s.backupDir, { recursive: true, mode: 0o755 });
    chmodSync(s.backupDir, 0o755);
    await applySettings(s.opts());
    expect(mode(s.backupDir)).toBe(0o700);
  });

  it('rechaza un directorio de backups que es un symlink', async () => {
    const s = sandbox();
    writeFileSync(s.settingsPath, '{}');
    const elsewhere = join(s.d, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o755 });
    mkdirSync(join(s.d, 'panel'));
    symlinkSync(elsewhere, s.backupDir);
    await expect(applySettings(s.opts())).rejects.toThrow(/backups.*enlace simbólico/);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(mode(elsewhere)).toBe(0o755);
    expect(readFileSync(s.settingsPath, 'utf8')).toBe('{}');
  });

  it('dos backups en el mismo milisegundo no se pisan', async () => {
    const s = sandbox();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-02T03:04:05.678Z'));
    writeFileSync(s.settingsPath, '{"a":1}');
    const r1 = await applySettings(s.opts());
    const r2 = await applySettings(s.opts({ transform: withoutOurHooks }));
    expect(r1.backup).not.toBe(r2.backup);
    expect(readFileSync(r1.backup!, 'utf8')).toBe('{"a":1}');
  });

  it('si el backup va en el directorio de settings.json, no le cambia los permisos', async () => {
    const s = sandbox();
    writeFileSync(s.settingsPath, '{}');
    chmodSync(s.claude, 0o755);
    const r = await applySettings(s.opts({ backupDir: s.claude }));
    expect(mode(s.claude)).toBe(0o755);
    expect(mode(r.backup!)).toBe(0o600);
  });
});

describe('MISC-4: settings.json enlazado', () => {
  it('escribe en el destino real y conserva el enlace', async () => {
    const s = sandbox();
    mkdirSync(join(s.d, 'dotfiles'));
    const target = join(s.d, 'dotfiles', 'settings.json');
    writeFileSync(target, JSON.stringify({ model: 'opus' }));
    chmodSync(target, 0o644);
    symlinkSync(target, s.settingsPath);
    const diffs: string[] = [];
    const r = await applySettings(s.opts({ confirm: async (d: string) => (diffs.push(d), true) }));
    expect(r.written).toBe(true);
    expect(lstatSync(s.settingsPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('cpanel-hook');
    expect(mode(target)).toBe(0o644);
    expect(r.target).toBe(realpathSync(target));
    expect(diffs[0]).toContain(realpathSync(target)); // el usuario ve a qué archivo real se escribe
    expect(readdirSync(join(s.d, 'dotfiles'))).toEqual(['settings.json']);
  });

  it('un enlace roto se rechaza con un mensaje claro', async () => {
    const s = sandbox();
    symlinkSync(join(s.d, 'no-existe.json'), s.settingsPath);
    await expect(applySettings(s.opts())).rejects.toThrow(/enlace simbólico roto/);
  });
});

describe('MISC-7: forma de hooks', () => {
  const shapes: Record<string, [unknown, RegExp]> = {
    hooks_string: [{ hooks: 'oops' }, /"hooks" debería ser un objeto/],
    hooks_null: [{ hooks: null }, /"hooks" debería ser un objeto/],
    hooks_array: [{ hooks: [] }, /"hooks" debería ser un objeto/],
    stop_object: [{ hooks: { Stop: { hooks: [] } } }, /"hooks\.Stop" debería ser una lista/],
    group_null: [{ hooks: { Stop: [null] } }, /"hooks\.Stop\[0\]" debería ser un objeto/],
    group_hooks_string: [{ hooks: { Stop: [{ hooks: 'x' }] } }, /"hooks\.Stop\[0\]\.hooks" debería ser una lista/],
    hook_null: [{ hooks: { Stop: [{ hooks: [null] }] } }, /"hooks\.Stop\[0\]\.hooks\[0\]" debería ser un objeto/],
  };
  for (const [name, [value, msg]] of Object.entries(shapes)) {
    it(`${name}: error claro al instalar y al desinstalar`, () => {
      expect(() => withOurHooks(structuredClone(value) as never, cmd)).toThrow(msg);
      expect(() => withoutOurHooks(structuredClone(value) as never)).toThrow(msg);
    });
  }

  it('applySettings no escribe nada y nombra el archivo', async () => {
    const s = sandbox();
    writeFileSync(s.settingsPath, JSON.stringify({ hooks: { Stop: { hooks: [] } } }));
    await expect(applySettings(s.opts())).rejects.toThrow(/settings\.json.*"hooks\.Stop" debería ser una lista/);
    expect(readdirSync(s.claude)).toEqual(['settings.json']);
  });

  it('hooks bien formados siguen funcionando', () => {
    const ok = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'x' }] }] } };
    expect(serialize(withoutOurHooks(withOurHooks(structuredClone(ok) as never, cmd)))).toBe(serialize(ok as never));
  });
});
