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

export type { EmbeddingProvider } from './types.js';
export { InProcessEmbeddingProvider } from './in-process.js';

let activeProvider: EmbeddingProvider | null = null;
let ready = false;
let initStarted = false;

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
  // injectable for tests / future provider selection
  provider: EmbeddingProvider = new InProcessEmbeddingProvider(),
): void {
  if (initStarted) return;
  initStarted = true;
  if (process.env.PINLOOM_EMBEDDINGS === 'off') return;
  void (async () => {
    try {
      // Forcing one query embed loads + initializes the model.
      await provider.embedQuery('warmup');
      activeProvider = provider;
      ready = true;
    } catch (err) {
      // Degrade silently to FTS-only; never crash the backend.
      // eslint-disable-next-line no-console
      console.error(
        '[embeddings] warmup failed — search stays lexical-only:',
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/** Test-only: reset module state between cases. */
export function __resetEmbeddingsForTest(): void {
  activeProvider = null;
  ready = false;
  initStarted = false;
}
