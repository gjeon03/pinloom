// Embedding provider manager. Owns the single active provider and its readiness.
//
// Readiness gates degradation: getEmbeddingProvider() returns the provider ONLY
// after a background warmup has succeeded, so search/indexing transparently fall
// back to lexical FTS while the model is loading (or forever, if it can't load —
// e.g. offline first run, missing native addon). Nothing here ever throws into a
// request path; a warmup failure just leaves the system FTS-only.
//
// initEmbeddings() is called once at backend startup (wired in Phase 1-B). It is
// non-blocking: the heavy model load happens in the background.

import type { EmbeddingProvider } from './types.js';
import { InProcessEmbeddingProvider } from './in-process.js';
import { OllamaEmbeddingProvider } from './ollama.js';
import { getSetting } from '../app-settings.js';

export type { EmbeddingProvider } from './types.js';
export { InProcessEmbeddingProvider } from './in-process.js';
export { OllamaEmbeddingProvider } from './ollama.js';

export type EmbeddingsMode = 'in-process' | 'ollama' | 'off';
export const EMBEDDINGS_BACKEND_KEY = 'embeddings.backend';
export const EMBEDDINGS_OLLAMA_MODEL_KEY = 'embeddings.ollama.model';

let activeProvider: EmbeddingProvider | null = null;
let ready = false;
let initStarted = false;

/** Effective backend: persisted setting wins, else env, else in-process. */
export function resolveEmbeddingsMode(): EmbeddingsMode {
  const s = getSetting(EMBEDDINGS_BACKEND_KEY);
  if (s === 'in-process' || s === 'ollama' || s === 'off') return s;
  const e = process.env.PINLOOM_EMBEDDINGS;
  if (e === 'off') return 'off';
  if (e === 'ollama') return 'ollama';
  return 'in-process';
}

export function resolveOllamaModel(): string {
  return getSetting(EMBEDDINGS_OLLAMA_MODEL_KEY) ?? process.env.PINLOOM_OLLAMA_MODEL ?? 'bge-m3';
}

function buildProvider(mode: EmbeddingsMode): EmbeddingProvider | null {
  if (mode === 'off') return null;
  if (mode === 'ollama') return new OllamaEmbeddingProvider({ model: resolveOllamaModel() });
  return new InProcessEmbeddingProvider();
}

/** The active provider once warm, else null (caller degrades to FTS). */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  return ready ? activeProvider : null;
}

/** True once a provider has warmed up and can serve vectors. */
export function embeddingsReady(): boolean {
  return ready;
}

/**
 * Start (idempotently) warming the configured provider in the background.
 * Off when PINLOOM_EMBEDDINGS=off. Resolves immediately; readiness flips later.
 */
export function initEmbeddings(
  // injectable for tests; otherwise the backend is resolved from the persisted
  // setting / env (`off` | `ollama` | in-process default).
  provider?: EmbeddingProvider,
): void {
  if (initStarted) return;
  initStarted = true;
  const mode = resolveEmbeddingsMode();
  if (mode === 'off') return; // disabled even if a provider was injected
  const p = provider ?? buildProvider(mode);
  if (!p) return;
  void (async () => {
    try {
      // Forcing one query embed loads + initializes the model (and, for Ollama,
      // verifies the server is reachable + discovers the dim).
      await p.embedQuery('warmup');
      activeProvider = p;
      ready = true;
    } catch (err) {
      // Degrade silently to FTS-only; never crash the backend.
      // eslint-disable-next-line no-console
      console.error(
        `[embeddings] warmup failed (${p.id}) — search stays lexical-only:`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/** Active embedding backend for diagnostics / Settings. */
export function embeddingsStatus(): {
  mode: EmbeddingsMode;
  ready: boolean;
  id: string | null;
  ollamaModel: string;
} {
  return {
    mode: resolveEmbeddingsMode(),
    ready,
    id: activeProvider?.id ?? null,
    ollamaModel: resolveOllamaModel(),
  };
}

/** Tear down the active provider so the next initEmbeddings() picks the newly
 *  selected backend (used by the live Settings switch). The caller must also
 *  stop/restart the indexer so its schema re-resolves the new model/dim. */
export function resetEmbeddings(): void {
  activeProvider = null;
  ready = false;
  initStarted = false;
}

/** Test-only: reset module state between cases. */
export const __resetEmbeddingsForTest = resetEmbeddings;
