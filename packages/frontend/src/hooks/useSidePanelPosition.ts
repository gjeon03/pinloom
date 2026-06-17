import { useSyncExternalStore } from 'react';

// Which edge the session side rail (TerminalSidePanel) docks to. A single
// global preference — the wrapper in dock/panels.tsx and the panel itself both
// read it, so changing it must re-render both. Backed by localStorage + a
// window event (same shape as the width preference, but shared cross-component).
export type SidePanelPosition = 'right' | 'left' | 'top' | 'bottom';

const KEY = 'pinloom:termpanel:position';
const EVENT = 'pinloom:termpanel-position-changed';

function read(): SidePanelPosition {
  const v = localStorage.getItem(KEY);
  return v === 'left' || v === 'right' || v === 'top' || v === 'bottom'
    ? v
    : 'right';
}

let current: SidePanelPosition = read();

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

function getSnapshot(): SidePanelPosition {
  return current;
}

export function setSidePanelPosition(next: SidePanelPosition): void {
  if (next === current) return;
  current = next;
  localStorage.setItem(KEY, next);
  window.dispatchEvent(new Event(EVENT));
}

export function useSidePanelPosition(): SidePanelPosition {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Left/right rails are vertical columns sized by width; top/bottom are
 *  horizontal slabs sized by height. */
export function isVerticalRail(p: SidePanelPosition): boolean {
  return p === 'left' || p === 'right';
}
