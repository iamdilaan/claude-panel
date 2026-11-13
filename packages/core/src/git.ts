import { execFile } from 'node:child_process';

export interface GitLive {
  branch: string | null; // null = HEAD detached
  dirty: number; // líneas de `git status --porcelain`
  ahead: number; // commits locales sin subir
  behind: number; // commits del remoto sin traer
  /** El repo define programas en su config: no se ha mirado el estado. */
  skipped?: 'unsafe-config';
  /** Primera clave de la config del repo que ha hecho saltar la comprobación. */
  skippedKey?: string;
}

/** Interpreta la salida de `git status --porcelain=v1 --branch`. */
export function parseGitStatus(stdout: string): GitLive {
  const lines = stdout.split('\n').filter(Boolean);
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
  const m = head.match(/^(?:No commits yet on |Initial commit on )?([^.\s]+(?:\.(?!\.)[^.\s]+)*)/);
  const branch = m && !head.startsWith('HEAD (no branch)') ? m[1] : null;
  const ahead = Number(head.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(head.match(/behind (\d+)/)?.[1] ?? 0);
  return { branch, dirty: lines.length, ahead, behind };
}

// ── seguridad ────────────────────────────────────────────────────────────────
// La carpeta del proyecto no es de fiar: su .git/config puede hacer que
// `git status` ejecute programas (fsmonitor, filtros, descarga perezosa de un
// clon parcial con transporte ext::…). Una lista de claves prohibidas siempre se
// queda corta, así que usamos una lista de claves PERMITIDAS: si la config del
// repo (ámbitos local/worktree) trae cualquier otra, no lanzamos `status`.
// Además, pase lo que pase, git corre sin descargas perezosas ni protocolos.

/** Claves de la config del repo que `git status` no puede usar para ejecutar nada. */
const SAFE_KEY = new RegExp(
  '^(?:' +
    [
      'core\\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|quotepath|untrackedcache|sparsecheckout|sparsecheckoutcone|commitgraph|splitindex|checkstat|trustctime|hookspath|editor|excludesfile|abbrev|whitespace|compression|loosecompression|longpaths|fscache)',
      'extensions\\.(?:worktreeconfig|objectformat|refstorage)',
      'remote\\.[^\\n]+\\.(?:url|pushurl|fetch|tagopt|prune|prunetags|mirror|skipdefaultupdate|gh-resolved)',
      'branch\\.[^\\n]+\\.[a-z0-9-]+', // branch.* nunca ejecuta nada
      'submodule\\.[^\\n]+\\.(?:url|active|branch)',
      '(?:user|author|committer)\\.(?:name|email|signingkey)',
      'commit\\.(?:gpgsign|verbose|cleanup|template)',
      'tag\\.(?:gpgsign|sort)',
      'gpg\\.format',
      'pull\\.(?:rebase|ff)',
      'push\\.(?:default|autosetupremote|followtags)',
      'fetch\\.(?:prune|prunetags|recursesubmodules|writecommitgraph)',
      'init\\.defaultbranch',
      'merge\\.(?:conflictstyle|ff)',
      'rebase\\.(?:autosquash|autostash|updaterefs)',
      'rerere\\.enabled',
      'diff\\.(?:algorithm|renames|colormoved|mnemonicprefix|noprefix|context)',
      'status\\.(?:showuntrackedfiles|branch|short|relativepaths|submodulesummary)',
      '(?:color|advice|alias|gc|maintenance|index|feature|log|format)\\.[^\\n]+',
      'lfs\\.(?:repositoryformatversion|url|pushurl|locksverify|fetchrecentalways|batch|concurrenttransfers|[^\\n]+\\.access)',
    ].join('|') +
    ')$',
);
/** El filtro de git-lfs con sus comandos de siempre es aceptable; cualquier otro no. */
const LFS_FILTER: Record<string, RegExp> = {
  'filter.lfs.clean': /^git-lfs clean -- %f$/,
  'filter.lfs.smudge': /^git-lfs smudge -- %f$/,
  'filter.lfs.process': /^git-lfs filter-process$/,
  'filter.lfs.required': /^true$/i,
};
/** fsmonitor solo como booleano exacto (git lee "true " como ruta de un programa). */
const GIT_BOOL = /^(?:true|false|yes|no|on|off|1|0)$/i;
/** Ámbitos que vienen del propio repo; global/sistema son config del usuario. */
const REPO_SCOPES = new Set(['local', 'worktree']);

/** ¿Es segura esta clave (ya en minúsculas) con este valor en la config del repo? */
export function isSafeRepoKey(key: string, value: string): boolean {
  if (key === 'core.fsmonitor') return GIT_BOOL.test(value);
  const lfs = LFS_FILTER[key];
  if (lfs) return lfs.test(value);
  return SAFE_KEY.test(key);
}

/**
 * Recibe la salida de `git config --list --show-scope --show-origin --includes -z`
 * y devuelve la primera clave del repo fuera de la lista permitida (o null).
 */
export function unsafeGitConfigKey(listing: string): string | null {
  const parts = listing.split('\0');
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [scope, entry] = [parts[i], parts[i + 2]];
    if (!REPO_SCOPES.has(scope)) continue;
    const nl = entry.indexOf('\n');
    const key = (nl < 0 ? entry : entry.slice(0, nl)).toLowerCase();
    // clave sin «=» es un booleano verdadero; sin trim: git tampoco lo hace
    const value = nl < 0 ? 'true' : entry.slice(nl + 1);
    if (!isSafeRepoKey(key, value)) return key;
  }
  return null;
}

/** Entorno de git sin variables GIT_* heredadas, sin config del sistema, sin prompts ni descargas. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
}

/** Opciones fijas: sin fsmonitor, sin caché de no seguidos, sin red y sin escribir el índice. */
const SAFE_ARGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'protocol.allow=never',
  '--no-optional-locks',
];

function runGit(cwd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', [...SAFE_ARGS, '-C', cwd, ...args], { timeout: timeoutMs, maxBuffer: 1 << 20, env: gitEnv() }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

/** Resultado neutro cuando el repo tiene config ejecutable: no se muestra rama. */
export const GIT_SKIPPED: GitLive = { branch: null, dirty: 0, ahead: 0, behind: 0, skipped: 'unsafe-config' };

/**
 * Lee rama y estado en vivo en el directorio del proyecto. Nunca del JSONL:
 * allí gitBranch es "HEAD" cuando Claude se lanza fuera de un repo.
 * Nunca ejecuta programas configurados por el repo (ver isSafeRepoKey).
 */
export async function gitLive(cwd: string, timeoutMs = 1500): Promise<GitLive | null> {
  const config = await runGit(cwd, ['config', '--list', '--show-scope', '--show-origin', '--includes', '-z'], timeoutMs);
  if (config === null) return null; // sin config legible no nos arriesgamos
  const key = unsafeGitConfigKey(config);
  if (key) return { ...GIT_SKIPPED, skippedKey: key };
  // submódulos fuera: cada uno trae su propia config, que no hemos revisado
  const out = await runGit(cwd, ['status', '--porcelain=v1', '--branch', '--ignore-submodules=all'], timeoutMs);
  return out === null ? null : parseGitStatus(out);
}

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<GitLive | null> }>();

/** gitLive con caché de 30 s por directorio (la UI lo pide para todas las tarjetas a la vez). */
export function gitLiveCached(cwd: string, now = Date.now()): Promise<GitLive | null> {
  const hit = cache.get(cwd);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const value = gitLive(cwd);
  cache.set(cwd, { at: now, value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}
