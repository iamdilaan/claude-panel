import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitLive, gitLiveCached, parseGitStatus, unsafeGitConfigKey } from '../src/git.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'cpanel-git-'));
  git(d, 'init', '-q');
  return d;
}

describe('parseGitStatus', () => {
  it.each([
    ['## main', { branch: 'main', dirty: 0, ahead: 0, behind: 0 }],
    ['## main...origin/main [ahead 2, behind 1]\n M a.ts\n?? b.ts', { branch: 'main', dirty: 2, ahead: 2, behind: 1 }],
    ['## release/1.2...origin/release/1.2 [behind 3]', { branch: 'release/1.2', dirty: 0, ahead: 0, behind: 3 }],
    ['## No commits yet on main\n?? x', { branch: 'main', dirty: 1, ahead: 0, behind: 0 }],
    ['## HEAD (no branch)\n M a', { branch: null, dirty: 1, ahead: 0, behind: 0 }],
  ])('%j', (out, want) => expect(parseGitStatus(out)).toEqual(want));
});

describe('gitLive con repos reales', () => {
  it('rama, cambios y commits por delante del remoto', async () => {
    const origin = repo();
    writeFileSync(join(origin, 'a.txt'), 'a');
    git(origin, 'add', '.');
    git(origin, 'commit', '-qm', 'a');
    const clone = mkdtempSync(join(tmpdir(), 'cpanel-clone-'));
    git(clone, 'clone', '-q', origin, '.');
    git(clone, 'checkout', '-qb', 'feature/x.y');
    git(clone, 'branch', '-q', '--set-upstream-to=origin/main');
    writeFileSync(join(clone, 'b.txt'), 'b');
    git(clone, 'add', '.');
    git(clone, 'commit', '-qm', 'b');
    writeFileSync(join(clone, 'c.txt'), 'sin añadir');
    expect(await gitLive(clone)).toEqual({ branch: 'feature/x.y', dirty: 1, ahead: 1, behind: 0 });
  });

  it('fuera de un repo devuelve null; sin commits, la rama inicial', async () => {
    expect(await gitLive(mkdtempSync(join(tmpdir(), 'cpanel-norepo-')))).toBeNull();
    expect(await gitLive('/no/existe')).toBeNull();
    expect((await gitLive(repo()))?.branch).toBe('main');
  });

  it('la caché devuelve lo mismo durante 30 s y vuelve a mirar después', async () => {
    const d = repo();
    const t0 = 1_000_000;
    expect((await gitLiveCached(d, t0))?.dirty).toBe(0);
    writeFileSync(join(d, 'n.txt'), 'x');
    expect((await gitLiveCached(d, t0 + 29_000))?.dirty).toBe(0);
    expect((await gitLiveCached(d, t0 + 31_000))?.dirty).toBe(1);
  });
});

