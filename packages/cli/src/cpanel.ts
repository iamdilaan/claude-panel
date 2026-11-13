#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  backupsDir,
  claudeSettingsPath,
  createLogger,
  daemonPort,
  archiveDir,
  dbPath,
  deleteSession,
  getSession,
  launchDir,
  loadConfig,
  panelHome,
  gitLive,
  listAliases,
  listSessions,
  openDb,
  queueDir,
  removeAlias,
  resolveSessionId,
  scan,
  setAlias,
  summaryView,
  type GitLive,
  type SessionRow,
} from '@cpanel/core';
import { ArchiveWorker, backfillSummaries, drainQueue, openUi, startDaemon, SummaryQueue } from '@cpanel/daemon';
import { pruneArchives, removeArchive } from '@cpanel/summarizer';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { applySettings, hookCommand, serialize, unifiedDiff, withOurHooks, withoutOurHooks } from './install-hooks.ts';
import {
  APP_LABEL,
  DAEMON_LABEL,
  bootout,
  bootstrap,
  defaultAppPath,
  jobState,
  planInstall,
  planUninstall,
  plistPath,
  readIfExists,
  removePlist,
  writePlist,
  type AgentPlan,
} from './launchd.ts';

const HELP = `cpanel — índice de sesiones de Claude Code

Uso:
  cpanel scan [--full] [--json] [--all]     indexa ~/.claude/projects y lista las sesiones
  cpanel summarize [id…] [--recent N] [--force]
                                            resume con Haiku (por defecto, las 30 más recientes que lo necesiten)
  cpanel alias ls | set <clave> <alias> | rm <clave>
                                            renombra o fusiona proyectos; <clave> = nombre o ruta
  cpanel archive                            crea o pone al día las copias locales (~/.claude-panel/archive)
  cpanel archive --prune --older-than <N>d [--dry-run]
                                            borra copias de sesiones sin actividad en N días
  cpanel delete <id> [--yes]                quita una sesión del panel (DB, copia y prompt); no toca ~/.claude/projects
  cpanel launchd install|uninstall [--yes] [--dry-run] [--app RUTA]
                                            daemon y app al iniciar sesión (~/Library/LaunchAgents)
  cpanel uninstall [--purge] [--yes] [--dry-run]
                                            quita launchd, hooks y la app; con --purge también ~/.claude-panel
  cpanel doctor                             comprueba daemon, launchd, hooks, permisos y claude
  cpanel daemon [--quiet]                   arranca el daemon en primer plano (127.0.0.1:${daemonPort()})
  cpanel open                               abre el panel en el navegador (con el token local)
  cpanel install-hooks [--yes] [--dry-run]  añade los hooks Stop/SessionEnd a ~/.claude/settings.json
  cpanel uninstall-hooks [--yes]            los quita
`;

const tty = process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c('2');
const bold = c('1');
const cyan = c('36');
const yellow = c('33');
const magenta = c('35');
const green = c('32');

function relTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  if (s < 86400 * 30) return `hace ${Math.round(s / 86400)} d`;
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

