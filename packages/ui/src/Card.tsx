import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type GitInfo, type Session, type Summary } from './api.ts';
import { nextStep, NO_PROJECT, prLabel, relTime } from './format.ts';

export interface CardActions {
  notify: (msg: string, kind?: 'ok' | 'error') => void;
  refresh: () => void;
  replace: (s: Session) => void;
}

/**
 * Solo se enlaza un PR de github.com o un MR de gitlab.com por https. Es la
 * misma regla que `isPrUrl` en core/jsonl/extract.ts (la UI no importa core);
 * se repite aquí por las filas guardadas antes de validar al indexar.
 */
const SEG = String.raw`(?!\.\.?\/)[\w.-]+`;
const PR_URL_RE = new RegExp(
  String.raw`^https:\/\/(?:github\.com\/${SEG}\/${SEG}\/pull\/\d+|gitlab\.com(?:\/${SEG}){2,}\/-\/merge_requests\/\d+)$`,
);
const isPrUrl = (u: unknown): u is string => typeof u === 'string' && u.length <= 300 && PR_URL_RE.test(u);

const STATUS: Record<Session['status'], { label: string; dot: string }> = {
  active: { label: 'Activa', dot: 'bg-live' },
  paused: { label: 'En pausa', dot: 'bg-pause' },
  closed: { label: 'Cerrada', dot: 'border border-ink-3' },
};

