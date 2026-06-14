// Dock layout plumbing: panel-id convention, layout persistence
// (pinloom:layout:<projectId> = DockviewApi.toJSON()), the legacy-key
// migration reader, and reconcileLayout — the dockview successor to the old
// reconcileOrder (close panels whose target died out-of-band, add panels for
// targets created out-of-band, e.g. an MCP-spawned worker session).

import type { DockviewApi, SerializedDockview } from 'dockview-react';

export type PanelKind = 'session' | 'canvas' | 'notepad';

export interface TabRef {
  kind: PanelKind;
  id: string;
}

export interface InlineCanvasTab {
  teamId: string;
  teamName: string;
}

// Panel ids embed the kind so a session id colliding with a teamId can never
// confuse the strip — same reasoning as the old `kind:id` drag keys.
export function panelId(kind: PanelKind, id: string): string {
  return `${kind}:${id}`;
}

export function parsePanelId(id: string): TabRef | null {
  const sep = id.indexOf(':');
  if (sep === -1) return null;
  const kind = id.slice(0, sep);
  if (kind !== 'session' && kind !== 'canvas' && kind !== 'notepad') {
    return null;
  }
  const rest = id.slice(sep + 1);
  if (!rest) return null;
  return { kind, id: rest };
}

const layoutKey = (projectId: string) => `pinloom:layout:${projectId}`;

export function loadLayout(projectId: string): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(layoutKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SerializedDockview;
    // Cheap shape check — a corrupt entry should fall through to the
    // migration builder instead of throwing inside fromJSON.
    if (!parsed || typeof parsed !== 'object' || !('grid' in parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveLayout(projectId: string, data: SerializedDockview): void {
  try {
    localStorage.setItem(layoutKey(projectId), JSON.stringify(data));
  } catch {
    // localStorage may be unavailable (private mode, quota); the layout
    // still works for this session, just won't survive reload.
  }
}

export interface LegacyState {
  order: TabRef[] | null;
  lastSessionId: string | null;
  lastCanvasId: string | null;
  lastNotepadId: string | null;
}

// First-mount migration source: the pre-dockview strip persisted a unified
// TabRef order plus three "last active" keys. We read (never write) them so
// existing users keep their tab order + active tab across the cutover. The
// keys are intentionally left in place — they make rolling back to the old
// strip non-destructive.
export function loadLegacyState(projectId: string): LegacyState {
  let order: TabRef[] | null = null;
  try {
    const raw = localStorage.getItem(`pinloom:tabOrder:${projectId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        order = parsed.filter(
          (t): t is TabRef =>
            t &&
            typeof t === 'object' &&
            (t.kind === 'session' || t.kind === 'canvas' || t.kind === 'notepad') &&
            typeof t.id === 'string',
        );
      }
    }
  } catch {
    order = null;
  }
  const read = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  return {
    order,
    lastSessionId: read(`pinloom:lastSession:${projectId}`),
    lastCanvasId: read(`pinloom:lastCanvas:${projectId}`),
    lastNotepadId: read(`pinloom:lastNotepad:${projectId}`),
  };
}

// Reconcile a persisted/legacy order against the live item sets: drop refs
// whose targets no longer exist, append newcomers at the tail in source-array
// order. Lifted from the old ProjectPage.reconcileOrder.
export function reconcileOrder(
  persisted: TabRef[] | null,
  sessionIds: string[],
  canvasIds: string[],
  notepadIds: string[],
): TabRef[] {
  const sets: Record<PanelKind, Set<string>> = {
    session: new Set(sessionIds),
    canvas: new Set(canvasIds),
    notepad: new Set(notepadIds),
  };
  const seen = new Set<string>();
  const out: TabRef[] = [];
  for (const ref of persisted ?? []) {
    if (!ref || typeof ref !== 'object') continue;
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key) || !sets[ref.kind]?.has(ref.id)) continue;
    out.push(ref);
    seen.add(key);
  }
  const appendMissing = (kind: PanelKind, ids: string[]) => {
    for (const id of ids) {
      const key = `${kind}:${id}`;
      if (!seen.has(key)) {
        out.push({ kind, id });
        seen.add(key);
      }
    }
  };
  appendMissing('session', sessionIds);
  appendMissing('canvas', canvasIds);
  appendMissing('notepad', notepadIds);
  return out;
}

// After a fromJSON restore, bring the dock back in sync with reality:
//  - close panels whose target was deleted while we were away
//  - add panels (inactive, appended) for targets with no panel yet
// Returns the refs that were newly added so the caller can decide whether one
// of them deserves activation (e.g. a just-moved-in session).
export function reconcileLayout(
  api: DockviewApi,
  sessionIds: string[],
  canvasIds: string[],
  notepadIds: string[],
  addMissing: (ref: TabRef) => void,
): TabRef[] {
  const sets: Record<PanelKind, Set<string>> = {
    session: new Set(sessionIds),
    canvas: new Set(canvasIds),
    notepad: new Set(notepadIds),
  };
  const present = new Set<string>();
  for (const panel of [...api.panels]) {
    const ref = parsePanelId(panel.id);
    if (!ref) continue;
    if (!sets[ref.kind].has(ref.id) || present.has(panel.id)) {
      // Dead target (deleted out-of-band) or a duplicate id from a
      // corrupt layout — drop the panel.
      api.removePanel(panel);
      continue;
    }
    present.add(panel.id);
  }
  const added: TabRef[] = [];
  const addAll = (kind: PanelKind, ids: string[]) => {
    for (const id of ids) {
      if (!present.has(panelId(kind, id))) {
        const ref: TabRef = { kind, id };
        addMissing(ref);
        added.push(ref);
      }
    }
  };
  addAll('session', sessionIds);
  addAll('canvas', canvasIds);
  addAll('notepad', notepadIds);
  return added;
}
