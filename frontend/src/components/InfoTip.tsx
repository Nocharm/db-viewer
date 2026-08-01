"use client";

/** ⓘ 설명 툴팁 — 호버·키보드 포커스로 노출 / info icon with a hover/focus tooltip. */

export function InfoTip({ text, align }: { text: string; align?: "left" | "right" }) {
  return (
    <span
      className={`info-tip ${align ? `info-tip--${align}` : ""}`}
      tabIndex={0}
      aria-label={text}
    >
      i
      <span className="info-tip__bubble" role="tooltip">{text}</span>
    </span>
  );
}
