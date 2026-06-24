// Embedding provider — the one job is text → vector (the "R" of in-process RAG;
// see docs/knowledge-system-v3.md §4, §11). Pluggable: the default is an
// in-process model (zero setup); an Ollama adapter is a fast-follow behind this
// same interface. When no provider is available, callers degrade to lexical FTS.
//
// e5-family models are ASYMMETRIC: documents are embedded with a "passage:"
// prefix and queries with "query:". The interface bakes that distinction in so a
// caller can't accidentally embed a stored doc as a query (which would silently
// hurt ranking — the prefixes matter, see the spike's thin margin).

export interface EmbeddingProvider {
  /** Stable id, e.g. `inproc:multilingual-e5-small`. Persisted with the vectors
   *  so a model change can trigger an explicit re-embed. */
  readonly id: string;
  /** Output dimension (must match the vec0 column width). */
  readonly dim: number;
  /** Embed a search query. */
  embedQuery(text: string): Promise<Float32Array>;
  /** Embed stored documents (messages / wiki / timeline). */
  embedPassages(texts: string[]): Promise<Float32Array[]>;
}