function Chip({ children, tone = 'plain', title }: { children: ReactNode; tone?: 'plain' | 'warn' | 'mono'; title?: string }) {
  const tones = {
    plain: 'bg-surface-2 text-ink-2',
    warn: 'bg-warn-soft text-warn',
    mono: 'bg-surface-2 text-ink-2 font-mono text-[11px]',
  };
  return (
    <span title={title} className={`inline-flex h-[18px] max-w-[12rem] shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-[4px] px-1.5 text-[11px] ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Btn({
  children,
  onClick,
  primary,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={
        primary
          ? 'h-6 rounded-[5px] bg-accent px-2.5 text-[12px] font-medium text-accent-ink hover:brightness-110 active:brightness-95 disabled:opacity-40'
          : 'h-6 rounded-[5px] border border-line-strong bg-surface px-2.5 text-[12px] text-ink hover:bg-surface-2 active:bg-line disabled:cursor-not-allowed disabled:opacity-40'
      }
    >
      {children}
    </button>
  );
}

function TextAction({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`text-[11.5px] hover:underline ${danger ? 'text-danger' : 'text-ink-2 hover:text-ink'}`}
    >
      {children}
    </button>
  );
}

/** Nombre de proyecto con alias editable (clave = ruta del proyecto). */
function ProjectName({ s, act }: { s: Session; act: CardActions }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const name = s.display_project ?? NO_PROJECT;
  const aliased = !!s.display_project && s.display_project !== s.project_name;
  const canEdit = !!s.cwd;

  const save = async () => {
    setEditing(false);
    const v = value.trim();
    if (!s.cwd || v === name) return;
    try {
      if (!v || v === s.project_name) await api.removeAlias(s.cwd).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)));
      else await api.setAlias(s.cwd, v);
      act.refresh();
    } catch (e) {
      act.notify(`No se pudo guardar el alias: ${(e as Error).message}`, 'error');
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setEditing(false);
        }}
        aria-label="Alias del proyecto"
        placeholder={s.project_name ?? ''}
        className="h-5 w-36 rounded-[4px] border border-accent bg-surface px-1 text-[12px] font-semibold outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      disabled={!canEdit}
      onClick={(e) => {
        e.stopPropagation();
        setValue(name === NO_PROJECT ? '' : name);
        setEditing(true);
      }}
      title={canEdit ? `${s.cwd_display}${aliased ? `\nNombre original: ${s.project_name}` : ''}\nClic para renombrar` : undefined}
      className={`truncate text-[12px] font-semibold ${name === NO_PROJECT ? 'text-ink-3' : 'text-ink'} ${canEdit ? 'hover:underline decoration-ink-3 underline-offset-2' : ''}`}
    >
      {name}
    </button>
  );
}

function NoteEditor({ s, act }: { s: Session; act: CardActions }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(s.user_note ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setValue(s.user_note ?? '');
  }, [s.user_note, editing]);
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      ref.current.setSelectionRange(ref.current.value.length, ref.current.value.length);
    }
  }, [editing]);

  const save = async () => {
    setEditing(false);
    if (value.trim() === (s.user_note ?? '')) return;
    try {
      act.replace(await api.patch(s.session_id, { user_note: value }));
    } catch (e) {
      act.notify(`No se pudo guardar la nota: ${(e as Error).message}`, 'error');
    }
  };

  if (editing) {
    return (
      <textarea
        ref={ref}
        rows={2}
        value={value}
        maxLength={2000}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || !e.shiftKey)) {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            setValue(s.user_note ?? '');
            setEditing(false);
          }
        }}
        aria-label="Nota"
        placeholder="Qué no puedo olvidar al volver…"
        className="w-full resize-none rounded-[5px] border border-accent bg-surface px-2 py-1 text-[12px] outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      className={`block w-full rounded-[5px] px-2 py-1 text-left text-[12px] hover:bg-surface-2 ${s.user_note ? 'text-ink' : 'text-ink-3'}`}
    >
      {s.user_note ? (
        <>
          <span className="text-ink-3">Nota: </span>
          {s.user_note}
        </>
      ) : (
        'Añadir nota…'
      )}
    </button>
  );
}

function SummaryDetail({ s }: { s: Summary }) {
  return (
    <dl className="grid gap-1.5 text-[12px]">
      <div>
        <dt className="text-ink-3">Objetivo</dt>
        <dd className="text-ink">{s.objetivo}</dd>
      </div>
      {s.hecho.length > 0 && (
        <div>
          <dt className="text-ink-3">Hecho</dt>
          <dd>
            <ul className="list-disc pl-4 text-ink-2">
              {s.hecho.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      <div>
        <dt className="text-ink-3">Estado actual</dt>
        <dd className="text-ink-2">{s.estado_actual}</dd>
      </div>
      {s.archivos_tocados.length > 0 && (
        <div>
          <dt className="text-ink-3">Archivos</dt>
          <dd className="grid font-mono text-[11px] break-all text-ink-2">
            {s.archivos_tocados.map((f) => (
              <span key={f}>{f}</span>
            ))}
          </dd>
        </div>
      )}
    </dl>
  );
}

function gitTitle(s: Session, g: GitInfo): string {
  const lines = [s.cwd_display ?? '', g.dirty ? `${g.dirty} archivos con cambios sin commit` : 'Sin cambios sin commit'];
  if (g.ahead) lines.push(`${g.ahead} commits sin subir`);
  if (g.behind) lines.push(`${g.behind} commits del remoto sin traer`);
  return lines.join('\n');
}

export function Card({ s, git, act, compact }: { s: Session; git: GitInfo | null | undefined; act: CardActions; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'continue' | 'resume'>(null);
  const v = s.summary;
  const step = nextStep(v);
  const st = STATUS[s.status];
  const isDesktop = s.entrypoint === 'claude-desktop';
  const stale = v.kind === 'stale';

  const launch = async (mode: 'continue' | 'resume', force = false) => {
    setBusy(mode);
    try {
      await api.launch(s.session_id, mode, force);
      act.notify(mode === 'continue' ? 'Abierta en Terminal con el resumen' : 'Reanudada en Terminal');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'active' && !force) {
        if (window.confirm(`${e.message}\n\n¿Reanudar de todas formas?`)) return launch(mode, true);
      } else act.notify((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const patch = async (body: { pinned?: boolean; archived?: boolean }, msg: string) => {
    try {
      act.replace(await api.patch(s.session_id, body));
      act.notify(msg);
      if (body.archived !== undefined) act.refresh();
    } catch (e) {
      act.notify((e as Error).message, 'error');
    }
  };

  const copy = async () => {
    try {
      const { text } = await api.prompt(s.session_id);
      await navigator.clipboard.writeText(text);
      act.notify('Resumen copiado');
    } catch (e) {
      act.notify(`No se pudo copiar: ${(e as Error).message}`, 'error');
    }
  };

  const reveal = () => api.reveal(s.session_id).catch((e) => act.notify((e as Error).message, 'error'));

  const remove = async () => {
    if (!window.confirm('¿Quitar esta sesión del panel?\n\nSe borran su fila, la copia local y el prompt de lanzamiento. El transcript de Claude Code no se toca y no se volverá a indexar.')) return;
    try {
      await api.remove(s.session_id);
      act.notify('Sesión quitada del panel');
      act.refresh();
    } catch (e) {
      act.notify((e as Error).message, 'error');
    }
  };

  return (
    <article
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') void launch('continue');
        if (e.key === ' ') {
          e.preventDefault();
          setOpen((o) => !o);
        }
      }}
      tabIndex={0}
      aria-expanded={open}
      className={`cursor-default rounded-[8px] border bg-surface ${compact ? 'px-3 py-2.5' : 'px-4 py-3'} ${
        s.pinned ? 'border-line-strong' : 'border-line'
      } hover:border-line-strong`}
    >
      {/* cabecera: proyecto · git · chips · estado/tiempo */}
      <header className="flex min-w-0 items-center gap-1.5">
        <span className={`size-[7px] shrink-0 rounded-full ${st.dot}`} title={`${st.label}${s.status_source ? ` (${s.status_source})` : ''}`} aria-label={st.label} />
        <ProjectName s={s} act={act} />
        {git?.skipped && (
          <Chip tone="mono" title={`La config de este repo define «${git.skippedKey ?? '?'}», que podría ejecutar programas.\nPor seguridad, ClaudePanel no lanza git aquí.`}>
            git omitido
          </Chip>
        )}
        {git?.branch && (
          <Chip tone="mono" title={gitTitle(s, git)}>
            {git.branch}
            {git.dirty > 0 && <span className="text-warn">●{git.dirty}</span>}
            {git.ahead > 0 && <span>↑{git.ahead}</span>}
            {git.behind > 0 && <span>↓{git.behind}</span>}
          </Chip>
        )}
        {s.pr_links.filter(isPrUrl).slice(-1).map((u) => (
          <a key={u} href={u} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={u}>
            <Chip>{prLabel(u)}</Chip>
          </a>
        ))}
        {isDesktop && <Chip title="Creada en Claude Desktop">Desktop</Chip>}
        {!s.transcript_present && (
          <Chip title={s.has_archive ? 'Claude Code borró el transcript; queda la copia local filtrada' : 'Claude Code borró el transcript y no hay copia local'}>
            {s.has_archive ? 'solo copia' : 'sin transcript'}
          </Chip>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-ink-3">
          {s.pinned ? <span className="text-ink-2">Fijada</span> : null}
          <time dateTime={s.last_activity_at ?? undefined} title={s.last_activity_at ?? ''}>
            {relTime(s.last_activity_at)}
          </time>
        </span>
      </header>

      <h3 className={`mt-1 font-medium text-ink ${compact ? 'line-clamp-2 text-[13px]' : 'text-[14px]'}`}>{s.title ?? 'Sin título'}</h3>

      {/* lo que hay que hacer al volver */}
      {step && (
        <p
          className={`mt-1.5 border-l-2 pl-2 text-[12.5px] ${stale ? 'border-line-strong text-ink-2' : 'border-accent text-ink'}`}
          title={stale ? 'Del resumen anterior: hubo actividad después' : undefined}
        >
          <span className="text-ink-2">Siguiente paso: </span>
          {step}
        </p>
      )}
      {v.kind === 'away' && <p className={`mt-1.5 text-[12px] text-ink-2 ${open ? '' : 'line-clamp-3'}`}>{v.text}</p>}
      {stale && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-ink-2">
          <Chip tone="warn" title="Hubo actividad después del último resumen; se está regenerando">
            resumen antiguo
          </Chip>
          {v.lastPrompt && <span className={open ? '' : 'line-clamp-2'}>{v.lastPrompt}</span>}
        </p>
      )}
      {v.kind === 'none' && s.last_prompt && <p className="mt-1.5 line-clamp-2 text-[12px] text-ink-2">{s.last_prompt}</p>}

      <div className="mt-1.5 -mx-2">
        <NoteEditor s={s} act={act} />
      </div>

      {open && (
        <div className="mt-2 grid gap-2 border-t border-line pt-2" onClick={(e) => e.stopPropagation()}>
          {(v.kind === 'haiku' || v.kind === 'heuristic') && <SummaryDetail s={v.summary} />}
          {v.kind === 'stale' && v.previous && <SummaryDetail s={v.previous} />}
          <p className="font-mono text-[11px] break-all text-ink-3">
            {s.cwd_display ?? '—'}
            {s.launch_cwd_display && s.launch_cwd_display !== s.cwd_display ? <><br />lanzada en {s.launch_cwd_display}</> : null}
            <br />
            {s.session_id}, {s.message_count} mensajes{s.has_archive ? ', con copia local' : ''}
            {s.summary_error ? <><br />El último resumen falló: {s.summary_error}</> : null}
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {(s.transcript_present || s.has_archive) ? (
              <TextAction onClick={() => api.summarize(s.session_id).then(() => act.notify('Regenerando el resumen…'), (e) => act.notify(e.message, 'error'))}>
                Regenerar resumen{s.transcript_present ? '' : ' desde la copia'}
              </TextAction>
            ) : null}
            <TextAction danger onClick={remove}>
              Quitar del panel
            </TextAction>
          </div>
        </div>
      )}

      <footer className="mt-2 flex flex-wrap items-center gap-1.5">
        <Btn primary onClick={() => launch('continue')} disabled={busy !== null} title="Nueva sesión en Terminal con el resumen como primer mensaje">
          {busy === 'continue' ? 'Abriendo…' : 'Continuar con resumen'}
        </Btn>
        <Btn onClick={() => launch('resume')} disabled={busy !== null || !!s.resume_blocked} title={s.resume_blocked ?? 'claude --resume en Terminal'}>
          {busy === 'resume' ? 'Abriendo…' : 'Reanudar'}
        </Btn>
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          <TextAction onClick={copy}>Copiar resumen</TextAction>
          <TextAction onClick={() => patch({ pinned: !s.pinned }, s.pinned ? 'Desfijada' : 'Fijada arriba')}>{s.pinned ? 'Desfijar' : 'Fijar'}</TextAction>
          <TextAction onClick={() => patch({ archived: !s.archived }, s.archived ? 'Recuperada' : 'Archivada')}>{s.archived ? 'Desarchivar' : 'Archivar'}</TextAction>
          {s.cwd && <TextAction onClick={reveal}>Finder</TextAction>}
        </span>
      </footer>
      {s.resume_blocked && <p className="mt-1 text-[11px] text-ink-3">{isDesktop ? 'Reanudar no está disponible en sesiones de Claude Desktop.' : 'Reanudar no está disponible: el transcript original ya no existe.'}</p>}
    </article>
  );
}
