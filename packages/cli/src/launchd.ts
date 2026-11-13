import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { logsDir, panelHome } from '@cpanel/core';

/**
 * Agentes de launchd (por usuario, en ~/Library/LaunchAgents; sin sudo):
 *  - com.claudepanel.daemon: el daemon, con KeepAlive y logs en ~/.claude-panel/logs.
 *  - com.claudepanel.app: la app de barra de menú al iniciar sesión. Se relanza
 *    solo si se cae (KeepAlive.SuccessfulExit = false); «Salir» la deja cerrada.
 */

export const DAEMON_LABEL = 'com.claudepanel.daemon';
export const APP_LABEL = 'com.claudepanel.app';
export const APP_BUNDLE_NAME = 'ClaudePanel.app';
export const APP_EXECUTABLE = 'claudepanel';

export const launchAgentsDir = () => process.env.CPANEL_LAUNCH_AGENTS ?? join(homedir(), 'Library', 'LaunchAgents');
export const plistPath = (label: string) => join(launchAgentsDir(), `${label}.plist`);
export const defaultAppPath = () => join(homedir(), 'Applications', APP_BUNDLE_NAME);

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

type PlistValue = string | number | boolean | string[] | { [k: string]: PlistValue };

function render(v: PlistValue, indent: string): string {
  if (typeof v === 'string') return `${indent}<string>${xml(v)}</string>`;
  if (typeof v === 'number') return `${indent}<integer>${Math.trunc(v)}</integer>`;
  if (typeof v === 'boolean') return `${indent}<${v}/>`;
  if (Array.isArray(v)) return `${indent}<array>\n${v.map((x) => render(x, `${indent}  `)).join('\n')}\n${indent}</array>`;
  const body = Object.entries(v)
    .map(([k, x]) => `${indent}  <key>${xml(k)}</key>\n${render(x, `${indent}  `)}`)
    .join('\n');
  return `${indent}<dict>\n${body}\n${indent}</dict>`;
}

export function plist(dict: { [k: string]: PlistValue }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${render(dict, '')}
</plist>
`;
}

/** PATH mínimo para launchd: node, git, claude (resumidor) y osascript. */
export function launchdPath(): string {
  return ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
}

export function daemonPlist(nodePath: string, cliScript: string): string {
  return plist({
    Label: DAEMON_LABEL,
    ProgramArguments: [nodePath, cliScript, 'daemon', '--quiet'],
    WorkingDirectory: panelHome(),
    EnvironmentVariables: { PATH: launchdPath(), LANG: 'es_ES.UTF-8' },
    RunAtLoad: true,
    KeepAlive: true,
    // si falla al arrancar (p. ej. puerto ocupado), reintenta cada 10 s, no en bucle
    ThrottleInterval: 10,
    ProcessType: 'Background',
    StandardOutPath: join(logsDir(), 'daemon.out.log'),
    StandardErrorPath: join(logsDir(), 'daemon.err.log'),
  });
}

export function appPlist(appPath: string): string {
  return plist({
    Label: APP_LABEL,
    ProgramArguments: [join(appPath, 'Contents', 'MacOS', APP_EXECUTABLE)],
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 10,
    ProcessType: 'Interactive',
    LimitLoadToSessionType: 'Aqua',
    StandardOutPath: join(logsDir(), 'app.out.log'),
    StandardErrorPath: join(logsDir(), 'app.err.log'),
  });
}

// ── launchctl ────────────────────────────────────────────────────────────────

export const guiDomain = () => `gui/${process.getuid?.() ?? 501}`;

export function launchctl(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.env.CPANEL_LAUNCHCTL ?? '/bin/launchctl', args, { timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

export interface JobState {
  loaded: boolean;
  pid: number | null;
  lastExit: string | null;
}

export async function jobState(label: string): Promise<JobState> {
  const r = await launchctl(['print', `${guiDomain()}/${label}`]);
  if (r.code !== 0) return { loaded: false, pid: null, lastExit: null };
  const pid = r.out.match(/^\s*pid = (\d+)/m);
  const exit = r.out.match(/^\s*last exit code = (.+)$/m);
  return { loaded: true, pid: pid ? Number(pid[1]) : null, lastExit: exit ? exit[1].trim() : null };
}

export async function bootout(label: string): Promise<void> {
  await launchctl(['bootout', `${guiDomain()}/${label}`]);
}

export async function bootstrap(path: string): Promise<{ code: number; out: string }> {
  return launchctl(['bootstrap', guiDomain(), path]);
}

// ── plan / aplicar ───────────────────────────────────────────────────────────

export interface AgentPlan {
  label: string;
  path: string;
  before: string | null;
  after: string | null; // null = borrar
  /** Si hay que cargarlo tras escribirlo (la app solo si existe el bundle). */
  load: boolean;
  note?: string;
}

export function readIfExists(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function planInstall(o: { nodePath: string; cliScript: string; appPath: string }): AgentPlan[] {
  const appExists = existsSync(join(o.appPath, 'Contents', 'MacOS', APP_EXECUTABLE));
  return [
    { label: DAEMON_LABEL, path: plistPath(DAEMON_LABEL), before: readIfExists(plistPath(DAEMON_LABEL)), after: daemonPlist(o.nodePath, o.cliScript), load: true },
    {
      label: APP_LABEL,
      path: plistPath(APP_LABEL),
      before: readIfExists(plistPath(APP_LABEL)),
      after: appPlist(o.appPath),
      load: appExists,
      note: appExists ? undefined : `No existe ${o.appPath}: se escribe el plist pero no se carga hasta que instales la app (npm run app:install).`,
    },
  ];
}

export function planUninstall(): AgentPlan[] {
  return [DAEMON_LABEL, APP_LABEL].map((label) => ({ label, path: plistPath(label), before: readIfExists(plistPath(label)), after: null, load: false }));
}

export function writePlist(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o644 });
  renameSync(tmp, path);
}

export function removePlist(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ya no estaba
  }
}
