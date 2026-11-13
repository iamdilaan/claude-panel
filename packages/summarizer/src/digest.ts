import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { cleanPrompt, isSecretFile, redact, redactPrefix } from '@cpanel/core';

export interface DigestOptions {
  /** Interacciones (prompts + respuestas de texto) a conservar. */
  interactions?: number;
  /** Tope de caracteres del digest completo. */
  maxChars?: number;
}

export interface Digest {
  /** Texto ya redactado, listo para enviar. */
  text: string;
  redactions: number;
  interactions: number;
  /** Archivos editados/creados en la ventana, del más reciente al más antiguo. */
  filesTouched: string[];
  lastUserPrompt: string | null;
  lastAssistantText: string | null;
  /** Resumen de compactación de Claude Code, también redactado. */
  compactSummary: string | null;
}

export type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tools'; lines: string[]; extra: number; redactions: number };

const HOME = homedir();
export const tilde = (s: string) => s.split(HOME).join('~');
const flatten = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
export const cut = (s: string, n: number) => {
  const flat = flatten(s);
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/**
 * Redacta y después recorta. Al revés, el corte puede partir una clave y dejar
 * un trozo que ya no reconoce ninguna regla. Todo texto del transcript que se
 * recorta pasa por aquí. Solo se redacta un prefijo acotado (`redactPrefix`):
 * una salida de herramienta de cientos de KB no puede bloquear el daemon.
 */
export function redactCut(s: string, n: number): { text: string; count: number } {
  const r = redactPrefix(flatten(s), n);
  return { text: cut(r.text, n), count: r.count };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_TOOL_LINES = 8;

/** Lee registros completos de los últimos `bytes` del archivo (descarta la primera línea parcial). */
async function readTail(path: string, bytes: number): Promise<{ records: Record<string, unknown>[]; fromStart: boolean }> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    const records: Record<string, unknown>[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o === 'object') records.push(o);
      } catch {
        // línea incompleta o corrupta
      }
    }
    return { records, fromStart: start === 0 };
  } finally {
    await fh.close();
  }
}

/** Una línea por herramienta, con lo que se muestra de su entrada ya redactado. */
export function toolLine(name: string, input: Record<string, unknown>): { line: string; redactions: number } {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  let redactions = 0;
  const clip = (v: string, n: number) => {
    const r = redactCut(v, n);
    redactions += r.count;
    return r.text;
  };
  const line = (() => {
    switch (name) {
      case 'Bash':
        return `Bash: ${clip(s('command'), 160)}`;
      case 'Read':
      case 'Edit':
      case 'Write':
      case 'MultiEdit':
        return `${name} ${tilde(s('file_path'))}`;
      case 'NotebookEdit':
        return `${name} ${tilde(s('notebook_path'))}`;
      case 'Grep':
      case 'Glob':
        return `${name} ${clip(s('pattern'), 80)}`;
      case 'WebFetch':
      case 'WebSearch':
        return `${name} ${clip(s('url') || s('query'), 100)}`;
      case 'Agent':
      case 'Task':
        return `${name}: ${clip(s('description') || s('prompt'), 100)}`;
      default:
        return name;
    }
  })();
  return { line, redactions };
}

/**
 * Recorre registros del transcript y se queda con lo legible: prompts, textos
 * del asistente, una línea por herramienta y solo los errores de sus salidas.
 * Lo usan el digest (cola del archivo) y el archivo local (archivo entero, en streaming).
 */
export class TranscriptCollector {
  items: Item[] = [];
  files: string[] = [];
  compact: string | null = null;
  private maxToolLines: number;

  constructor(opts: { maxToolLines?: number } = {}) {
    this.maxToolLines = opts.maxToolLines ?? MAX_TOOL_LINES;
  }

  private pushTool({ line, redactions }: { line: string; redactions: number }) {
    const last = this.items.at(-1);
    if (last?.kind === 'tools') {
      if (last.lines.length < this.maxToolLines) {
        last.lines.push(line);
        last.redactions += redactions;
      } else last.extra++;
    } else this.items.push({ kind: 'tools', lines: [line], extra: 0, redactions });
  }

  add(r: Record<string, unknown>): void {
    if (r.isSidechain === true) return;
    const msg = r.message as { content?: unknown } | undefined;
    const content = msg?.content;
    if (r.type === 'user') {
      if (r.isMeta === true) return;
      if (r.isCompactSummary === true) {
        const t = typeof content === 'string' ? content : '';
        if (t) this.compact = t;
        return;
      }
      const texts: string[] = [];
      if (typeof content === 'string') texts.push(content);
      else if (Array.isArray(content)) {
        for (const b of content as Record<string, unknown>[]) {
          if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
          // solo los errores de herramientas; las salidas normales se omiten
          if (b.type === 'tool_result' && b.is_error === true) {
            const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
            const r = redactCut(c, 200);
            this.pushTool({ line: `error: ${r.text}`, redactions: r.count });
          }
        }
      }
      if (texts.length) {
        const p = cleanPrompt(texts.join('\n'));
        if (p) this.items.push({ kind: 'user', text: p });
      }
    } else if (r.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as Record<string, unknown>[]) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          this.items.push({ kind: 'assistant', text: b.text });
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          const input = (b.input ?? {}) as Record<string, unknown>;
          this.pushTool(toolLine(b.name, input));
          const fp = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
          if (fp && EDIT_TOOLS.has(b.name) && !isSecretFile(fp)) this.files.push(tilde(fp));
        }
      }
    }
  }
}

function collect(records: Record<string, unknown>[]) {
  const c = new TranscriptCollector();
  for (const r of records) c.add(r);
  return { items: c.items, files: c.files, compact: c.compact };
}

const isInteraction = (i: Item) => i.kind !== 'tools';

