import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import {
  LaunchError,
  checkTerminalAutomation,
  continueDir,
  daemonPort,
  deleteSession,
  ensureToken,
  gitLiveCached,
  launchDir,
  resumeBlockReason,
  revealInFinder,
  updateUserFields,
  type Runner,
  getSession,
  listAliases,
  listSessions,
  removeAlias,
  resolveSessionId,
  scan,
  setAlias,
  summaryView,
  tokenMatches,
  type SessionRow,
} from '@cpanel/core';
import { removeArchive } from '@cpanel/summarizer';
import { rmSync } from 'node:fs';
import {
  continuePromptFor,
  drainQueue,
  handleHookEvent,
  HookEventSchema,
  launchSession,
  type ServiceDeps,
} from './service.ts';

export interface AppDeps extends ServiceDeps {
  token: string;
  port: number;
  /** Ejecuta osascript/open; inyectable en tests. */
  run?: Runner;
  /** Carpeta con el build de la UI (index.html + assets). */
  uiDir?: string;
}

/** URL para abrir la UI en el navegador: el token va en el fragmento (#t=…), que el navegador no envía. */
export function uiUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#t=${encodeURIComponent(token)}`;
}

/** Ejecuta un programa pasándole `input` por stdin; inyectable en tests. */
export type StdinRunner = (file: string, args: string[], input: string) => Promise<void>;

const stdinRunner: StdinRunner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 15_000 }, (err, _out, stderr) =>
      err ? reject(new Error(`${file} falló: ${(stderr || err.message).trim()}`)) : resolve(),
    );
    child.stdin?.end(input);
  });

/**
 * Abre la UI en el navegador por defecto (`cpanel open`). La URL con el token
 * va por stdin a osascript, no en argv: así no aparece en `ps` para otros usuarios.
 */
export function openUi(opts: { port?: number; token?: string; run?: StdinRunner } = {}): Promise<string> {
  const url = uiUrl(opts.port ?? daemonPort(), opts.token ?? ensureToken());
  const script = `open location ${JSON.stringify(url)}\n`;
  return (opts.run ?? stdinRunner)('/usr/bin/osascript', ['-'], script).then(() => url);
}

export const DEFAULT_UI_DIR = resolve(import.meta.dirname, '..', '..', 'ui', 'dist');

const HOME = homedir();
const tilde = (p: string | null) => (p ? (p === HOME || p.startsWith(HOME + sep) ? `~${p.slice(HOME.length)}` : p) : null);

export function sessionDto(r: SessionRow, hasArchive = false) {
  const { scan_state: _s, summary_json: _j, scan_offset: _o, pr_links, ...rest } = r;
  return {
    ...rest,
    pr_links: JSON.parse(pr_links) as string[],
    summary: summaryView(r),
    cwd_display: tilde(continueDir(r)),
    launch_cwd_display: tilde(r.launch_cwd),
    resume_blocked: resumeBlockReason(r),
    has_archive: hasArchive,
  };
}

