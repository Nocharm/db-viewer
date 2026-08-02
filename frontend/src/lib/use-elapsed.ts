"use client";

/** 실행 중 경과 초 — 장시간 작업의 살아있음 표시용 / elapsed seconds while active. */

import { useEffect, useState } from "react";

export function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return seconds;
}
