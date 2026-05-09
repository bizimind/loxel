import type { RefObject } from "react";

import { useCallback, useEffect, useRef } from "react";

export function useDragAutoScroll(scrollRef: RefObject<HTMLDivElement | null>) {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startAutoScroll = useCallback(
    (speed: number) => {
      if (timerRef.current) return;
      timerRef.current = setInterval(() => {
        scrollRef.current?.scrollBy(0, speed);
      }, 16);
    },
    [scrollRef],
  );

  const stopAutoScroll = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  return { startAutoScroll, stopAutoScroll };
}
