import { open } from 'node:fs/promises';

export interface ReadResult {
  /** Offset del byte siguiente a la última línea completa procesada. */
  endOffset: number;
  /** Líneas que no eran JSON válido (se saltan, no rompen el scan). */
  badLines: number;
}

const CHUNK = 1 << 20; // 1 MiB

/**
 * Lee un JSONL en streaming desde `startOffset` y llama a `onRecord` por cada
 * objeto JSON. Una línea final sin '\n' se considera incompleta (Claude Code
 * puede estar escribiéndola) y no se consume: endOffset queda antes de ella.
 */
export async function readJsonl(
  path: string,
  startOffset: number,
  onRecord: (rec: Record<string, unknown>) => void,
): Promise<ReadResult> {
  const fh = await open(path, 'r');
  let badLines = 0;
  let consumed = startOffset;
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let pos = startOffset;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      let chunk = buf.subarray(0, bytesRead);
      let nl = chunk.indexOf(10);
      while (nl !== -1) {
        const piece = chunk.subarray(0, nl);
        const line = pendingLen
          ? Buffer.concat([...pending, piece], pendingLen + piece.length)
          : piece;
        pending = [];
        pendingLen = 0;
        consumed += line.length + 1;
        if (line.length > 0) {
          let rec: unknown;
          try {
            rec = JSON.parse(line.toString('utf8'));
          } catch {
            badLines++;
            rec = undefined;
          }
          if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
            onRecord(rec as Record<string, unknown>);
          }
        }
        chunk = chunk.subarray(nl + 1);
        nl = chunk.indexOf(10);
      }
      if (chunk.length) {
        // copia: `buf` se reutiliza en la siguiente lectura
        pending.push(Buffer.from(chunk));
        pendingLen += chunk.length;
      }
    }
  } finally {
    await fh.close();
  }
  return { endOffset: consumed, badLines };
}
