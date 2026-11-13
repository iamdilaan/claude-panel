import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = join(import.meta.dirname, '..', 'src', 'cpanel.ts');

/** Entorno aislado: HOME, datos, ~/.claude y launchctl falsos. Nunca toca la instalación real. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'cpanel-home-'));
  const claude = join(home, '.claude');
  mkdirSync(join(claude, 'projects', 'p'), { recursive: true });
  writeFileSync(join(claude, 'projects', 'p', 'x.jsonl'), '{"type":"user"}\n');
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'otro-hook' }] }] } }, null, 2));
  const bin = join(home, 'Applications', 'ClaudePanel.app', 'Contents', 'MacOS');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claudepanel'), '');
  const state = join(home, 'launchctl-state');
  mkdirSync(state);
  const fake = join(home, 'launchctl');
  writeFileSync(
    fake,
    `#!/bin/sh
echo "$@" >> "${state}/calls"
case "$1" in
  print) [ -f "${state}/$(basename "$2")" ] && { echo "pid = 4242"; exit 0; } || exit 113 ;;
  bootstrap) touch "${state}/$(basename "$3" .plist)" ;;
  bootout) rm -f "${state}/$(basename "$2")" ;;
esac
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: home,
    CPANEL_HOME: join(home, '.claude-panel'),
    CPANEL_CLAUDE_HOME: claude,
    CPANEL_LAUNCH_AGENTS: join(home, 'Library', 'LaunchAgents'),
    CPANEL_LAUNCHCTL: fake,
    CPANEL_PORT: '1', // ningún daemon escucha aquí
  };
  const run = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  return { home, claude, state, run };
}

describe('instalación y desinstalación limpias', () => {
  it('install-hooks + launchd install → uninstall --purge no deja rastro y no toca projects', () => {
    const s = sandbox();
    s.run('install-hooks', '--yes');
    s.run('launchd', 'install', '--yes');
    expect(readdirSync(join(s.home, 'Library', 'LaunchAgents')).sort()).toEqual(['com.claudepanel.app.plist', 'com.claudepanel.daemon.plist']);
    expect(readFileSync(join(s.state, 'calls'), 'utf8')).toContain('bootstrap');
    // idempotente
    expect(s.run('launchd', 'install', '--yes')).toContain('nada que cambiar');

    const out = s.run('uninstall', '--purge', '--yes');
    expect(out).toContain('ClaudePanel desinstalado');
    expect(readdirSync(join(s.home, 'Library', 'LaunchAgents'))).toEqual([]);
    expect(existsSync(join(s.home, 'Applications', 'ClaudePanel.app'))).toBe(false);
    expect(existsSync(join(s.home, '.claude-panel'))).toBe(false);
    expect(readdirSync(s.state).filter((f) => f !== 'calls')).toEqual([]); // todo descargado

    // settings.json: sin nuestros hooks, con lo demás intacto, y backup junto a él
    const settings = JSON.parse(readFileSync(join(s.claude, 'settings.json'), 'utf8'));
    expect(settings).toEqual({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'otro-hook' }] }] } });
    expect(readdirSync(s.claude).some((f) => f.startsWith('settings.json.') && f.endsWith('.bak'))).toBe(true);
    // ~/.claude/projects intacto
    expect(readFileSync(join(s.claude, 'projects', 'p', 'x.jsonl'), 'utf8')).toBe('{"type":"user"}\n');

    expect(s.run('uninstall', '--yes')).toContain('No queda nada');
  });

  it('sin --purge conserva los datos', () => {
    const s = sandbox();
    s.run('launchd', 'install', '--yes');
    mkdirSync(join(s.home, '.claude-panel', 'archive'), { recursive: true });
    s.run('uninstall', '--yes');
    expect(existsSync(join(s.home, '.claude-panel', 'archive'))).toBe(true);
    expect(existsSync(join(s.home, 'Applications', 'ClaudePanel.app'))).toBe(false);
  });

  it('con settings.json roto avisa y sigue quitando launchd y la app (MISC-7)', () => {
    const s = sandbox();
    s.run('launchd', 'install', '--yes');
    writeFileSync(join(s.claude, 'settings.json'), '{ roto');

    const dry = s.run('uninstall', '--dry-run');
    expect(dry).toContain('no es JSON válido');
    expect(dry).toContain('rm -r');
    expect(dry).toContain('dry-run');

    const out = s.run('uninstall', '--yes');
    expect(out).toContain('no es JSON válido');
    expect(out).toContain('quítalos a mano');
    expect(out).toContain('ClaudePanel desinstalado');
    expect(readdirSync(join(s.home, 'Library', 'LaunchAgents'))).toEqual([]);
    expect(existsSync(join(s.home, 'Applications', 'ClaudePanel.app'))).toBe(false);
    expect(readFileSync(join(s.claude, 'settings.json'), 'utf8')).toBe('{ roto'); // intacto
  });

  it('con hooks mal formados también sigue (MISC-7)', () => {
    const s = sandbox();
    writeFileSync(join(s.claude, 'settings.json'), JSON.stringify({ hooks: { Stop: { hooks: [] } } }));
    const out = s.run('uninstall', '--yes');
    expect(out).toContain('"hooks.Stop" debería ser una lista');
    expect(out).toContain('ClaudePanel desinstalado');
    expect(existsSync(join(s.home, 'Applications', 'ClaudePanel.app'))).toBe(false);
  });
});