// DATA-1: la config del repo no debe poder ejecutar nada al mirar su estado.
describe('gitLive no ejecuta programas de la config del repo', () => {
  const committed = () => {
    const d = repo();
    writeFileSync(join(d, 'a'), 'x');
    git(d, 'add', '.');
    git(d, 'commit', '-qm', 'i');
    return d;
  };
  const addConfig = (d: string, text: string) => appendFileSync(join(d, '.git', 'config'), text);
  const marker = () => join(mkdtempSync(join(tmpdir(), 'cpanel-mark-')), 'PWNED');
  const statDirty = (d: string) => {
    const future = new Date('2030-01-01T00:00:00Z');
    utimesSync(join(d, 'a'), future, future);
  };

  it('PoC 1: core.fsmonitor del repo no se ejecuta', async () => {
    const d = committed();
    const m = marker();
    addConfig(d, `[core]\n\tfsmonitor = "touch '${m}'; false"\n`);
    const g = await gitLive(d);
    expect(existsSync(m)).toBe(false);
    expect(g).toMatchObject({ branch: null, dirty: 0, skipped: 'unsafe-config' });
  });

  it('PoC 2: un filtro clean del repo no se ejecuta (con el índice sucio por stat)', async () => {
    const d = committed();
    writeFileSync(join(d, '.gitattributes'), 'a filter=ev\n');
    git(d, 'add', '.');
    git(d, 'commit', '-qm', 'attrs');
    const m = marker();
    addConfig(d, `[filter "ev"]\n\tclean = "sh -c 'touch ${m}; cat'"\n`);
    statDirty(d);
    const g = await gitLive(d);
    expect(existsSync(m)).toBe(false);
    expect(g?.skipped).toBe('unsafe-config');
  });

  it('un include del repo que define un filtro también se detecta', async () => {
    const d = committed();
    writeFileSync(join(d, '.gitattributes'), 'a filter=ev\n');
    const m = marker();
    writeFileSync(join(d, '.git', 'evil.inc'), `[filter "ev"]\n\tclean = "sh -c 'touch ${m}; cat'"\n`);
    addConfig(d, '[include]\n\tpath = evil.inc\n');
    statDirty(d);
    expect((await gitLive(d))?.skipped).toBe('unsafe-config');
    expect(existsSync(m)).toBe(false);
  });

  it('core.fsmonitor = true (el daemon integrado de git) no bloquea el estado', async () => {
    const d = committed();
    addConfig(d, '[core]\n\tfsmonitor = true\n');
    expect(await gitLive(d)).toEqual({ branch: 'main', dirty: 0, ahead: 0, behind: 0 });
  });
});

describe('unsafeGitConfigKey', () => {
  const entry = (scope: string, key: string, value?: string) => `${scope}\0file:x\0${key}${value === undefined ? '' : `\n${value}`}\0`;
  it.each([
    ['core.fsmonitor', 'touch x'],
    ['filter.ev.clean', 'cat'],
    ['filter.ev.smudge', 'cat'],
    ['filter.ev.process', 'cat'],
    ['diff.x.textconv', 'cat'],
    ['diff.x.command', 'cat'],
    ['diff.external', 'cat'],
    ['core.pager', 'less'],
    ['core.sshcommand', 'ssh'],
    ['credential.helper', 'x'],
    ['credential.https://h.example.helper', 'x'],
    ['include.path', 'x'],
    ['includeif.gitdir:/x/.path', 'x'],
    ['merge.x.driver', 'x'],
    ['gpg.program', 'x'],
    ['core.fsmonitor', 'true '], // git lo lee como ruta de un programa
    ['extensions.partialclone', 'origin'],
    ['remote.origin.promisor', 'true'],
    ['protocol.ext.allow', 'always'],
    ['url.ext::sh.insteadof', 'https://'],
    ['filter.lfs.clean', 'sh -c evil'],
    ['algo.desconocido', 'x'],
  ])('local %s → inseguro', (key, value) => {
    expect(unsafeGitConfigKey(entry('local', key, value))).toBe(key);
    expect(unsafeGitConfigKey(entry('worktree', key, value))).toBe(key);
  });
  it('la config global o del sistema (la del propio usuario) no cuenta', () => {
    expect(unsafeGitConfigKey(entry('global', 'filter.lfs.clean', 'git-lfs clean -- %f') + entry('system', 'credential.helper', 'osxkeychain'))).toBeNull();
  });
  it('claves inocuas y fsmonitor booleano', () => {
    const all = [
      entry('local', 'core.bare', 'false'),
      entry('local', 'core.fsmonitor', 'false'),
      entry('local', 'core.fsmonitor', 'true'),
      entry('local', 'core.fsmonitor'), // clave sin valor = true
      entry('local', 'remote.origin.url', 'https://h.example/x.git'),
      entry('local', 'core.hookspath', '.husky/_'), // status no ejecuta hooks
      entry('local', 'branch.main.github-pr-owner-number', 'a#b#1'),
      entry('local', 'filter.lfs.clean', 'git-lfs clean -- %f'),
      entry('local', 'filter.lfs.process', 'git-lfs filter-process'),
    ].join('');
    expect(unsafeGitConfigKey(all)).toBeNull();
  });
});
