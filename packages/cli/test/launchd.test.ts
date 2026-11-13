import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_LABEL, DAEMON_LABEL, appPlist, daemonPlist, planInstall, planUninstall, plistPath, writePlist } from '../src/launchd.ts';

let agents: string;
beforeEach(() => {
  agents = mkdtempSync(join(tmpdir(), 'cpanel-la-'));
  process.env.CPANEL_LAUNCH_AGENTS = agents;
  process.env.CPANEL_HOME = mkdtempSync(join(tmpdir(), 'cpanel-h-'));
});
afterEach(() => {
  delete process.env.CPANEL_LAUNCH_AGENTS;
  delete process.env.CPANEL_HOME;
});

const lint = (content: string) => {
  const p = join(mkdtempSync(join(tmpdir(), 'cpanel-pl-')), 'x.plist');
  writeFileSync(p, content);
  return execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', p], { encoding: 'utf8' });
};

describe('plists', () => {
  it('daemon: válido para plutil, KeepAlive, logs y rutas con caracteres XML escapados', () => {
    const json = JSON.parse(lint(daemonPlist('/opt/homebrew/bin/node', "/Users/a&b/<x>/it's/cpanel.ts")));
    expect(json.Label).toBe(DAEMON_LABEL);
    expect(json.ProgramArguments).toEqual(['/opt/homebrew/bin/node', "/Users/a&b/<x>/it's/cpanel.ts", 'daemon', '--quiet']);
    expect(json.KeepAlive).toBe(true);
    expect(json.RunAtLoad).toBe(true);
    expect(json.StandardErrorPath).toBe(join(process.env.CPANEL_HOME!, 'logs', 'daemon.err.log'));
    expect(json.EnvironmentVariables.PATH).toContain('/opt/homebrew/bin');
  });

  it('app: solo se relanza si se cae, y solo en sesión gráfica', () => {
    const json = JSON.parse(lint(appPlist('/Users/test/Applications/ClaudePanel.app')));
    expect(json.Label).toBe(APP_LABEL);
    expect(json.ProgramArguments).toEqual(['/Users/test/Applications/ClaudePanel.app/Contents/MacOS/claudepanel']);
    expect(json.KeepAlive).toEqual({ SuccessfulExit: false });
    expect(json.LimitLoadToSessionType).toBe('Aqua');
  });
});

describe('plan idempotente', () => {
  const o = { nodePath: '/n', cliScript: '/c.ts', appPath: '/no/existe/ClaudePanel.app' };
  it('primera vez escribe; con lo mismo escrito, no hay cambios', () => {
    const first = planInstall(o);
    expect(first.every((p) => p.before === null && p.after)).toBe(true);
    // la app no existe: se escribe su plist pero no se carga
    expect(first.find((p) => p.label === APP_LABEL)!.load).toBe(false);
    for (const p of first) writePlist(p.path, p.after!);
    expect(planInstall(o).every((p) => p.before === p.after)).toBe(true);
    expect(plistPath(DAEMON_LABEL)).toBe(join(agents, `${DAEMON_LABEL}.plist`));
  });
  it('uninstall planea borrar ambos', () => {
    for (const p of planInstall(o)) writePlist(p.path, p.after!);
    const u = planUninstall();
    expect(u.map((p) => [p.label, p.after, p.before !== null])).toEqual([
      [DAEMON_LABEL, null, true],
      [APP_LABEL, null, true],
    ]);
  });
});
