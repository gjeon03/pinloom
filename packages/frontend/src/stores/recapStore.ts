import { useSyncExternalStore } from 'react';

// Module-level store so Recap results + in-flight state survive navigating away
// and back (RecapPage unmounts on route change). The async ask/generate update
// THIS store, not component state, so a long LLM call that finishes while the
// page is unmounted still lands its result — and is shown on return.

export type AskResult = {
  answer: string;
  sources: {
    n: number;
    messageId: string;
    sessionId: string;
    sessionTitle: string | null;
    projectName: string;
    createdAt: string;
  }[];
} | null;

export type Lang = 'ko' | 'en';

function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function loadLang(key: string, fallback: Lang): Lang {
  try {
    const v = localStorage.getItem(key);
    return v === 'en' || v === 'ko' ? v : fallback;
  } catch {
    return fallback;
  }
}

export interface RecapState {
  // ask
  question: string;
  askProject: string;
  askLang: Lang;
  asking: boolean;
  askResult: AskResult;
  // generate
  kind: 'portfolio' | 'resume';
  from: string;
  to: string;
  genProject: string;
  genLang: Lang;
  generating: boolean;
  genResult: string | null; // markdown, '__EMPTY__', or null
}

let state: RecapState = {
  question: '',
  askProject: '',
  askLang: loadLang('pinloom:recap:askLang', 'ko'),
  asking: false,
  askResult: null,
  kind: 'portfolio',
  from: monthsAgo(3),
  to: today(),
  genProject: '',
  genLang: loadLang('pinloom:recap:genLang', 'en'), // generated artifacts default to English
  generating: false,
  genResult: null,
};

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

export function setRecap(patch: Partial<RecapState>): void {
  state = { ...state, ...patch };
  if (patch.askLang) {
    try {
      localStorage.setItem('pinloom:recap:askLang', patch.askLang);
    } catch {
      // ignore
    }
  }
  if (patch.genLang) {
    try {
      localStorage.setItem('pinloom:recap:genLang', patch.genLang);
    } catch {
      // ignore
    }
  }
  emit();
}

export function useRecapStore(): RecapState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
