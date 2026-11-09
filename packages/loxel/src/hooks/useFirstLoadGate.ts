import { useEffect, useState } from "react";

/**
 * Whether to hold something back until a first load settles: true while `pending`, for at most
 * `capMs` after mount. Once released it stays released, so a later load never gates again.
 */
export function useFirstLoadGate(pending: boolean, capMs: number): boolean {
  const [released, setReleased] = useState(!pending);
  useEffect(() => {
    if (!pending) {
      setReleased(true);
      return;
    }
    const timer = setTimeout(() => setReleased(true), capMs);
    return () => clearTimeout(timer);
  }, [pending, capMs]);
  return pending && !released;
}
