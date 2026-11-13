import { SUMMARIZER_MARKER } from '../paths.ts';
import { redactPrefix } from '../redact.ts';

/**
 * Estado acumulado de una sesión. Es serializable (se guarda en SQLite) para
 * poder seguir leyendo el JSONL desde el último offset sin releerlo entero.
 */
export interface SessionScanState {
  v: 2;
  firstCwd: string | null;
  cwdCounts: Record<string, number>;
  startedAt: string | null;
  /** Último registro user/assistant (incluye uso de herramientas). */
  lastActivityAt: string | null;
  /** Último timestamp de cualquier registro; solo como respaldo. */
  lastAnyAt: string | null;
  /** Último timestamp de un prompt real o de una respuesta de texto. */
  lastMessageAt: string | null;
  userPrompts: number;
  assistantReplies: number;
  firstPrompt: string | null;
  firstPromptRaw: string | null;
  lastPrompt: string | null;
  aiTitle: string | null;
  customTitle: string | null;
  awaySummary: string | null;
  awaySummaryAt: string | null;
  prLinks: string[];
  entrypoint: string | null;
  version: string | null;
  compactions: number;
}

export function emptyState(): SessionScanState {
  return {
    v: 2,
    firstCwd: null,
    cwdCounts: {},
    startedAt: null,
    lastActivityAt: null,
    lastAnyAt: null,
    lastMessageAt: null,
    userPrompts: 0,
    assistantReplies: 0,
    firstPrompt: null,
    firstPromptRaw: null,
    lastPrompt: null,
    aiTitle: null,
    customTitle: null,
    awaySummary: null,
    awaySummaryAt: null,
    prLinks: [],
    entrypoint: null,
    version: null,
    compactions: 0,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const maxIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
const minIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);

/** Etiquetas cuyo mensaje de usuario no es un prompt escrito por la persona. */
const NON_PROMPT_TAGS = /^<(local-command-stdout|local-command-caveat|bash-stdout|bash-stderr|task-notification|command-message)\b/;

/**
 * Convierte el texto de un mensaje de usuario en el prompt legible, o null si
 * no es un prompt humano (salida de comandos, avisos de agentes, interrupciones).
 */
export function cleanPrompt(raw: string): string | null {
  let s = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!s) return null;
  if (s.startsWith('[Request interrupted')) return null;
  if (NON_PROMPT_TAGS.test(s)) return null;
  const cmd = s.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = s.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return [cmd[1].trim(), args].filter(Boolean).join(' ');
  }
  const bash = s.match(/^<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bash) return `! ${bash[1].trim()}`;
  s = s.replace(/<\/?pasted_content\b[^>]*>/g, '').trim();
  return s || null;
}

function userText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = str((b as { text?: unknown }).text);
      if (t) parts.push(t);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

function hasAssistantText(message: unknown): boolean {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && str((b as { text?: unknown }).text),
  );
}

/** Segmento de ruta de owner/repo/grupo: sin `.` ni `..`. */
const SEG = String.raw`(?!\.\.?\/)[\w.-]+`;
const PR_URL_RE = new RegExp(
  String.raw`^https:\/\/(?:github\.com\/${SEG}\/${SEG}\/pull\/\d+|gitlab\.com(?:\/${SEG}){2,}\/-\/merge_requests\/\d+)$`,
);
export const MAX_PR_LINKS = 20;

/**
 * El enlace de un registro `pr-link` sale del transcript: solo se guarda si es
 * exactamente un PR de github.com o un MR de gitlab.com por https (sin
 * credenciales, puerto, query ni otros esquemas).
 */
export const isPrUrl = (u: string): boolean => u.length <= 300 && PR_URL_RE.test(u);

const oneLine = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/**
 * Prompt recortado para el índice, redactado antes del corte: si no, el corte
 * puede partir una clave y dejar un trozo que ninguna regla reconoce después
 * (el prompt de «Continuar» y el digest redactan lo ya recortado).
 */
const promptLine = (s: string, n: number) => {
  // se conservan los saltos de línea (reglas de .netrc/.pgpass) pero sin rachas de espacios,
  // para que la ventana de `redactPrefix` mida lo mismo que quedará tras `oneLine`
  const dense = s.replace(/\s+/g, (w) => (w.includes('\n') ? '\n' : ' ')).trim();
  return oneLine(redactPrefix(dense, n).text, n);
};

