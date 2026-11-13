// Copia el bundle compilado a ~/Applications/ClaudePanel.app (sin sudo) y, si
// launchd ya gestiona la app, la reinicia para cargar la versión nueva.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const src = join(import.meta.dirname, '..', 'src-tauri', 'target', 'release', 'bundle', 'macos', 'ClaudePanel.app');
const dest = join(homedir(), 'Applications', 'ClaudePanel.app');
if (!existsSync(src)) {
  console.error(`No existe ${src}: compila antes con npm run app:build`);
  process.exit(1);
}
mkdirSync(join(homedir(), 'Applications'), { recursive: true });
rmSync(dest, { recursive: true, force: true });
execFileSync('/usr/bin/ditto', [src, dest]);
console.log(`instalada en ${dest.replace(homedir(), '~')}`);
const uid = process.getuid();
try {
  execFileSync('/bin/launchctl', ['print', `gui/${uid}/com.claudepanel.app`], { stdio: 'ignore' });
  execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.claudepanel.app`]);
  console.log('app reiniciada vía launchd');
} catch {
  console.log('launchd aún no gestiona la app: cpanel launchd install');
}
