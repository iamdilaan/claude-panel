import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

export const NO_PROJECT = 'Sin proyecto';

export type ProjectKind = 'git' | 'title' | 'dir' | 'none';

export interface ProjectInfo {
  /** Directorio principal de trabajo (raíz git si la hay). */
  projectCwd: string;
  isGitRoot: boolean;
}

/** Busca hacia arriba un `.git` (directorio o archivo de worktree), sin pasar de $HOME. */
export function makeGitRootFinder(home = homedir()): (dir: string) => string | null {
  const cache = new Map<string, string | null>();
  const find = (dir: string): string | null => {
    if (cache.has(dir)) return cache.get(dir)!;
    let res: string | null = null;
    if (existsSync(join(dir, '.git'))) res = dir;
    else if (dir !== home && dir !== dirname(dir) && dir.startsWith(home + sep)) res = find(dirname(dir));
    cache.set(dir, res);
    return res;
  };
  return find;
}

/**
 * Elige el directorio con más trabajo de una sesión:
 *  - cada cwd se agrupa en su raíz git si existe; si no, cuenta tal cual;
 *  - lo que hay bajo node_modules se agrupa en el directorio que lo contiene;
 *  - ~/.claude/** y $HOME se ignoran salvo que no haya nada más.
 */
export function pickProject(
  cwdCounts: Record<string, number>,
  fallbackCwd: string | null,
  gitRoot: (dir: string) => string | null,
  home = homedir(),
): ProjectInfo | null {
  const claudeDir = join(home, '.claude');
  const totals = new Map<string, { n: number; git: boolean }>();
  for (const [raw, n] of Object.entries(cwdCounts)) {
    if (raw === claudeDir || raw.startsWith(claudeDir + sep)) continue;
    let dir = raw;
    const nm = dir.indexOf(`${sep}node_modules`);
    if (nm !== -1) dir = dir.slice(0, nm) || sep;
    const root = gitRoot(dir);
    dir = root ?? dir;
    if (dir === home) continue;
    const t = totals.get(dir) ?? { n: 0, git: root !== null };
    t.n += n;
    totals.set(dir, t);
  }
  let best: [string, { n: number; git: boolean }] | null = null;
  for (const e of totals) if (!best || e[1].n > best[1].n) best = e;
  if (best) return { projectCwd: best[0], isGitRoot: best[1].git };
  if (!fallbackCwd) return null;
  return { projectCwd: fallbackCwd, isGitRoot: gitRoot(fallbackCwd) === fallbackCwd };
}

/**
 * Nombre de proyecto:
 *   raíz git → su basename
 *   cwd = $HOME (o desconocido) sin repo → «Sin proyecto»
 *   si no → custom-title / ai-title → basename del directorio con más trabajo.
 * Los alias (tabla project_alias) se aplican encima al consultar, no aquí.
 */
export function projectName(
  info: ProjectInfo | null,
  titles: { customTitle: string | null; aiTitle: string | null },
  home = homedir(),
): { name: string; kind: ProjectKind } {
  if (info?.isGitRoot) return { name: basename(info.projectCwd), kind: 'git' };
  if (!info || info.projectCwd === home) return { name: NO_PROJECT, kind: 'none' };
  const t = titles.customTitle ?? titles.aiTitle;
  if (t) return { name: t, kind: 'title' };
  return { name: basename(info.projectCwd), kind: 'dir' };
}