/** Incorpora un registro del JSONL al estado. Tolerante a tipos y campos desconocidos. */
export function foldRecord(st: SessionScanState, rec: Record<string, unknown>): void {
  const type = rec.type;
  const ts = str(rec.timestamp);
  const sidechain = rec.isSidechain === true;

  if (ts) {
    st.startedAt = minIso(st.startedAt, ts);
    st.lastAnyAt = maxIso(st.lastAnyAt, ts);
    // registros sueltos (system/informational, queue-operation…) llegan días
    // después sin que haya trabajo: no cuentan como actividad
    if ((type === 'user' || type === 'assistant') && !sidechain) {
      st.lastActivityAt = maxIso(st.lastActivityAt, ts);
    }
  }
  const cwd = str(rec.cwd);
  if (cwd && !sidechain) {
    st.firstCwd ??= cwd;
    st.cwdCounts[cwd] = (st.cwdCounts[cwd] ?? 0) + 1;
  }
  const ep = str(rec.entrypoint);
  if (ep) st.entrypoint ??= ep;
  const ver = str(rec.version);
  if (ver && (type === 'user' || type === 'assistant')) st.version = ver;

  switch (type) {
    case 'user': {
      if (sidechain || rec.isMeta === true) return;
      if (rec.isCompactSummary === true) {
        st.compactions++;
        return;
      }
      const raw = userText(rec.message);
      if (!raw) return; // tool_result puro
      const prompt = cleanPrompt(raw);
      if (!prompt) return;
      st.userPrompts++;
      st.lastPrompt = promptLine(prompt, 300);
      if (st.firstPrompt === null) {
        st.firstPrompt = promptLine(prompt, 300);
        st.firstPromptRaw = raw.trimStart().slice(0, 200);
      }
      if (ts) st.lastMessageAt = maxIso(st.lastMessageAt, ts);
      return;
    }
    case 'assistant': {
      if (sidechain) return;
      if (hasAssistantText(rec.message)) {
        st.assistantReplies++;
        if (ts) st.lastMessageAt = maxIso(st.lastMessageAt, ts);
      }
      return;
    }
    case 'ai-title':
      st.aiTitle = str(rec.aiTitle) ?? st.aiTitle;
      return;
    case 'custom-title':
      st.customTitle = str(rec.customTitle) ?? st.customTitle;
      return;
    case 'last-prompt': {
      const lp = str(rec.lastPrompt);
      if (lp) st.lastPrompt = promptLine(cleanPrompt(lp) ?? lp, 300);
      return;
    }
    case 'pr-link': {
      const url = str(rec.prUrl);
      if (url && isPrUrl(url) && !st.prLinks.includes(url)) {
        st.prLinks.push(url);
        if (st.prLinks.length > MAX_PR_LINKS) st.prLinks.shift();
      }
      return;
    }
    case 'system': {
      if (rec.subtype === 'away_summary' && !sidechain) {
        const c = str(rec.content);
        if (c) {
          st.awaySummary = c.replace(/\s*\(disable recaps in \/config\)\s*$/, '').trim();
          st.awaySummaryAt = ts ?? st.awaySummaryAt;
        }
      } else if (rec.subtype === 'compact_boundary') {
        // la compactación se cuenta por el mensaje isCompactSummary
      }
      return;
    }
    default:
      return; // tipos desconocidos o irrelevantes: se ignoran a propósito
  }
}

export function isSummarizerSession(st: SessionScanState): boolean {
  return st.firstPromptRaw?.startsWith(SUMMARIZER_MARKER) ?? false;
}

/** custom-title > ai-title > primer prompt. */
export function sessionTitle(st: SessionScanState): string | null {
  return st.customTitle ?? st.aiTitle ?? (st.firstPrompt ? oneLine(st.firstPrompt, 80) : null);
}

/**
 * El away_summary vale si no hubo conversación después de generarlo. Se compara
 * con el último mensaje real y no con el mtime del archivo, porque Claude Code
 * sigue añadiendo registros de metadatos (títulos, modos…) que mueven el mtime.
 */
export function freshAwaySummary(st: SessionScanState): string | null {
  if (!st.awaySummary || !st.awaySummaryAt) return null;
  if (st.lastMessageAt && st.lastMessageAt > st.awaySummaryAt) return null;
  return st.awaySummary;
}
