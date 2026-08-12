/**
 * Bounded PTY scrollback.
 *
 * The naive form — `buffer = (buffer + chunk).slice(-LIMIT)` — allocates and
 * discards two LIMIT-sized strings on EVERY pty data event, so cost per chunk
 * is O(LIMIT) no matter how small the chunk. A TUI that repaints its whole
 * screen (codex does this constantly) emits hundreds of chunks a second, which
 * pins the backend's event loop in String::NewFromUtf8 + young-gen GC — and
 * since one backend process relays every session's pty, a single chatty agent
 * starves the keystroke echo and output streaming of all the others.
 *
 * Instead we keep a byte-counted chunk queue. Overflow discards from its head,
 * so each chunk is visited at most once before it leaves the buffer; joining is
 * deferred until a client needs a snapshot.
 */
export interface Scrollback {
  /** Append a pty chunk. */
  push(chunk: string): void;
  /** Trimmed scrollback to replay into a freshly attached client. */
  snapshot(): string;
}

interface ScrollbackChunk {
  bytes: Buffer;
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function codePointBytes(byte: number): number {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

/** Keep the largest valid UTF-8 suffix that fits in `maxBytes`. */
function tailWithinBytes(bytes: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  if (bytes.length <= maxBytes) return bytes;

  let start = bytes.length - maxBytes;
  while (start < bytes.length) {
    while (start < bytes.length && isContinuationByte(bytes[start])) start++;
    if (bytes.length - start <= maxBytes) break;
    start += codePointBytes(bytes[start]);
  }
  return bytes.subarray(start);
}

export function createScrollback(maxBytes: number): Scrollback {
  // Fully evicted entries are nulled immediately; `head` alone would leave
  // their Buffer payloads reachable until a later array compaction.
  let chunks: Array<ScrollbackChunk | null> = [];
  let head = 0;
  let byteLength = 0;

  const compactHead = (): void => {
    if (head > 0 && head * 2 >= chunks.length) {
      chunks = chunks.slice(head);
      head = 0;
    }
  };

  const trim = (): void => {
    let overflow = byteLength - maxBytes;
    while (overflow > 0 && head < chunks.length) {
      const chunk = chunks[head];
      if (!chunk) {
        head++;
        continue;
      }
      if (overflow >= chunk.bytes.length) {
        overflow -= chunk.bytes.length;
        byteLength -= chunk.bytes.length;
        chunks[head] = null;
        head++;
        continue;
      }
      // `subarray()` shares its source backing store; copy the partial tail so
      // the evicted prefix does not keep the original chunk allocation alive.
      const tail = Buffer.from(tailWithinBytes(chunk.bytes, chunk.bytes.length - overflow));
      byteLength -= chunk.bytes.length - tail.length;
      chunks[head] = { bytes: tail };
      overflow = 0;
    }
    compactHead();
  };

  return {
    push(chunk: string): void {
      if (chunk.length === 0) return;
      const bytes = Buffer.from(chunk);
      if (bytes.length === 0 || maxBytes <= 0) return;
      const bounded = bytes.length > maxBytes
        ? Buffer.from(tailWithinBytes(bytes, maxBytes))
        : bytes;
      chunks.push({ bytes: bounded });
      byteLength += bounded.length;
      if (byteLength > maxBytes) trim();
    },
    snapshot(): string {
      if (head >= chunks.length) return '';
      if (head === chunks.length - 1) return chunks[head]?.bytes.toString('utf8') ?? '';
      return chunks.slice(head).map((chunk) => chunk?.bytes.toString('utf8') ?? '').join('');
    },
  };
}
