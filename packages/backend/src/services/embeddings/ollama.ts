// Ollama embedding provider — the opt-in "2차" backend behind the same
// EmbeddingProvider interface (knowledge-system-v3 §4 / Phase 1 fast-follow).
// Default stays the zero-setup in-process model; selecting Ollama (a local
// `bge-m3`/`nomic-embed-text`/… server) trades a one-time `ollama pull` for
// stronger embeddings, especially on Korean.
//
// Pluggable + degrade-safe: if the Ollama server is unreachable, warmup throws
// and the embeddings manager leaves the system FTS-only (it never crashes a
// request). Switching backends changes the model id (and usually the dim), which
// the indexers' ensureSchema detects → rebuild + re-embed automatically.
//
// Unlike e5, modern retrieval models (bge-m3) don't use asymmetric query/passage
// prefixes, so we send raw text. The `dim` is discovered from the first response
// (it depends on the model) rather than hard-coded.

import type { EmbeddingProvider } from './types.js';

type FetchLike = typeof fetch;

// Cap each input's length before sending. Ollama HARD-rejects inputs over the
// model's context window with a 400 ("input length exceeds the context length")
// — and one oversized message (a long tool dump / transcript) would otherwise
// throw the whole index pass every sweep, starving ALL corpora (the bug that
// left the wiki graph empty). The in-process e5 model silently truncates to 512
// tokens, so capping here is parity, not a regression. Default 4000 chars stays
// safely under bge-m3's 8192-token window even for dense Korean (xlm-roberta can
// run ~1.5–2 tokens/char on CJK) while still giving it ~8× what e5 ever saw.
// Override with PINLOOM_OLLAMA_MAX_CHARS for English-heavy corpora + bigger ctx.
function maxInputChars(): number {
  const n = Number(process.env.PINLOOM_OLLAMA_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? n : 4000;
}

export interface OllamaConfig {
  baseUrl?: string;
  model?: string;
  /** Injectable for tests — defaults to global fetch. */
  fetchImpl?: FetchLike;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly doFetch: FetchLike;
  private _dim = 0;

  constructor(cfg: OllamaConfig = {}) {
    this.baseUrl = (cfg.baseUrl ?? process.env.PINLOOM_OLLAMA_URL ?? 'http://localhost:11434')
      .replace(/\/$/, '');
    this.model = cfg.model ?? process.env.PINLOOM_OLLAMA_MODEL ?? 'bge-m3';
    this.doFetch = cfg.fetchImpl ?? fetch;
    this.id = `ollama:${this.model}`;
  }

  /** 0 until the first successful embed; vectors are only created after warmup
   *  (embedQuery) succeeds, so the indexers always read the real width. */
  get dim(): number {
    return this._dim;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return (await this.embed([text]))[0];
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return this.embed(texts);
  }

  private async embed(inputs: string[]): Promise<Float32Array[]> {
    const cap = maxInputChars();
    const clipped = inputs.map((t) => (t.length > cap ? t.slice(0, cap) : t));
    const res = await this.doFetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: clipped }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ollama embed ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as OllamaEmbedResponse;
    if (!data.embeddings || data.embeddings.length !== inputs.length) {
      throw new Error(`ollama embed: expected ${inputs.length} vectors, got ${data.embeddings?.length}`);
    }
    const out = data.embeddings.map((e) => Float32Array.from(e));
    if (this._dim === 0 && out[0]) this._dim = out[0].length;
    return out;
  }
}
