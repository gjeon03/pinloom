import { useEffect, useState } from 'react';

/** Returns `value` delayed by `delayMs` — only the latest value after a quiet
 * period survives, so search-as-you-type fires one request per pause instead
 * of one per keystroke. */
export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