const tilde = (p: string | null) => (p ? p.replace(homedir(), '~') : '—');
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function daemonUp(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${daemonPort()}/api/health`, { signal: AbortSignal.timeout(300) });
    return r.ok;
  } catch {
    return false;
  }
}

// ── scan ─────────────────────────────────────────────────────────────────────

async function cmdScan(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { full: { type: 'boolean' }, json: { type: 'boolean' }, all: { type: 'boolean' } },
  });
  const db = openDb();
  // Sin daemon, los eventos de hook quedan en cola: los procesamos aquí.
  let drained = 0;
  if (!(await daemonUp())) {
    const log = createLogger('cli');
    const queue = new SummaryQueue(db, log);
    drained = await drainQueue({ db, log, queue });
    queue.stop(); // los resúmenes, con `cpanel summarize`
  }
  const stats = await scan(db, { full: values.full });
  const rows = listSessions(db, { includeHidden: values.all, includeArchived: values.all });

  const cwds = [...new Set(rows.map((r) => r.cwd).filter((x): x is string => !!x))];
  const git = new Map<string, GitLive | null>(await Promise.all(cwds.map(async (d) => [d, await gitLive(d)] as const)));

  if (values.json) {
    const out = rows.map(({ scan_state: _s, summary_json: _j, ...r }) => ({
      ...r,
      pr_links: JSON.parse(r.pr_links) as string[],
      summary: summaryView(r as SessionRow),
      git_live: r.cwd ? git.get(r.cwd) ?? null : null,
    }));
    process.stdout.write(`${JSON.stringify({ stats, sessions: out }, null, 2)}\n`);
    return;
  }

  console.log(
    dim(
      `${stats.files} transcripts · ${stats.parsed} leídos (${stats.fullRescans} completos, ` +
        `${(stats.bytesRead / 1e6).toFixed(1)} MB) · ${stats.unchanged} sin cambios · ` +
        `${stats.hidden} del resumidor · ${stats.missing} ya borrados por Claude Code · ${stats.ms} ms` +
        (drained ? ` · ${drained} eventos de hook procesados` : ''),
    ),
  );
  console.log(dim(`db: ${tilde(dbPath())}\n`));
  for (const r of rows) printRow(r, r.cwd ? git.get(r.cwd) ?? null : null);
}

function printRow(r: SessionRow, g: GitLive | null) {
  const chips: string[] = [];
  if (r.entrypoint === 'claude-desktop') chips.push(magenta('[Desktop]'));
  if (r.status === 'active') chips.push(green('[activa]'));
  if (r.status === 'paused') chips.push(yellow('[en pausa]'));
  if (!r.transcript_present) chips.push(dim('[transcript borrado]'));
  if (g?.branch) chips.push(cyan(`⎇ ${g.branch}${g.dirty ? ` ±${g.dirty}` : ''}`));
  const prs = JSON.parse(r.pr_links) as string[];
  if (prs.length) chips.push(cyan(prs.length > 3 ? `#${prs.at(-1)!.split('/').pop()} +${prs.length - 1} PRs` : prs.map((u) => `#${u.split('/').pop()}`).join(' ')));

  const proj = r.display_project ?? r.project_name ?? '?';
  console.log(`${bold(cut(proj, 50))}  ${dim(relTime(r.last_activity_at))}  ${chips.join(' ')}`);
  if (r.title && r.title !== proj) console.log(`  ${cut(r.title, 90)}`);
  if (r.user_note) console.log(`  ${yellow('✎')} ${cut(r.user_note, 160)}`);

  const v = summaryView(r);
  switch (v.kind) {
    case 'away':
      console.log(`  ${dim('↳')} ${cut(v.text, 180)}`);
      break;
    case 'haiku':
    case 'heuristic':
      console.log(`  ${dim('objetivo:')} ${cut(v.summary.objetivo, 150)}`);
      console.log(`  ${dim('estado:')}   ${cut(v.summary.estado_actual, 150)}`);
      if (!r.user_note) console.log(`  ${bold('→')} ${cut(v.summary.siguiente_paso, 150)}`);
      if (v.kind === 'heuristic') console.log(`  ${dim('(resumen heurístico: Haiku no disponible)')}`);
      break;
    case 'stale':
      if (v.lastPrompt) console.log(`  ${yellow('[resumen antiguo]')} ${dim('último prompt:')} ${cut(v.lastPrompt, 130)}`);
      break;
  }
  console.log(
    dim(
      `  ${r.session_id.slice(0, 8)} · ${r.message_count} msgs · trabajo ${tilde(r.cwd)}` +
        (r.launch_cwd !== r.cwd ? ` · lanzada en ${tilde(r.launch_cwd)}` : '') +
        `\n`,
    ),
  );
}

// ── summarize ────────────────────────────────────────────────────────────────

