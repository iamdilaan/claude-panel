import { serve } from '@hono/node-server';
import { createLogger, DAEMON_HOST, daemonPort, ensureToken, loadConfig, openDb, refreshStatuses, scan } from '@cpanel/core';
import { createApp } from './app.ts';
import { ArchiveWorker, backfillSummaries, drainQueue, SummaryQueue } from './service.ts';

export * from './app.ts';
export * from './service.ts';

const RESCAN_MS = 10 * 60 * 1000;
const STATUS_MS = 30 * 1000;
const PRUNE_MS = 24 * 60 * 60 * 1000;

export async function startDaemon(opts: { echo?: boolean } = {}) {
  const log = createLogger('daemon', { echo: opts.echo });
  const port = daemonPort();
  const db = openDb();
  const token = ensureToken();
  const queue = new SummaryQueue(db, log);
  const { config, error: configError } = loadConfig();
  if (configError) log.warn(configError);
  const archive = config.archive_enabled ? new ArchiveWorker(db, log) : undefined;
  const deps = { db, log, queue, token, port, archive };
  const app = createApp(deps);

  const server = serve({ fetch: app.fetch, hostname: DAEMON_HOST, port });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  }).catch((e: NodeJS.ErrnoException) => {
    log.error('no se pudo escuchar', { port, code: e.code });
    throw e.code === 'EADDRINUSE' ? new Error(`el puerto ${port} ya está en uso (¿otro daemon?)`) : e;
  });
  log.info('daemon escuchando', { host: DAEMON_HOST, port, pid: process.pid });

  const cycle = async (label: string) => {
    try {
      const stats = await scan(db);
      const drained = await drainQueue(deps);
      const queued = backfillSummaries(db, queue);
      const archiving = archive?.requestStale() ?? 0;
      log.info(label, { ...stats, drained, summariesQueued: queued, archiving });
    } catch (e) {
      log.error(`${label} falló`, { error: e instanceof Error ? e.message : String(e) });
    }
  };
  await cycle('scan inicial');
  const t1 = setInterval(() => void cycle('rescan'), RESCAN_MS);
  const t2 = setInterval(() => void refreshStatuses(db).catch(() => {}), STATUS_MS);
  // Retención opcional (desactivada por defecto): config.json → archive_retention_days
  const prune = () => {
    const days = config.archive_retention_days;
    if (!archive || !days) return;
    const res = archive.prune(days);
    if (res.removed.length) log.info('archive prune', { days, removed: res.removed.length, bytes: res.bytes });
  };
  prune();
  const t3 = setInterval(prune, PRUNE_MS);

  const shutdown = () => {
    log.info('daemon parando');
    clearInterval(t1);
    clearInterval(t2);
    clearInterval(t3);
    queue.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { app, server, db, queue };
}
