import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type GitInfo, type Session, type Status } from './api.ts';
import { Card, type CardActions } from './Card.tsx';
import { normalize, NO_PROJECT, projectOf, searchText } from './format.ts';

type StatusFilter = 'all' | Status;
const STATUS_TABS: [StatusFilter, string][] = [
  ['all', 'Todas'],
  ['active', 'Activas'],
  ['paused', 'En pausa'],
  ['closed', 'Cerradas'],
];
const POLL_MS = 15_000;
const PREFS_KEY = 'cpanel.prefs';

interface Prefs {
  group: boolean;
  status: StatusFilter;
  project: string;
}

function loadPrefs(): Prefs {
  try {
    return { group: false, status: 'all', project: '', ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return { group: false, status: 'all', project: '' };
  }
}

/** El popover de la barra de menú mide 380 px; la vista de navegador usa el mismo código. */
function useCompact(): boolean {
  const q = '(max-width: 520px)';
  const [c, setC] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setC(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return c;
}

export function App() {
  const compact = useCompact();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [git, setGit] = useState<Record<string, GitInfo | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'error' } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number>(undefined);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // almacenamiento no disponible: las preferencias duran la sesión
    }
  }, [prefs]);

  const load = useCallback(async () => {
    try {
      setSessions(await api.sessions(showArchived));
      setError(null);
      api.git().then(setGit, () => {});
    } catch (e) {
      setError(`No hay conexión con el daemon (${(e as Error).message}). ¿Está arrancado? cpanel daemon`);
    }
  }, [showArchived]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const act: CardActions = useMemo(
    () => ({
      notify: (msg, kind = 'ok') => {
        setToast({ msg, kind });
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 6000 : 2500);
      },
      refresh: () => void load(),
      replace: (s) => setSessions((list) => list?.map((x) => (x.session_id === s.session_id ? s : x)) ?? null),
    }),
    [load],
  );

  const projects = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sessions ?? []) m.set(projectOf(s), (m.get(projectOf(s)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => (a[0] === NO_PROJECT ? 1 : b[0] === NO_PROJECT ? -1 : a[0].localeCompare(b[0], 'es')));
  }, [sessions]);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: 0, active: 0, paused: 0, closed: 0 };
    for (const s of sessions ?? []) {
      c.all++;
      c[s.status]++;
    }
    return c;
  }, [sessions]);

  const visible = useMemo(() => {
    const q = normalize(query);
    const terms = q ? q.split(/\s+/) : [];
    return (sessions ?? []).filter((s) => {
      if (prefs.status !== 'all' && s.status !== prefs.status) return false;
      if (prefs.project && projectOf(s) !== prefs.project) return false;
      if (!terms.length) return true;
      const hay = searchText(s);
      return terms.every((t) => hay.includes(t));
    });
  }, [sessions, query, prefs]);

  const groups = useMemo(() => {
    if (!prefs.group) return [['', visible] as const];
    const m = new Map<string, Session[]>();
    for (const s of visible) m.set(projectOf(s), [...(m.get(projectOf(s)) ?? []), s]);
    // el grupo con la actividad más reciente primero; «Sin proyecto» al final
    return [...m.entries()].sort((a, b) =>
      a[0] === NO_PROJECT ? 1 : b[0] === NO_PROJECT ? -1 : (b[1][0].last_activity_at ?? '').localeCompare(a[1][0].last_activity_at ?? ''),
    );
  }, [visible, prefs.group]);

  const set = (p: Partial<Prefs>) => setPrefs((x) => ({ ...x, ...p }));
  const projectExists = !prefs.project || projects.some(([p]) => p === prefs.project);

  const projectSelect = (
    <select
      value={projectExists ? prefs.project : ''}
      onChange={(e) => set({ project: e.target.value })}
      aria-label="Proyecto"
      className="h-7 max-w-[11rem] min-w-0 rounded-[6px] border border-line-strong bg-surface px-1.5 text-[12px] outline-none focus:border-accent"
    >
      <option value="">Todos los proyectos</option>
      {projects.map(([p, n]) => (
        <option key={p} value={p}>
          {p} ({n})
        </option>
      ))}
    </select>
  );

  return (
    <div className={`mx-auto flex min-h-screen overflow-x-clip flex-col ${compact ? 'max-w-none' : 'max-w-[760px] px-6 py-6'}`}>
      <div className={`sticky top-0 z-10 grid gap-2 bg-bg ${compact ? 'px-3 pt-3 pb-2' : 'pb-3'}`}>
        <div className="flex items-center gap-2">
          {!compact && <h1 className="mr-2 text-[15px] font-semibold">Sesiones</h1>}
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="Buscar en títulos, resúmenes y notas  /"
            aria-label="Buscar"
            className="h-7 min-w-0 flex-1 rounded-[6px] border border-line-strong bg-surface px-2 text-[13px] outline-none placeholder:text-ink-3 focus:border-accent"
          />
          {!compact && projectSelect}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-[12px]">
          <div role="tablist" aria-label="Estado" className={`flex rounded-[6px] bg-line p-0.5 ${compact ? 'w-full' : ''}`}>
            {STATUS_TABS.map(([k, label]) => (
              <button
                key={k}
                role="tab"
                aria-selected={prefs.status === k}
                onClick={() => set({ status: k })}
                className={`h-[22px] whitespace-nowrap rounded-[4px] px-2 ${compact ? 'flex-1' : ''} ${prefs.status === k ? 'bg-surface text-ink shadow-[0_0_0_0.5px_var(--line-strong)]' : 'text-ink-2 hover:text-ink'}`}
              >
                {label}
                {counts[k] > 0 && k !== 'all' && <span className="ml-1 text-ink-3">{counts[k]}</span>}
              </button>
            ))}
          </div>
          {compact && projectSelect}
          <label className="ml-auto flex items-center gap-1 whitespace-nowrap text-ink-2">
            <input type="checkbox" checked={prefs.group} onChange={(e) => set({ group: e.target.checked })} className="accent-[var(--accent)]" />
            Agrupar
          </label>
          <label className="flex items-center gap-1 whitespace-nowrap text-ink-2">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="accent-[var(--accent)]" />
            Archivadas
          </label>
        </div>
      </div>

      <main className={`grid flex-1 grid-cols-[minmax(0,1fr)] content-start gap-2 ${compact ? 'px-3 pb-3' : ''}`}>
        {error && <p className="rounded-[8px] border border-line bg-surface p-3 text-[12px] text-danger">{error}</p>}
        {sessions === null && !error && <p className="p-3 text-ink-3">Cargando…</p>}
        {sessions && visible.length === 0 && (
          <p className="p-6 text-center text-[12px] text-ink-3">
            {sessions.length === 0 ? 'Aún no hay sesiones indexadas. Ejecuta cpanel scan.' : 'Nada coincide con la búsqueda o los filtros.'}
          </p>
        )}
        {groups.map(([name, list]) => (
          <section key={name || 'all'} className="grid grid-cols-[minmax(0,1fr)] gap-2">
            {name && (
              <h2 className="mt-2 flex items-baseline gap-1.5 px-1 text-[11.5px] font-semibold text-ink-2 first:mt-0">
                {name}
                <span className="font-normal text-ink-3">{list.length}</span>
              </h2>
            )}
            {list.map((s) => (
              <Card key={s.session_id} s={s} git={s.cwd ? git[s.cwd] : undefined} act={act} compact={compact} />
            ))}
          </section>
        ))}
      </main>

      {toast && (
        <div
          role="status"
          className={`fixed inset-x-3 bottom-3 mx-auto max-w-sm rounded-[8px] px-3 py-2 text-[12px] shadow-[0_4px_16px_rgb(0_0_0/0.18)] ${
            toast.kind === 'error' ? 'bg-danger text-white' : 'bg-ink text-bg'
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
