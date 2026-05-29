import type { FastifyInstance } from 'fastify';
import { getSetting, setSetting } from '../services/app-settings.js';

// A single global scratchpad, stored in app_settings so it rides along the
// sqlite DB (per-project notes are a separate future feature). Stored as a
// structured JSON document: one or more tabs, each holding vertically-split
// panes of independent text. Legacy plain-text notes (the old
// `notepad.content` key) migrate into the first tab/pane on first read.
const DOC_KEY = 'notepad.doc';
const LEGACY_KEY = 'notepad.content';

interface NotepadPane {
  id: string;
  content: string;
  height: number;
}
interface NotepadTab {
  id: string;
  name: string;
  panes: NotepadPane[];
}
interface NotepadDoc {
  tabs: NotepadTab[];
  activeTabId: string;
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function emptyDoc(initialContent = ''): NotepadDoc {
  const tab: NotepadTab = {
    id: makeId(),
    name: 'Note',
    panes: [{ id: makeId(), content: initialContent, height: 200 }],
  };
  return { tabs: [tab], activeTabId: tab.id };
}

// Notes are plain text — cap the body well below the global 100MB limit and
// bound tab/pane counts so a buggy or untrusted client can't bloat the row.
const NOTEPAD_BODY_LIMIT = 4 * 1024 * 1024;
const MAX_TABS = 200;
const MAX_PANES_PER_TAB = 200;

function isValidDoc(value: unknown): value is NotepadDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Record<string, unknown>;
  if (typeof doc.activeTabId !== 'string') return false;
  if (!Array.isArray(doc.tabs) || doc.tabs.length === 0) return false;
  if (doc.tabs.length > MAX_TABS) return false;
  return doc.tabs.every((t) => {
    if (!t || typeof t !== 'object') return false;
    const tab = t as Record<string, unknown>;
    if (typeof tab.id !== 'string' || typeof tab.name !== 'string') return false;
    if (!Array.isArray(tab.panes) || tab.panes.length === 0) return false;
    if (tab.panes.length > MAX_PANES_PER_TAB) return false;
    return tab.panes.every((p) => {
      if (!p || typeof p !== 'object') return false;
      const pane = p as Record<string, unknown>;
      return (
        typeof pane.id === 'string' &&
        typeof pane.content === 'string' &&
        typeof pane.height === 'number'
      );
    });
  });
}

function loadDoc(): NotepadDoc {
  const raw = getSetting(DOC_KEY);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isValidDoc(parsed)) return parsed;
    } catch {
      // fall through to migration
    }
  }
  // First read (or corrupt doc): migrate the legacy plain-text note, if any,
  // and persist so subsequent reads are stable.
  const legacy = getSetting(LEGACY_KEY) ?? '';
  const doc = emptyDoc(legacy);
  setSetting(DOC_KEY, JSON.stringify(doc));
  return doc;
}

export async function notepadRoutes(app: FastifyInstance) {
  app.get('/api/notepad', async () => {
    return { doc: loadDoc() };
  });

  app.put<{ Body: { doc?: unknown } }>(
    '/api/notepad',
    { bodyLimit: NOTEPAD_BODY_LIMIT },
    async (req, reply) => {
      const doc = req.body?.doc;
      if (!isValidDoc(doc)) {
        reply.code(400);
        return { error: 'doc must be a valid notepad document' };
      }
      setSetting(DOC_KEY, JSON.stringify(doc));
      return { ok: true as const };
    },
  );
}
