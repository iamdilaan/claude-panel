import { homedir } from 'node:os';
import { join } from 'node:path';

/** Raíz de datos de ClaudePanel. CPANEL_HOME permite aislar tests. */
export function panelHome(): string {
  return process.env.CPANEL_HOME ?? join(homedir(), '.claude-panel');
}

export function claudeHome(): string {
  return process.env.CPANEL_CLAUDE_HOME ?? join(homedir(), '.claude');
}

/** Raíz de transcripts de Claude Code (solo lectura). */
export function claudeProjectsDir(): string {
  return process.env.CPANEL_CLAUDE_PROJECTS ?? join(claudeHome(), 'projects');
}

/** Registro de procesos vivos de Claude Code: <pid>.json (solo lectura). */
export function claudeSessionsDir(): string {
  return join(claudeHome(), 'sessions');
}

export function claudeSettingsPath(): string {
  return join(claudeHome(), 'settings.json');
}

export const dbPath = () => join(panelHome(), 'sessions.db');
export const tokenPath = () => join(panelHome(), 'token');
export const queueDir = () => join(panelHome(), 'queue');
export const logsDir = () => join(panelHome(), 'logs');
export const backupsDir = () => join(panelHome(), 'backups');
export const hookStateDir = () => join(panelHome(), 'hook-state');
/** Directorio vacío donde se ejecuta `claude -p`: sin CLAUDE.md de proyecto. */
/** Prompts de «Continuar con resumen» (0600). */
export const launchDir = () => join(panelHome(), 'launch');
/** Copia local, filtrada y redactada, de cada transcript (<id>.txt.gz, 0600). */
export const archiveDir = () => join(panelHome(), 'archive');
export const configPath = () => join(panelHome(), 'config.json');
export const summarizerWorkDir = () => join(panelHome(), 'work');

export const DAEMON_HOST = '127.0.0.1';
export function daemonPort(): number {
  return Number(process.env.CPANEL_PORT ?? 7437);
}

/**
 * Marca que encabeza el prompt del resumidor. Cualquier sesión cuyo primer
 * mensaje de usuario empiece así se ignora en el scanner.
 */
export const SUMMARIZER_MARKER = '[[claude-panel:summarizer]]';
/** Variable de entorno del subproceso resumidor: cpanel-hook sale al verla. */
export const SUMMARIZING_ENV = 'CLAUDE_PANEL_SUMMARIZING';
