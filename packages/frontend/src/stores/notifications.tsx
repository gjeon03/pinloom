import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type NotificationKind = 'wiki-sync' | 'generic';
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
  meta?: { sessionId?: string; sessionTitle?: string | null };
}

interface StartArgs {
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

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const counter = useRef(0);

  const start = useCallback((args: StartArgs): string => {
    counter.current += 1;
    const id = `n-${Date.now()}-${counter.current}`;
    const item: NotificationItem = {
      id,
      kind: args.kind,
      status: 'running',
      title: args.title,
      meta: args.meta,
      startedAt: Date.now(),
      read: false,
    };
    setItems((prev) => [item, ...prev].slice(0, MAX_HISTORY));
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
