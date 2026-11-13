export type Status = 'active' | 'paused' | 'closed';

export interface Summary {
  objetivo: string;
  hecho: string[];
  estado_actual: string;
  siguiente_paso: string;
  archivos_tocados: string[];
}

export type SummaryView =
  | { kind: 'away'; text: string }
  | { kind: 'haiku' | 'heuristic'; summary: Summary }
  | { kind: 'stale'; lastPrompt: string | null; previous: Summary | null }
  | { kind: 'none' };

export interface Session {
  session_id: string;
  title: string | null;
  display_project: string | null;
  project_name: string | null;
  project_kind: 'git' | 'title' | 'dir' | 'none' | null;
  cwd: string | null;
  cwd_display: string | null;
  launch_cwd_display: string | null;
  entrypoint: string | null;
  status: Status;
  status_source: string | null;
  started_at: string | null;
  last_activity_at: string | null;
  message_count: number;
  pr_links: string[];
  summary: SummaryView;
  summary_error: string | null;
  user_note: string | null;
  first_prompt: string | null;
  last_prompt: string | null;
  pinned: number;
  archived: number;
  transcript_present: number;
  resume_blocked: string | null;
  has_archive: boolean;
}

export interface GitInfo {
  branch: string | null;
  dirty: number;
  ahead: number;
  behind: number;
  /** El repo define programas en su config: el daemon no ha mirado su estado. */
  skipped?: 'unsafe-config';
  /** Clave de la config del repo que ha hecho saltar la comprobación. */
  skippedKey?: string;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

declare global {
  interface Window {
    /** Lo inyecta la app de barra de menú (lado Rust) al cargar la página. */
    __CPANEL_TOKEN__?: string;
  }
}

const TOKEN_KEY = 'cpanel-token';
const TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * Token local. La app lo inyecta desde Rust; en el navegador llega una vez en
 * el fragmento (`cpanel open` → /#t=…), que nunca viaja al servidor: lo
 * guardamos en sessionStorage (solo esta pestaña) y lo quitamos de la URL.
 */
export function readToken(): string {
  if (window.__CPANEL_TOKEN__) return window.__CPANEL_TOKEN__;
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
  if (fromHash !== null) {
    history.replaceState(null, '', location.pathname + location.search);
    if (TOKEN_RE.test(fromHash)) {
      try {
        sessionStorage.setItem(TOKEN_KEY, fromHash);
      } catch {
        // sin almacenamiento: vale para esta carga
      }
      return fromHash;
    }
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

// El fragmento #t= se consume una sola vez al cargar; el de la app se lee en
// cada petición, porque la app lo reinyecta si aparece o cambia.
const initialToken = readToken();
const currentToken = (): string => window.__CPANEL_TOKEN__ || initialToken;

async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  // Toda la API exige el token, también las lecturas.
  const token = currentToken();
  const headers: Record<string, string> = { 'x-cpanel-token': token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await r.json().catch(() => ({}))) as { error?: string; code?: string };
  // 401: la petición no se ejecutó; si la app ya ha inyectado otro token, un reintento.
  if (r.status === 401 && !retried && currentToken() !== token) return call<T>(method, path, body, true);
  if (r.status === 401) throw new ApiError(401,'token ausente o inválido: abre el panel con `cpanel open` o desde la app', 'token');
  if (!r.ok) throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`, data.code);
  return data as T;
}

export const api = {
  sessions: (archived: boolean) => call<Session[]>('GET', `/api/sessions${archived ? '?archived=1' : ''}`),
  git: () => call<Record<string, GitInfo | null>>('GET', '/api/git'),
  prompt: (id: string) => call<{ text: string }>('GET', `/api/sessions/${id}/prompt`),
  patch: (id: string, body: { user_note?: string | null; pinned?: boolean; archived?: boolean }) =>
    call<Session>('PATCH', `/api/sessions/${id}`, body),
  launch: (id: string, mode: 'continue' | 'resume', force = false) =>
    call<{ ok: true }>('POST', `/api/sessions/${id}/launch`, force ? { mode, force } : { mode }),
  reveal: (id: string) => call<{ ok: true }>('POST', `/api/sessions/${id}/reveal`),
  remove: (id: string) => call<{ ok: true }>('DELETE', `/api/sessions/${id}`),
  setAlias: (key: string, alias: string) => call<{ ok: true }>('PUT', '/api/aliases', { key, alias }),
  removeAlias: (key: string) => call<{ ok: true }>('DELETE', `/api/aliases?key=${encodeURIComponent(key)}`),
  summarize: (id: string) => call<{ queued: boolean }>('POST', `/api/sessions/${id}/summarize?force=1`),
};