const PatchSchema = z
  .object({
    user_note: z.string().max(2000).nullable().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict();
const LaunchSchema = z.object({ mode: z.enum(['continue', 'resume']), force: z.boolean().optional() }).strict();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

/** CSP estricta: solo recursos propios; sin iframes ajenos (clickjacking). */
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

const launchStatus = (e: LaunchError) =>
  ({ invalid: 400, 'missing-dir': 409, 'resume-blocked': 409, active: 409, osascript: 502 }) as const satisfies Record<LaunchError['code'], number>;

export function createApp(deps: AppDeps) {
  const { db, token, port } = deps;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const app = new Hono();

  // Cabeceras de seguridad: primer middleware, así envuelven toda respuesta
  // (también los 403 de Host y las rutas que no llaman a next()).
  app.use('*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
  });

  // Anti DNS-rebinding: solo se atiende a peticiones dirigidas a localhost.
  app.use('*', async (c, next) => {
    if (!allowedHosts.has(c.req.header('host') ?? '')) return c.json({ error: 'host no permitido' }, 403);
    await next();
  });

  // Toda la API: Origin (si lo hay) local y token obligatorio. Una web externa
  // no puede leer el token ni falsificar el Origin desde un navegador, y el
  // token nunca se sirve sin autenticar (ni en la página).
  const guard = async (c: Context, next: Next) => {
    const origin = c.req.header('origin');
    if (origin && !allowedOrigins.has(origin)) return c.json({ error: 'origin no permitido' }, 403);
    if (!tokenMatches(token, c.req.header('x-cpanel-token'))) return c.json({ error: 'token inválido' }, 401);
    await next();
  };

  // Lecturas incluidas (/api/git lanza procesos, /api/sessions expone datos).
  // Única excepción: /api/health, que la app y el CLI usan para saber si hay daemon.
  const OPEN = new Set(['/api/health']);
  app.use('/api/*', (c, next) => (OPEN.has(c.req.path) ? next() : guard(c, next)));

  app.get('/api/health', (c) => c.json({ ok: true, pid: process.pid, queue: deps.queue.size }));

  const dto = (r: SessionRow) => sessionDto(r, deps.archive?.has(r.session_id) ?? false);
  const find = (c: Context) => {
    const id = resolveSessionId(db, c.req.param('id') ?? '');
    return id ? getSession(db, id) : undefined;
  };

  /** Para `cpanel doctor`: el permiso de Automatización que importa es el del daemon, no el de la terminal. */
  app.post('/api/doctor/automation', async (c) => c.json(await checkTerminalAutomation()));

  /** Para el icono de la barra de menú: cuántas sesiones hay activas o en pausa. */
  app.get('/api/stats', (c) => {
    const rows = db
      .prepare("SELECT status, COUNT(*) AS n FROM sessions WHERE hidden = 0 AND archived = 0 GROUP BY status")
      .all() as { status: string; n: number }[];
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    return c.json({ active: by.active ?? 0, paused: by.paused ?? 0, closed: by.closed ?? 0 });
  });

  app.get('/api/sessions', (c) => {
    // archived=1 incluye las archivadas a mano; las del resumidor nunca se listan aquí
    const archived = c.req.query('archived') === '1' || c.req.query('all') === '1';
    return c.json(listSessions(db, { includeArchived: archived, includeHidden: c.req.query('all') === '1' }).map(dto));
  });

  app.get('/api/sessions/:id', (c) => {
    const row = find(c);
    return row ? c.json(dto(row)) : c.json({ error: 'no encontrada' }, 404);
  });

  /** Texto de «Continuar con resumen» (para «Copiar resumen»). Mismo origen únicamente: no hay CORS. */
  app.get('/api/sessions/:id/prompt', (c) => {
    const row = find(c);
    return row ? c.json({ text: continuePromptFor(row, deps.archive) }) : c.json({ error: 'no encontrada' }, 404);
  });

  app.patch('/api/sessions/:id', async (c) => {
    const row = find(c);
    if (!row) return c.json({ error: 'no encontrada' }, 404);
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'cuerpo inválido' }, 400);
    updateUserFields(db, row.session_id, parsed.data);
    return c.json(dto(getSession(db, row.session_id)!));
  });

  app.post('/api/sessions/:id/launch', async (c) => {
    const row = find(c);
    if (!row) return c.json({ error: 'no encontrada' }, 404);
    const parsed = LaunchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'modo inválido' }, 400);
    try {
      const res = await launchSession(db, row.session_id, parsed.data.mode, {
        run: deps.run,
        force: parsed.data.force,
        archive: deps.archive,
      });
      deps.log.info('launch', { id: row.session_id, mode: res.mode });
      return c.json({ ok: true, mode: res.mode });
    } catch (e) {
      if (e instanceof LaunchError) return c.json({ error: e.message, code: e.code }, launchStatus(e)[e.code]);
      throw e;
    }
  });

  app.post('/api/sessions/:id/reveal', async (c) => {
    const row = find(c);
    if (!row) return c.json({ error: 'no encontrada' }, 404);
    try {
      await revealInFinder(continueDir(row) ?? '', deps.run);
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof LaunchError) return c.json({ error: e.message, code: e.code }, launchStatus(e)[e.code]);
      throw e;
    }
  });

  /** Borra del panel (DB + copia local + prompt de lanzamiento). Nunca toca ~/.claude/projects. */
  app.delete('/api/sessions/:id', (c) => {
    const row = find(c);
    if (!row) return c.json({ error: 'no encontrada' }, 404);
    deleteSession(db, row.session_id);
    removeArchive(row.session_id);
    rmSync(join(launchDir(), `${row.session_id}.md`), { force: true });
    deps.log.info('delete', { id: row.session_id });
    return c.json({ ok: true });
  });

  /** Rama y cambios en vivo de cada directorio de proyecto listado (caché 30 s). */
  app.get('/api/git', async (c) => {
    const dirs = [...new Set(listSessions(db, { includeArchived: true }).map((r) => continueDir(r)).filter((d): d is string => !!d))];
    const out: Record<string, Awaited<ReturnType<typeof gitLiveCached>>> = {};
    await Promise.all(dirs.map(async (d) => (out[d] = await gitLiveCached(d))));
    return c.json(out);
  });

  app.post('/api/hook', async (c) => {
    const parsed = HookEventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'evento inválido' }, 400);
    // Respondemos ya; el hook no debe esperar al scan.
    void handleHookEvent(parsed.data, deps)
      .then(() => drainQueue(deps))
      .catch((e) => deps.log.error('hook', { error: String(e) }));
    return c.json({ accepted: true }, 202);
  });

  app.post('/api/scan', async (c) => {
    const stats = await scan(db, { full: c.req.query('full') === '1' });
    return c.json(stats);
  });

  app.post('/api/sessions/:id/summarize', (c) => {
    const id = resolveSessionId(db, c.req.param('id') ?? '');
    if (!id) return c.json({ error: 'no encontrada' }, 404);
    const queued = deps.queue.enqueue(id, 'high', c.req.query('force') === '1');
    return c.json({ queued }, 202);
  });

  app.get('/api/aliases', (c) => c.json(listAliases(db)));
  app.put('/api/aliases', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { key?: unknown; alias?: unknown } | null;
    if (typeof body?.key !== 'string' || typeof body.alias !== 'string' || !body.key.trim() || !body.alias.trim()) {
      return c.json({ error: 'key y alias requeridos' }, 400);
    }
    setAlias(db, body.key.trim(), body.alias);
    return c.json({ ok: true });
  });
  app.delete('/api/aliases', (c) => {
    const key = c.req.query('key');
    return key && removeAlias(db, key) ? c.json({ ok: true }) : c.json({ error: 'no existe' }, 404);
  });

  // ── UI estática ─────────────────────────────────────────────────────────────
  const uiDir = deps.uiDir ?? DEFAULT_UI_DIR;
  const serveIndex = (c: Context) => {
    let html: string;
    try {
      html = readFileSync(join(uiDir, 'index.html'), 'utf8');
    } catch {
      return c.text('UI sin compilar: ejecuta `npm run build:ui`.', 503);
    }
    // Sin token: la app lo inyecta desde Rust y el navegador lo trae en el
    // fragmento de la URL (`cpanel open`), que nunca llega al servidor.
    c.header('cache-control', 'no-store');
    return c.html(html);
  };
  app.get('/', serveIndex);
  app.get('/assets/*', (c) => {
    const rel = normalize(decodeURIComponent(c.req.path)).replace(/^[/\\]+/, '');
    const full = resolve(uiDir, rel);
    if (!full.startsWith(resolve(uiDir) + sep)) return c.notFound();
    try {
      if (!statSync(full).isFile()) return c.notFound();
      c.header('content-type', MIME[extname(full)] ?? 'application/octet-stream');
      c.header('cache-control', 'public, max-age=31536000, immutable');
      return c.body(readFileSync(full));
    } catch {
      return c.notFound();
    }
  });

  return app;
}
