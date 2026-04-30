import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, type WikiAnalysisLogEntry } from '../api/client.js';

export type NotificationKind = 'wiki-sync' | 'wiki-analyze' | 'generic';
export type NotificationStatus = 'running' | 'success' | 'error';

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  status: NotificationStatus;
  title: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  read: boolean;
  meta?: {
    sessionId?: string;
    sessionTitle?: string | null;
    projectId?: string;
    projectName?: string | null;
  };
}

interface StartArgs {
  id?: string;
  kind: NotificationKind;
  title: string;
  meta?: NotificationItem['meta'];
}

interface NotificationContextValue {
  items: NotificationItem[];
  start(args: StartArgs): string;
  resolve(id: string, detail?: string): void;
  fail(id: string, error: string): void;
  dismiss(id: string): void;
  markRead(id: string): void;
  markAllRead(): void;
  clearFinished(): void;
  runningCount: number;
  unreadCount: number;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const MAX_HISTORY = 50;

// Deterministic id derived from the backend log entry. Same projectId +
// startedAt always maps to the same notification, so reload + initial
// trigger reconcile rather than duplicate.
export function analyzeNotificationId(entry: {
  projectId: string;
  startedAt: string;
}): string {
  return `analyze:${entry.projectId}:${entry.startedAt}`;
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const counter = useRef(0);

  const start = useCallback((args: StartArgs): string => {
    counter.current += 1;
    const id = args.id ?? `n-${Date.now()}-${counter.current}`;
    setItems((prev) => {
      // If a notification with this explicit id already exists, leave it
      // alone so the rehydration path can keep consistent state.
      if (prev.some((it) => it.id === id)) return prev;
      const item: NotificationItem = {
        id,
        kind: args.kind,
        status: 'running',
        title: args.title,
        meta: args.meta,
        startedAt: Date.now(),
        read: false,
      };
      return [item, ...prev].slice(0, MAX_HISTORY);
    });
    return id;
  }, []);

  const resolve = useCallback((id: string, detail?: string) => {
    setItems((prev) =>
      prev.map((it) =>
        it.id === id
          ? { ...it, status: 'success', finishedAt: Date.now(), detail, read: false }
          : it,
      ),
    );
  }, []);

  const fail = useCallback((id: string, error: string) => {
    setItems((prev) =>
      prev.map((it) =>
        it.id === id
          ? { ...it, status: 'error', finishedAt: Date.now(), detail: error, read: false }
          : it,
      ),
    );
  }, []);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const markRead = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, read: true } : it)),
    );
  }, []);

  const markAllRead = useCallback(() => {
    setItems((prev) => prev.map((it) => ({ ...it, read: true })));
  }, []);

  const clearFinished = useCallback(() => {
    setItems((prev) => prev.filter((it) => it.status === 'running'));
  }, []);

  const runningCount = useMemo(
    () => items.filter((it) => it.status === 'running').length,
    [items],
  );
  const unreadCount = useMemo(
    () => items.filter((it) => !it.read && it.status !== 'running').length,
    [items],
  );

  // Reconcile notifications with the backend's analysis log so reloads
  // don't drop "in progress" indicators. Runs once on mount, then polls
  // while any analyze notification is still 'running'.
  const reconcileAnalyses = useCallback(async () => {
    let status: { running: WikiAnalysisLogEntry[]; recent: WikiAnalysisLogEntry[] };
    try {
      status = await api.wikiAnalysesStatus();
    } catch {
      return;
    }
    setItems((prev) => {
      let next = prev;
      const ensureCloned = () => {
        if (next === prev) next = [...prev];
        return next;
      };

      // Add notifications for backend-running entries we don't yet track.
      for (const entry of status.running) {
        const id = analyzeNotificationId(entry);
        if (next.some((it) => it.id === id)) continue;
        ensureCloned().unshift({
          id,
          kind: 'wiki-analyze',
          status: 'running',
          title: `Analyzing ${entry.projectName}`,
          meta: { projectId: entry.projectId, projectName: entry.projectName },
          startedAt: new Date(entry.startedAt).getTime(),
          read: false,
        });
      }

      // For finished entries, transition any still-running notification
      // we have for that same run.
      for (const entry of status.recent) {
        if (entry.status === 'running') continue;
        const id = analyzeNotificationId(entry);
        const idx = next.findIndex((it) => it.id === id);
        if (idx === -1) continue;
        if (next[idx].status !== 'running') continue;
        next = ensureCloned();
        next[idx] = {
          ...next[idx],
          status: entry.status,
          finishedAt: entry.finishedAt
            ? new Date(entry.finishedAt).getTime()
            : Date.now(),
          detail: entry.detail,
          read: false,
        };
      }

      return next === prev ? prev : next.slice(0, MAX_HISTORY);
    });
  }, []);

  useEffect(() => {
    void reconcileAnalyses();
  }, [reconcileAnalyses]);

  useEffect(() => {
    const hasRunningAnalyze = items.some(
      (it) => it.kind === 'wiki-analyze' && it.status === 'running',
    );
    if (!hasRunningAnalyze) return;
    const id = setInterval(() => {
      void reconcileAnalyses();
    }, 6000);
    return () => clearInterval(id);
  }, [items, reconcileAnalyses]);

  const value = useMemo<NotificationContextValue>(
    () => ({
      items,
      start,
      resolve,
      fail,
      dismiss,
      markRead,
      markAllRead,
      clearFinished,
      runningCount,
      unreadCount,
    }),
    [
      items,
      start,
      resolve,
      fail,
      dismiss,
      markRead,
      markAllRead,
      clearFinished,
      runningCount,
      unreadCount,
    ],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotifications must be used within NotificationProvider');
  }
  return ctx;
}
