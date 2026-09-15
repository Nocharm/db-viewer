"use client";

/** 호버 값에 버퍼를 둔다 — 마우스가 노드·SQL 줄 위를 스치는 동안 강조와 스크롤이 매 프레임
 * 따라 움직이면 화면이 산만하다. 잠깐 머문 것만 반영한다.
 * / debounced hover: a pointer sweeping across rows shouldn't drag the highlight with it. */

import { useEffect, useRef, useState } from "react";

/** 호버가 반영되기까지 머물러야 하는 시간(ms) — 짧으면 산만하고 길면 굼뜨게 느껴진다 */
export const HOVER_SETTLE_MS = 180;
/** 호버가 풀렸을 때 강조를 거두기까지(ms) — 노드에서 팝오버로 마우스를 옮길 틈 */
export const HOVER_RELEASE_MS = 260;

export function useDeferredHover<T>(
  value: T | null,
  { settleMs = HOVER_SETTLE_MS, releaseMs = HOVER_RELEASE_MS } = {},
): T | null {
  const [settled, setSettled] = useState<T | null>(null);
  // 값 자체를 deps에 넣으면 객체 리터럴이 매 렌더 새로 만들어져 타이머가 계속 재시작된다
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    const delay = value === null ? releaseMs : settleMs;
    const timer = setTimeout(() => setSettled(latest.current), delay);
    return () => clearTimeout(timer);
  }, [value, settleMs, releaseMs]);

  return settled;
}