async function cmdSummarize(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { recent: { type: 'string' }, force: { type: 'boolean' } },
  });
  const db = openDb();
  await scan(db);
  const log = createLogger('cli');
  const queue = new SummaryQueue(db, log);
  if (positionals.length) {
    for (const p of positionals) {
      const id = resolveSessionId(db, p);
      if (!id) {
        console.error(`no encuentro una única sesión con id «${p}»`);
        process.exitCode = 1;
        continue;
      }
      queue.enqueue(id, 'high', !!values.force);
    }
  } else {
    const n = backfillSummaries(db, queue, Number(values.recent ?? 30));
    console.log(dim(`${n} sesiones necesitan resumen…`));
  }
  const t0 = Date.now();
  await queue.idle();
  const ids = positionals.length ? positionals.map((p) => resolveSessionId(db, p)).filter((x): x is string => !!x) : null;
  const rows = ids ? ids.map((id) => getSession(db, id)!).filter(Boolean) : listSessions(db).slice(0, Number(values.recent ?? 30));
  console.log(dim(`listo en ${((Date.now() - t0) / 1000).toFixed(1)} s\n`));
  for (const r of rows) printRow(r, null);
}

// ── alias ────────────────────────────────────────────────────────────────────

function aliasKey(k: string): string {
  if (k.startsWith('~/')) return join(homedir(), k.slice(2));
  if (k.startsWith('/') || k.startsWith('./') || existsSync(k)) return resolve(k);
  return k;
}

function cmdAlias(argv: string[]) {
  const [sub, key, ...rest] = argv;
  const db = openDb();
  if (!sub || sub === 'ls') {
    const aliases = listAliases(db);
    if (!aliases.length) console.log(dim('sin alias. Ejemplo: cpanel alias set webs ATLAS'));
    for (const a of aliases) console.log(`${tilde(a.key)} ${dim('→')} ${bold(a.alias)}`);
    const names = [...new Set(listSessions(db).map((r) => r.project_name ?? ''))].filter(Boolean);
    console.log(dim(`\nproyectos detectados: ${names.join(' · ')}`));
    return;
  }
  if (sub === 'set' && key && rest.length) {
    setAlias(db, aliasKey(key), rest.join(' '));
    console.log(`${tilde(aliasKey(key))} → ${rest.join(' ')}`);
    return;
  }
  if (sub === 'rm' && key) {
    console.log(removeAlias(db, aliasKey(key)) ? 'eliminado' : 'no existía');
    return;
  }
  console.error(HELP);
  process.exitCode = 2;
}

// ── hooks ────────────────────────────────────────────────────────────────────

async function confirmTty(diff: string, yes: boolean): Promise<boolean> {
  console.log(diff);
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error('sin terminal interactiva: revisa el diff y repite con --yes para aplicarlo');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question('¿Aplicar estos cambios? [s/N] ');
  rl.close();
  return /^s(í|i)?$/i.test(ans.trim());
}

/**
 * Ruta de node que sobreviva a actualizaciones: Homebrew expone
 * /opt/homebrew/bin/node → Cellar/node/<versión>/bin/node. Si un enlace estable
 * apunta al mismo binario que el actual, usamos el enlace.
 */
function stableNodePath(): string {
  const real = realpathSync(process.execPath);
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try {
      if (realpathSync(p) === real) return p;
    } catch {
      // no existe
    }
  }
  return process.execPath;
}

