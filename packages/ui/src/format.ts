import type { Session, SummaryView } from './api.ts';

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto', style: 'short' });

export function relTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const s = (now - Date.parse(iso)) / 1000;
  if (s < 60) return 'ahora';
  if (s < 3600) return rtf.format(-Math.floor(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), 'hour');
  if (s < 86400 * 7) return rtf.format(-Math.floor(s / 86400), 'day');
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}

export function prLabel(url: string): string {
  const m = url.match(/\/pull\/(\d+)/) ?? url.match(/\/merge_requests\/(\d+)/);
  return m ? `PR #${m[1]}` : 'PR';
}

/** Línea destacada de la tarjeta. */
export function nextStep(v: SummaryView): string | null {
  if (v.kind === 'haiku' || v.kind === 'heuristic') return v.summary.siguiente_paso;
  if (v.kind === 'stale') return v.previous?.siguiente_paso ?? null;
  return null;
}

export function searchText(s: Session): string {
  const v = s.summary;
  const parts = [s.title, s.display_project, s.cwd_display, s.user_note, s.first_prompt, s.last_prompt, ...s.pr_links];
  if (v.kind === 'away') parts.push(v.text);
  if (v.kind === 'haiku' || v.kind === 'heuristic') parts.push(v.summary.objetivo, v.summary.estado_actual, v.summary.siguiente_paso, ...v.summary.hecho);
  if (v.kind === 'stale' && v.previous) parts.push(v.previous.objetivo, v.previous.siguiente_paso);
  return parts.filter(Boolean).join('\n').toLocaleLowerCase('es').normalize('NFD').replace(/\p{M}/gu, '');
}

export const normalize = (q: string) => q.toLocaleLowerCase('es').normalize('NFD').replace(/\p{M}/gu, '').trim();

export const NO_PROJECT = 'Sin proyecto';
export const projectOf = (s: Session) => s.display_project ?? NO_PROJECT;