/**
 * Digest de las últimas ~40 interacciones de una sesión. Lee desde el final
 * con ventanas crecientes (2 → 8 → 32 MB → archivo entero) porque hay
 * transcripts de más de 100 MB.
 */
export async function buildDigest(
  path: string,
  meta: { title?: string | null; project?: string | null; cwd?: string | null; firstPrompt?: string | null },
  opts: DigestOptions = {},
): Promise<Digest> {
  const want = opts.interactions ?? 40;
  const maxChars = opts.maxChars ?? 28_000;
  let got: ReturnType<typeof collect> = { items: [], files: [], compact: null };
  for (const mb of [2, 8, 32, Infinity]) {
    const { records, fromStart } = await readTail(path, mb === Infinity ? Number.MAX_SAFE_INTEGER : mb << 20);
    got = collect(records);
    if (fromStart || got.items.filter(isInteraction).length >= want) break;
  }

  // recorta a las últimas `want` interacciones (con sus herramientas)
  let seen = 0;
  let startIdx = 0;
  for (let i = got.items.length - 1; i >= 0; i--) {
    if (isInteraction(got.items[i]) && ++seen > want) {
      startIdx = i + 1;
      break;
    }
  }
  const items = got.items.slice(startIdx);

  // cada trozo se redacta antes de recortarlo; al final, otra pasada sobre todo (cabecera incluida)
  const render = (i: Item): { text: string; count: number } => {
    if (i.kind === 'tools') {
      const text = i.lines.map((l) => `  · ${l}`).join('\n') + (i.extra ? `\n  · (+${i.extra} acciones más)` : '');
      return { text, count: i.redactions };
    }
    const r = redactCut(i.text, i.kind === 'user' ? 1200 : 700);
    return { text: `${i.kind === 'user' ? 'USUARIO' : 'CLAUDE'}: ${r.text}`, count: r.count };
  };

  let pre = 0;
  const head: string[] = [];
  if (meta.title) head.push(`Título: ${meta.title}`);
  if (meta.project) head.push(`Proyecto: ${meta.project}`);
  if (meta.cwd) head.push(`Directorio del proyecto (las rutas bajo él son del proyecto): ${meta.cwd}`);
  if (meta.firstPrompt) {
    const r = redactCut(meta.firstPrompt, 1500);
    pre += r.count;
    head.push(`Primer mensaje (objetivo original): ${r.text}`);
  }
  const compact = got.compact ? redact(got.compact) : null;
  if (compact) {
    pre += compact.count;
    head.push(`Resumen de compactación anterior:\n${cut(compact.text, 2500)}`);
  }

  let body = items.map(render);
  const size = () => head.join('\n').length + body.map((b) => b.text).join('\n').length;
  while (body.length > 4 && size() > maxChars) body = body.slice(1);
  pre += body.reduce((n, b) => n + b.count, 0);

  const raw = `${head.join('\n')}\n\n--- Últimas interacciones ---\n${body.map((b) => b.text).join('\n')}`;
  const { text, count } = redact(tilde(raw));

  const lastUser = [...items].reverse().find((i) => i.kind === 'user') as { text: string } | undefined;
  const lastAsst = [...items].reverse().find((i) => i.kind === 'assistant') as { text: string } | undefined;
  return {
    text,
    redactions: pre + count,
    interactions: items.filter(isInteraction).length,
    filesTouched: [...new Set(got.files.reverse())],
    lastUserPrompt: lastUser ? redactCut(lastUser.text, 300).text : null,
    lastAssistantText: lastAsst ? redactCut(lastAsst.text, 300).text : null,
    compactSummary: compact ? compact.text : null,
  };
}

/**
 * Digest a partir de la copia local (archive/<id>.txt.gz) cuando Claude Code
 * ya borró el transcript. La copia ya está filtrada y redactada; se vuelve a
 * redactar por si cambiaron las reglas. Se queda con el final, cortando por línea.
 */
export function digestFromArchive(
  archiveText: string,
  meta: { title?: string | null; project?: string | null; cwd?: string | null; firstPrompt?: string | null },
  opts: DigestOptions = {},
): Digest {
  const maxChars = opts.maxChars ?? 28_000;
  const body = archiveText.slice(archiveText.indexOf('\n\n') + 2);
  const lines = body.split('\n');
  const tail: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && size + lines[i].length < maxChars - 3000; i--) {
    tail.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  const head: string[] = [];
  if (meta.title) head.push(`Título: ${meta.title}`);
  if (meta.project) head.push(`Proyecto: ${meta.project}`);
  if (meta.cwd) head.push(`Directorio del proyecto (las rutas bajo él son del proyecto): ${meta.cwd}`);
  if (meta.firstPrompt) head.push(`Primer mensaje (objetivo original): ${redactCut(meta.firstPrompt, 1500).text}`);
  const { text, count } = redact(tilde(`${head.join('\n')}\n\n--- Últimas interacciones (copia local) ---\n${tail.join('\n')}`));

  const files: string[] = [];
  for (const l of tail) {
    const m = l.match(/^\s+· (?:Edit|Write|MultiEdit|NotebookEdit) (.+)$/);
    if (m && !isSecretFile(m[1])) files.push(m[1]);
  }
  const last = (prefix: string) => {
    const l = [...tail].reverse().find((x) => x.startsWith(prefix));
    return l ? redactCut(l.slice(prefix.length), 300).text : null;
  };
  return {
    text,
    redactions: count,
    interactions: tail.filter((l) => l.startsWith('USUARIO: ') || l.startsWith('CLAUDE: ')).length,
    filesTouched: [...new Set(files.reverse())],
    lastUserPrompt: last('USUARIO: '),
    lastAssistantText: last('CLAUDE: '),
    compactSummary: null,
  };
}