async function cmdHooks(argv: string[], install: boolean) {
  const { values } = parseArgs({ args: argv, options: { yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
  const script = fileURLToPath(new URL('./cpanel-hook.ts', import.meta.url));
  const node = stableNodePath();
  const res = await applySettings({
    settingsPath: claudeSettingsPath(),
    backupDir: backupsDir(),
    label: tilde(claudeSettingsPath()),
    transform: install ? (s) => withOurHooks(s, (ev) => hookCommand(node, script, ev)) : withoutOurHooks,
    confirm: (d) => confirmTty(d, !!values.yes),
    dryRun: values['dry-run'],
  });
  if (!res.changed) console.log(install ? 'Los hooks ya están instalados; nada que cambiar.' : 'No hay hooks de ClaudePanel; nada que quitar.');
  else if (values['dry-run']) console.log(`${res.diff}\n(dry-run: no se ha escrito nada)`);
  else if (res.written) console.log(green(`Hecho.${res.backup ? ` Backup en ${tilde(res.backup)}` : ''}`));
  else console.log('Cancelado; no se ha escrito nada.');
  if (install && res.written) console.log(dim(`Si el daemon no está en marcha, los eventos esperan en ${tilde(queueDir())}.`));
}

// ── launchd ──────────────────────────────────────────────────────────────────

const cliScriptPath = () => fileURLToPath(import.meta.url);

async function daemonHealth(): Promise<{ pid: number } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${daemonPort()}/api/health`, { signal: AbortSignal.timeout(500) });
    return r.ok ? ((await r.json()) as { pid: number }) : null;
  } catch {
    return null;
  }
}

async function cmdLaunchd(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, app: { type: 'string' } },
  });
  const sub = positionals[0];
  if (sub !== 'install' && sub !== 'uninstall') throw new Error('uso: cpanel launchd install|uninstall [--yes] [--dry-run] [--app RUTA]');
  const plans: AgentPlan[] =
    sub === 'install'
      ? planInstall({ nodePath: stableNodePath(), cliScript: cliScriptPath(), appPath: resolve(values.app ?? defaultAppPath()) })
      : planUninstall();
  const states = new Map(await Promise.all(plans.map(async (p) => [p.label, await jobState(p.label)] as const)));

  const steps: string[] = [];
  let diff = '';
  for (const p of plans) {
    const st = states.get(p.label)!;
    const changed = p.before !== p.after;
    if (p.after === null) {
      if (st.loaded) steps.push(`launchctl bootout gui/<uid>/${p.label}`);
      if (p.before !== null) {
        steps.push(`rm ${tilde(p.path)}`);
        diff += `${unifiedDiff(p.before, '', tilde(p.path))}\n`;
      }
      continue;
    }
    if (changed) diff += `${unifiedDiff(p.before ?? '', p.after, tilde(p.path))}\n`;
    if (changed && st.loaded) steps.push(`launchctl bootout gui/<uid>/${p.label}`);
    if (changed) steps.push(`escribir ${tilde(p.path)}`);
    if (p.load && (changed || !st.loaded)) steps.push(`launchctl bootstrap gui/<uid> ${tilde(p.path)}`);
    if (p.note) steps.push(yellow(`aviso: ${p.note}`));
  }
  if (!steps.length) {
    console.log(sub === 'install' ? 'Ya está todo instalado y cargado; nada que cambiar.' : 'No hay agentes de ClaudePanel; nada que quitar.');
    return;
  }
  const summary = `${diff}${bold('Pasos:')}\n${steps.map((x) => `  ${x}`).join('\n')}`;
  if (values['dry-run']) {
    console.log(`${summary}\n(dry-run: no se ha escrito nada)`);
    return;
  }
  if (!(await confirmTty(summary, !!values.yes))) {
    console.log('Cancelado; no se ha escrito nada.');
    return;
  }

  if (sub === 'install') {
    const h = await daemonHealth();
    const st = states.get(DAEMON_LABEL)!;
    if (h && h.pid !== st.pid) {
      console.log(yellow(`Aviso: ya hay un daemon fuera de launchd (pid ${h.pid}) ocupando el puerto ${daemonPort()}. Páralo; launchd reintentará cada 10 s hasta que quede libre.`));
    }
  }
  mkdirSync(join(panelHome(), 'logs'), { recursive: true, mode: 0o700 });
  for (const p of plans) {
    const st = states.get(p.label)!;
    if (p.after === null) {
      if (st.loaded) await bootout(p.label);
      removePlist(p.path);
      continue;
    }
    const changed = p.before !== p.after;
    if (changed) {
      if (st.loaded) await bootout(p.label);
      writePlist(p.path, p.after);
    }
    if (p.load && (changed || !st.loaded)) {
      const r = await bootstrap(p.path);
      if (r.code !== 0) console.log(yellow(`launchctl bootstrap ${p.label}: ${r.out || `código ${r.code}`}`));
    }
  }
  console.log(green('Hecho.'));
}

// ── uninstall ────────────────────────────────────────────────────────────────

function dirSize(p: string): number {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    return readdirSync(p).reduce((n, f) => n + dirSize(join(p, f)), 0);
  } catch {
    return 0;
  }
}

/**
 * Desinstalación limpia. Orden: launchd (para el daemon y la app) → hooks →
 * app → datos (solo con --purge). Nunca toca ~/.claude/projects ni nada de
 * Claude Code salvo nuestros hooks en settings.json (con backup).
 */
async function cmdUninstall(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { purge: { type: 'boolean' }, yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
  const plans = planUninstall();
  const states = new Map(await Promise.all(plans.map(async (p) => [p.label, await jobState(p.label)] as const)));
  // un settings.json roto no debe impedir quitar launchd y la app: avisamos y seguimos
  let hooks: { changed: boolean; diff: string } = { changed: false, diff: '' };
  let hooksError: string | null = null;
  try {
    hooks = await applySettings({
      settingsPath: claudeSettingsPath(),
      backupDir: backupsDir(),
      label: tilde(claudeSettingsPath()),
      transform: withoutOurHooks,
      confirm: async () => false,
      dryRun: true,
    });
  } catch (e) {
    hooksError = (e as Error).message;
  }
  const hooksWarning = hooksError
    ? yellow(`Aviso: no puedo revisar los hooks de ${tilde(claudeSettingsPath())}: ${hooksError}\nSi quedan hooks de ClaudePanel (contienen "cpanel-hook"), quítalos a mano; el resto de la desinstalación sigue.`)
    : null;
  if (hooksWarning) console.log(hooksWarning);
  const app = defaultAppPath();
  const steps: string[] = [];
  for (const p of plans) {
    if (states.get(p.label)!.loaded) steps.push(`launchctl bootout gui/<uid>/${p.label}`);
    if (p.before !== null) steps.push(`rm ${tilde(p.path)}`);
  }
  if (hooks.changed) {
    const where = values.purge ? `junto a ${tilde(claudeSettingsPath())}` : `en ${tilde(backupsDir())}`;
    steps.push(`quitar los hooks de ClaudePanel de ${tilde(claudeSettingsPath())} (backup ${where})`);
  }
  if (existsSync(app)) steps.push(`rm -r ${tilde(app)}`);
  const home = panelHome();
  if (values.purge && existsSync(home)) {
    steps.push(`rm -r ${tilde(home)}  ${yellow(`(${(dirSize(home) / 1e6).toFixed(1)} MB: índice, resúmenes, notas, copias locales, logs y backups)`)}`);
  }
  if (!steps.length) {
    console.log(hooksError ? 'No queda nada más de ClaudePanel que quitar.' : 'No queda nada de ClaudePanel instalado.');
    return;
  }
  const keep = values.purge
    ? ''
    : `\n${dim(`Se conservan tus datos en ${tilde(home)} (notas, resúmenes, copias locales). Para borrarlos también: --purge`)}`;
  const summary = `${hooks.changed ? `${hooks.diff}\n` : ''}${bold('Pasos:')}\n${steps.map((x) => `  ${x}`).join('\n')}\n${dim('No se toca ~/.claude/projects.')}${keep}`;
  if (values['dry-run']) {
    console.log(`${summary}\n(dry-run: no se ha cambiado nada)`);
    return;
  }
  if (!(await confirmTty(summary, !!values.yes))) {
    console.log('Cancelado; no se ha cambiado nada.');
    return;
  }
  for (const p of plans) {
    if (states.get(p.label)!.loaded) await bootout(p.label);
    removePlist(p.path);
  }
  if (hooks.changed) {
    try {
      const r = await applySettings({
        settingsPath: claudeSettingsPath(),
        // con --purge, ~/.claude-panel/backups desaparece: el backup va junto a settings.json
        backupDir: values.purge ? dirname(claudeSettingsPath()) : backupsDir(),
        label: tilde(claudeSettingsPath()),
        transform: withoutOurHooks,
        confirm: async () => true,
      });
      if (r.target !== claudeSettingsPath()) console.log(dim(`settings.json es un enlace: escrito en ${tilde(r.target)}`));
      if (r.backup) console.log(dim(`backup de settings.json en ${tilde(r.backup)}`));
    } catch (e) {
      console.log(yellow(`Aviso: no he podido quitar los hooks: ${(e as Error).message}\nQuítalos a mano; el resto de la desinstalación sigue.`));
    }
  }
  rmSync(app, { recursive: true, force: true });
  if (values.purge) rmSync(home, { recursive: true, force: true });
  console.log(green('ClaudePanel desinstalado.'));
  console.log(dim(`El código sigue en ${tilde(fileURLToPath(new URL('../../..', import.meta.url)))}: bórralo a mano si ya no lo quieres.`));
}

// ── doctor ───────────────────────────────────────────────────────────────────

type Check = { ok: boolean | 'warn'; label: string; detail?: string };

async function cmdDoctor() {
  const checks: Check[] = [];
  const add = (ok: Check['ok'], label: string, detail?: string) => checks.push({ ok, label, detail });

  // node
  const major = Number(process.versions.node.split('.')[0]);
  add(major === 26, `node ${process.versions.node}`, major === 26 ? tilde(stableNodePath()) : 'se necesita Node 26 (.nvmrc)');

  // daemon
  const h = await daemonHealth();
  const dst = await jobState(DAEMON_LABEL);
  if (!h) add(false, `daemon no responde en 127.0.0.1:${daemonPort()}`, dst.loaded ? `launchd lo tiene cargado (última salida: ${dst.lastExit ?? '—'}); mira ~/.claude-panel/logs/daemon.err.log` : 'arráncalo: cpanel launchd install (o cpanel daemon)');
  else add(h.pid === dst.pid ? true : 'warn', `daemon responde (pid ${h.pid})`, h.pid === dst.pid ? 'gestionado por launchd' : 'no lo gestiona launchd: no arrancará solo al iniciar sesión');

  // plists
  const expected = planInstall({ nodePath: stableNodePath(), cliScript: cliScriptPath(), appPath: defaultAppPath() });
  for (const p of expected) {
    const cur = readIfExists(plistPath(p.label));
    const st = p.label === DAEMON_LABEL ? dst : await jobState(p.label);
    if (cur === null) add(false, `${p.label}: sin plist`, 'cpanel launchd install');
    else if (p.label === APP_LABEL && cur !== p.after) add('warn', `${p.label}: plist distinto del esperado`, 'apunta a otra ruta de la app; revisa con cpanel launchd install --dry-run');
    else if (cur !== p.after) add('warn', `${p.label}: plist desactualizado`, 'cpanel launchd install');
    else add(st.loaded ? true : 'warn', `${p.label}: plist correcto${st.loaded ? `, cargado${st.pid ? ` (pid ${st.pid})` : ''}` : ', sin cargar'}`);
  }
  const appBin = join(defaultAppPath(), 'Contents', 'MacOS', 'claudepanel');
  add(existsSync(appBin) ? true : 'warn', existsSync(appBin) ? `app instalada en ${tilde(defaultAppPath())}` : 'app de barra de menú sin instalar', existsSync(appBin) ? undefined : 'npm run app:install');

  // hooks
  try {
    const raw = readFileSync(claudeSettingsPath(), 'utf8');
    const cur = JSON.parse(raw);
    const script = fileURLToPath(new URL('./cpanel-hook.ts', import.meta.url));
    const want = withOurHooks(cur, (ev) => hookCommand(stableNodePath(), script, ev));
    add(serialize(want) === serialize(cur), serialize(want) === serialize(cur) ? 'hooks Stop y SessionEnd instalados' : 'hooks ausentes o desactualizados', serialize(want) === serialize(cur) ? undefined : 'cpanel install-hooks');
  } catch (e) {
    add(false, 'no se pudo leer ~/.claude/settings.json', (e as Error).message);
  }

  // Automatización de Terminal (la del daemon, que es quien lanza osascript)
  if (h) {
    try {
      const token = readFileSync(join(panelHome(), 'token'), 'utf8').trim();
      const r = await fetch(`http://127.0.0.1:${daemonPort()}/api/doctor/automation`, {
        method: 'POST',
        headers: { 'x-cpanel-token': token },
        signal: AbortSignal.timeout(65_000),
      });
      const a = (await r.json()) as { state: string; detail: string };
      if (a.state === 'ok') add(true, 'el daemon puede controlar Terminal (Automatización)');
      else if (a.state === 'not-running') add('warn', 'Terminal no está abierto: no se puede comprobar la Automatización', 'ábrelo y repite; macOS lo preguntará la primera vez que lances una sesión');
      else if (a.state === 'denied') add(false, 'Automatización de Terminal denegada al daemon', 'Ajustes del Sistema › Privacidad y seguridad › Automatización › node › Terminal');
      else add(false, 'no se pudo comprobar la Automatización', a.detail);
    } catch (e) {
      add(false, 'no se pudo comprobar la Automatización', (e as Error).message);
    }
  } else add('warn', 'Automatización de Terminal: sin comprobar (daemon apagado)');

  // claude
  try {
    const { claudeBin, supportsNoPersistence } = await import('@cpanel/summarizer');
    const bin = claudeBin();
    const { execFileSync } = await import('node:child_process');
    const v = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
    const np = supportsNoPersistence(bin);
    add(np ? true : 'warn', `claude ${v}`, `${tilde(bin)}${np ? '' : ' · sin --no-session-persistence: actualiza Claude Code'}`);
  } catch (e) {
    add(false, 'claude no encontrado o no responde', (e as Error).message);
  }

  // permisos de datos
  const mode = (p: string) => {
    try {
      return statSync(p).mode & 0o777;
    } catch {
      return null;
    }
  };
  const home = mode(panelHome());
  const tok = mode(join(panelHome(), 'token'));
  add(home === 0o700 && tok === 0o600, `permisos de ~/.claude-panel (${home?.toString(8) ?? '—'}) y del token (${tok?.toString(8) ?? '—'})`, home === 0o700 && tok === 0o600 ? undefined : 'deberían ser 700 y 600');

  // UI y cola
  const ui = existsSync(join(fileURLToPath(new URL('../../ui/dist/index.html', import.meta.url))));
  add(ui, ui ? 'UI compilada' : 'UI sin compilar', ui ? undefined : 'npm run build:ui');
  let pending = 0;
  try {
    pending = readdirSync(queueDir()).filter((f) => f.endsWith('.json')).length;
  } catch {
    // sin cola
  }
  add(pending === 0 ? true : 'warn', `${pending} eventos de hook en cola`, pending ? 'se procesan cuando el daemon arranca' : undefined);
  const { error: cfgErr } = loadConfig();
  add(!cfgErr, cfgErr ?? 'config.json válido (o sin config: valores por defecto)');

  for (const c of checks) {
    const mark = c.ok === true ? green('✓') : c.ok === 'warn' ? yellow('!') : '\x1b[31m✗\x1b[0m';
    console.log(`${mark} ${c.label}${c.detail ? dim(`  ${c.detail}`) : ''}`);
  }
  const bad = checks.filter((c) => c.ok === false).length;
  const warn = checks.filter((c) => c.ok === 'warn').length;
  console.log(`\n${bad ? `${bad} problemas` : 'Sin problemas'}${warn ? `, ${warn} avisos` : ''}.`);
  if (bad) process.exitCode = 1;
}

