// Ollama admin helpers — detect a local server + its models, and pull a model
// with progress, so the Settings UI can manage the Ollama backend without the
// user touching a terminal. Separate from the provider (ollama.ts) which only
// embeds. Everything is best-effort: a down server just reports `running:false`.

type FetchLike = typeof fetch;

function baseUrl(): string {
  return (process.env.PINLOOM_OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
}

export interface OllamaStatus {
  running: boolean;
  models: string[]; // installed model names (e.g. "bge-m3:latest")
}

/** Probe the local Ollama server (GET /api/tags). Never throws. */
export async function ollamaStatus(fetchImpl: FetchLike = fetch): Promise<OllamaStatus> {
  try {
    const res = await fetchImpl(`${baseUrl()}/api/tags`, { method: 'GET' });
    if (!res.ok) return { running: false, models: [] };
    const data = (await res.json()) as { models?: { name: string }[] };
    return { running: true, models: (data.models ?? []).map((m) => m.name) };
  } catch {
    return { running: false, models: [] };
  }
}

/** True if `model` (or `model:latest`) is already pulled. */
export function hasModel(status: OllamaStatus, model: string): boolean {
  const want = model.includes(':') ? model : `${model}:latest`;
  return status.models.some((m) => m === model || m === want);
}

// ---- background pull job (one at a time), polled by the Settings UI ----

export interface PullJob {
  pulling: boolean;
  model: string;
  status: string; // Ollama's status line ("pulling manifest", "downloading", …)
  completed: number;
  total: number;
  done: boolean;
  error: string | null;
}

let job: PullJob = {
  pulling: false,
  model: '',
  status: '',
  completed: 0,
  total: 0,
  done: false,
  error: null,
};

export function pullStatus(): PullJob {
  return job;
}

/** Start pulling `model` in the background. Returns false if one is already
 *  running. Consumes Ollama's NDJSON progress stream into the in-memory job. */
export function startPull(model: string, fetchImpl: FetchLike = fetch): boolean {
  if (job.pulling) return false;
  job = { pulling: true, model, status: 'starting', completed: 0, total: 0, done: false, error: null };
  void (async () => {
    try {
      const res = await fetchImpl(`${baseUrl()}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
      });
      if (!res.ok || !res.body) {
        job = { ...job, pulling: false, error: `ollama pull ${res.status}`, done: false };
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line) as {
              status?: string;
              completed?: number;
              total?: number;
              error?: string;
            };
            if (ev.error) {
              job = { ...job, pulling: false, error: ev.error };
              return;
            }
            job = {
              ...job,
              status: ev.status ?? job.status,
              completed: ev.completed ?? job.completed,
              total: ev.total ?? job.total,
            };
          } catch {
            // ignore a partial / non-JSON line
          }
        }
      }
      job = { ...job, pulling: false, done: !job.error };
    } catch (err) {
      job = { ...job, pulling: false, error: err instanceof Error ? err.message : String(err) };
    }
  })();
  return true;
}

/** Test-only reset. */
export function __resetPullForTest(): void {
  job = { pulling: false, model: '', status: '', completed: 0, total: 0, done: false, error: null };
}
