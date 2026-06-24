// In-process embedding provider — runs a small multilingual model inside the
// backend via transformers.js (onnxruntime-node). Zero external setup; fully
// local. Spike-verified: ~2.6ms/embed after warmup, event-loop lag < 2ms (the
// native runtime offloads matmuls off the JS thread), so no worker_thread is
// needed (docs/knowledge-system-v3.md §11).
//
// The actual model call is behind an injectable `RawEmbed` seam so the
// prefix/cap/normalize logic is unit-testable without loading the ~120MB model.

import os from 'node:os';
import path from 'node:path';
import type { EmbeddingProvider } from './types.js';

const MODEL = 'Xenova/multilingual-e5-small';
const MODEL_DIM = 384;
// e5 handles ~512 tokens; cap chars so a giant message can't blow tokenization.
const MAX_CHARS = 2000;

// text -> normalized embedding. The default loads transformers.js lazily.
export type RawEmbed = (text: string) => Promise<Float32Array>;

function cap(text: string): string {
  const t = text ?? '';
  return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) : t;
}

// Lazily build the real transformers.js extractor ONCE per process. Heavy: the
// first call downloads the model into ~/.pinloom/models (a controlled cache) and
// initializes onnxruntime. Callers must invoke this off the request hot path
// (the manager warms it in the background); until it resolves, search degrades
// to FTS.
let extractorPromise: Promise<RawEmbed> | null = null;
function defaultRawEmbed(): Promise<RawEmbed> {
  if (extractorPromise) return extractorPromise;
  extractorPromise = (async () => {
    const tf = (await import('@huggingface/transformers')) as unknown as {
      pipeline: (task: string, model: string) => Promise<
        (text: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array }>
      >;
      env: { cacheDir?: string; allowRemoteModels?: boolean };
    };
    // Keep models in a user-controlled, persistent cache (survives restarts).
    tf.env.cacheDir = path.join(os.homedir(), '.pinloom', 'models');
    const extractor = await tf.pipeline('feature-extraction', MODEL);
    return async (text: string) => {
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      return out.data;
    };
  })().catch((err) => {
    // Reset so a transient failure (e.g. offline) can be retried on next warmup.
    extractorPromise = null;
    throw err;
  });
  return extractorPromise;
}

export class InProcessEmbeddingProvider implements EmbeddingProvider {
  readonly id = `inproc:${MODEL.split('/').pop()}`;
  readonly dim = MODEL_DIM;

  // `rawEmbed` is injectable for tests; production uses the lazy default.
  constructor(private readonly rawEmbed?: RawEmbed) {}

  private embed(): Promise<RawEmbed> {
    return this.rawEmbed ? Promise.resolve(this.rawEmbed) : defaultRawEmbed();
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const embed = await this.embed();
    return embed(`query: ${cap(text)}`);
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const embed = await this.embed();
    // Sequential (not Promise.all) so a large backfill batch can't spike memory
    // by holding every intermediate tensor at once; each embed is ~2.6ms.
    const out: Float32Array[] = [];
    for (const t of texts) {
      out.push(await embed(`passage: ${cap(t)}`));
    }
    return out;
  }
}