// ── archive / delete ─────────────────────────────────────────────────────────

function archiveTotals(): { files: number; bytes: number } {
  try {
    const fs = readdirSync(archiveDir()).filter((f) => f.endsWith('.txt.gz'));
    return { files: fs.length, bytes: fs.reduce((n, f) => n + statSync(join(archiveDir(), f)).size, 0) };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

export function parseDays(s: string | undefined): number | null {
  const m = s?.match(/^(\d+)d?$/);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

async function cmdArchive(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { prune: { type: 'boolean' }, 'older-than': { type: 'string' }, 'dry-run': { type: 'boolean' } },
  });
  const db = openDb();
  const log = createLogger('cli');
  const worker = new ArchiveWorker(db, log);
  if (values.prune) {
    const days = parseDays(values['older-than']);
    if (!days) throw new Error('uso: cpanel archive --prune --older-than <N>d [--dry-run]');
    const dry = !!values['dry-run'];
    const res = pruneArchives(db, { olderThanDays: days, dryRun: dry });
    console.log(
      `${res.removed.length} copias ${dry ? 'se borrarían' : 'borradas'} (${(res.bytes / 1e6).toFixed(2)} MB) · más de ${days} días sin actividad`,
    );
    if (dry) for (const rid of res.removed) console.log(dim(`  ${rid}`));
    return;
  }
  const n = worker.requestStale();
  await worker.idle();
  const t = archiveTotals();
  console.log(`${n} copias actualizadas · ${t.files} en total · ${(t.bytes / 1e6).toFixed(2)} MB en ${tilde(archiveDir())}`);
}

async function cmdDelete(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { yes: { type: 'boolean' } } });
  const db = openDb();
  const id = positionals[0] ? resolveSessionId(db, positionals[0]) : null;
  const row = id ? getSession(db, id) : undefined;
  if (!row) throw new Error('uso: cpanel delete <id o prefijo único>');
  console.log(`${bold(row.title ?? row.session_id)}  ${dim(row.session_id)}\n${dim(tilde(row.cwd))}`);
  if (!values.yes) {
    if (!process.stdin.isTTY) throw new Error('sin terminal interactiva: añade --yes');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = /^s/i.test(await rl.question('¿Quitarla del panel? Se borran la fila, la copia local y el prompt. [s/N] '));
    rl.close();
    if (!ok) return;
  }
  deleteSession(db, row.session_id);
  removeArchive(row.session_id);
  rmSync(join(launchDir(), `${row.session_id}.md`), { force: true });
  console.log(`borrada · el scanner la ignorará aunque el transcript siga en ${tilde(row.transcript_path)}`);
}

