import type { SessionRow } from './db/sessions.ts';

export interface Summary {
  objetivo: string;
  hecho: string[];
  estado_actual: string;
  siguiente_paso: string;
  archivos_tocados: string[];
}

type Row = Pick<
  SessionRow,
  | 'away_summary' | 'away_summary_at' | 'last_activity_at' | 'summary_json' | 'summary_source'
  | 'summary_covers_at' | 'last_prompt' | 'hidden' | 'transcript_present' | 'user_note'
>;

/** away_summary vale si no hubo actividad real (user/assistant) después de generarlo. */
export function isAwayFresh(r: Row): boolean {
  if (!r.away_summary || !r.away_summary_at) return false;
  return !r.last_activity_at || r.last_activity_at <= r.away_summary_at;
}

export function isSummaryFresh(r: Row): boolean {
  if (!r.summary_json || !r.summary_covers_at) return false;
  return !r.last_activity_at || r.last_activity_at <= r.summary_covers_at;
}

/** ¿Hay que pedir resumen a Haiku? No si el recap de Claude Code o el nuestro siguen vigentes. */
export function needsSummary(r: Row): boolean {
  if (r.hidden || !r.transcript_present) return false;
  return !isAwayFresh(r) && !isSummaryFresh(r);
}

export function parseSummary(json: string | null): Summary | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Summary;
  } catch {
    return null;
  }
}

export type SummaryView =
  | { kind: 'away'; text: string }
  | { kind: 'haiku' | 'heuristic'; summary: Summary }
  | { kind: 'stale'; lastPrompt: string | null; previous: Summary | null }
  | { kind: 'none' };

/**
 * Qué resumen mostrar. La nota manual (user_note) va siempre aparte y por
 * encima; esto decide el resto:
 *   away_summary vigente > resumen propio vigente > «resumen antiguo» (último prompt).
 */
export function summaryView(r: Row): SummaryView {
  if (isAwayFresh(r)) return { kind: 'away', text: r.away_summary! };
  const s = parseSummary(r.summary_json);
  if (s && isSummaryFresh(r)) return { kind: r.summary_source === 'heuristic' ? 'heuristic' : 'haiku', summary: s };
  if (s || r.away_summary || r.last_prompt) return { kind: 'stale', lastPrompt: r.last_prompt, previous: s };
  return { kind: 'none' };
}
