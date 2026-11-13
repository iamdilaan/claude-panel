import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applySettings, hookCommand, serialize, withOurHooks, withoutOurHooks } from '../src/install-hooks.ts';

const HOOK = join(import.meta.dirname, '..', 'src', 'cpanel-hook.ts');
const cmd = (ev: string) => hookCommand('/usr/bin/node', '/opt/cp/cpanel-hook.ts', ev as never);
const ID = '11111111-2222-3333-4444-555555555555';

const FOREIGN: Parameters<typeof withOurHooks>[0] = {
  model: 'opus',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
  },
};

describe('install-hooks', () => {
  it('añade Stop y SessionEnd sin tocar hooks ajenos', () => {
    const s = withOurHooks(structuredClone(FOREIGN), cmd);
    expect(s.hooks!.Stop).toHaveLength(2);
    expect(s.hooks!.Stop[0].hooks[0].command).toContain('afplay');
    expect(s.hooks!.Stop[1].hooks[0].command).toBe(cmd('Stop'));
    expect(s.hooks!.SessionEnd[0].hooks[0]).toEqual({ type: 'command', command: cmd('SessionEnd'), timeout: 5 });
    expect(s.hooks!.PreToolUse).toEqual(FOREIGN.hooks!.PreToolUse);
    expect(s.model).toBe('opus');
  });

  it('es idempotente', () => {
    const once = withOurHooks(structuredClone(FOREIGN), cmd);
    const twice = withOurHooks(structuredClone(once), cmd);
    expect(serialize(twice)).toBe(serialize(once));
  });

  it('sustituye una versión antigua en vez de duplicar', () => {
    const old = withOurHooks(structuredClone(FOREIGN), (ev) => `/old/node /old/cpanel-hook.ts ${ev}`);
    const s = withOurHooks(old, cmd);
    const all = s.hooks!.Stop.flatMap((g) => g.hooks).filter((h) => h.command.includes('cpanel-hook'));
    expect(all.map((h) => h.command)).toEqual([cmd('Stop')]);
  });

  it('desinstalar deja exactamente lo que había', () => {
    expect(serialize(withoutOurHooks(withOurHooks(structuredClone(FOREIGN), cmd)))).toBe(serialize(FOREIGN));
    expect(withoutOurHooks(withOurHooks({ model: 'x' }, cmd))).toEqual({ model: 'x' });
  });

  it('applySettings: diff antes de escribir, backup, y segunda pasada sin cambios', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpanel-settings-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, serialize(FOREIGN));
    const diffs: string[] = [];
    const opts = {
      settingsPath: path,
      backupDir: join(dir, 'backups'),
      transform: (s: Parameters<typeof withOurHooks>[0]) => withOurHooks(s, cmd),
      confirm: async (d: string) => {
        diffs.push(d);
        return true;
      },
    };
    const dry = await applySettings({ ...opts, dryRun: true });
    expect(dry).toMatchObject({ changed: true, written: false });
    expect(readFileSync(path, 'utf8')).toBe(serialize(FOREIGN));

    const r1 = await applySettings(opts);
    expect(r1).toMatchObject({ changed: true, written: true });
    expect(diffs[0]).toContain('+');
    expect(diffs[0]).toContain('cpanel-hook.ts SessionEnd');
    expect(readFileSync(r1.backup!, 'utf8')).toBe(serialize(FOREIGN));

    const r2 = await applySettings(opts);
    expect(r2).toMatchObject({ changed: false, written: false });
    expect(diffs).toHaveLength(1); // no se pidió confirmación la segunda vez
  });

  it('cancelar no escribe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpanel-settings-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{"a":1}\n');
    const r = await applySettings({ settingsPath: path, backupDir: dir, transform: (s) => withOurHooks(s, cmd), confirm: async () => false });
    expect(r.written).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
  });

  it('no toca un settings.json con JSON inválido', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpanel-settings-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{ roto');
    await expect(applySettings({ settingsPath: path, backupDir: dir, transform: (s) => s, confirm: async () => true })).rejects.toThrow(/no es JSON válido/);
    expect(readFileSync(path, 'utf8')).toBe('{ roto');
  });
});

describe('cpanel-hook', () => {
  const runHook = (input: object, env: Record<string, string> = {}) => {
    const home = mkdtempSync(join(tmpdir(), 'cpanel-home-'));
    mkdirSync(home, { recursive: true });
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(input),
      env: { ...process.env, CPANEL_HOME: home, CPANEL_PORT: '1', ...env },
      encoding: 'utf8',
    });
    return { ...r, home, ms: performance.now() - t0 };
  };
  const ev = { hook_event_name: 'SessionEnd', session_id: ID, transcript_path: '/x.jsonl', cwd: '/p' };

  it('sale al instante y sin efectos si CLAUDE_PANEL_SUMMARIZING está definida', () => {
    const r = runHook(ev, { CLAUDE_PANEL_SUMMARIZING: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(existsSync(join(r.home, 'queue'))).toBe(false);
  });

  it('sin daemon encola el evento, sin salida y con código 0', () => {
    writeFileSync(join(mkdtempSync(join(tmpdir(), 'x-')), 'n'), '');
    const r = runHook(ev);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    const files = readdirSync(join(r.home, 'queue'));
    expect(files).toHaveLength(1);
    const q = JSON.parse(readFileSync(join(r.home, 'queue', files[0]), 'utf8'));
    expect(q).toEqual({ hook_event_name: 'SessionEnd', session_id: ID, transcript_path: '/x.jsonl', cwd: '/p' });
    expect(r.ms).toBeLessThan(1000); // margen amplio para CI; en local se mide aparte
  });

  it('ignora entradas inválidas sin fallar', () => {
    for (const bad of [{}, { hook_event_name: 'Stop', session_id: '../../etc' }, { hook_event_name: 'PreToolUse', session_id: ID }]) {
      const r = runHook(bad);
      expect(r.status).toBe(0);
      expect(existsSync(join(r.home, 'queue'))).toBe(false);
    }
  });

  it('Stop: como mucho uno por sesión cada 60 s', () => {
    const home = mkdtempSync(join(tmpdir(), 'cpanel-home-'));
    const run = () =>
      spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ ...ev, hook_event_name: 'Stop' }),
        env: { ...process.env, CPANEL_HOME: home, CPANEL_PORT: '1' },
      });
    run();
    run();
    expect(readdirSync(join(home, 'queue'))).toHaveLength(1);
  });
});