// ── open ─────────────────────────────────────────────────────────────────────

/** Abre la UI en el navegador; el token viaja en el fragmento (#t=…), nunca lo sirve el daemon. */
async function cmdOpen() {
  if (!(await daemonUp())) console.log(yellow('Aviso: el daemon no responde; arráncalo con `cpanel launchd install` (o `cpanel daemon`).'));
  await openUi();
  console.log(`abierto http://127.0.0.1:${daemonPort()} ${dim('(token en el fragmento de la URL; se borra al cargar)')}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'scan':
      return cmdScan(rest);
    case 'summarize':
      return cmdSummarize(rest);
    case 'alias':
      return cmdAlias(rest);
    case 'archive':
      return cmdArchive(rest);
    case 'delete':
      return cmdDelete(rest);
    case 'daemon':
      // bajo launchd (--quiet) el log va solo al archivo rotado, no a stdout
      await startDaemon({ echo: !rest.includes('--quiet') });
      return;
    case 'open':
      return cmdOpen();
    case 'launchd':
      return cmdLaunchd(rest);
    case 'doctor':
      return cmdDoctor();
    case 'uninstall':
      return cmdUninstall(rest);
    case 'install-hooks':
      return cmdHooks(rest, true);
    case 'uninstall-hooks':
      return cmdHooks(rest, false);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`comando desconocido: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`cpanel: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
