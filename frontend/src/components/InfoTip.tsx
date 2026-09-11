"use client";

/** ⓘ 설명 툴팁 — 호버·키보드 포커스로 노출 / info icon with a hover/focus tooltip. */

import { useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

interface InfoTipProps {
  text: string;
  align?: "left" | "right";
  /** 목록(제외 뷰)은 여러 줄이라 children으로 받는다 — text는 그때도 aria-label로 남는다
   *  / rich bubble content; `text` still carries the accessible label */
  children?: React.ReactNode;
}

/** 말풍선은 body로 포털한다 — 스크롤 컨테이너(overflow)의 경계에 잘리지 않게.
 * The bubble is portaled to body so a scrolling ancestor cannot clip it. */
export function InfoTip({ text, align, children }: InfoTipProps) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [bubbleStyle, setBubbleStyle] = useState<CSSProperties | null>(null);

  const showBubble = () => {
    const rect = iconRef.current?.getBoundingClientRect();
    if (!rect) return;
    // align = 아이콘 기준 펼침 방향. fixed라 뷰포트 좌표를 그대로 쓴다
    const style: CSSProperties = { top: rect.bottom + 6 };
    if (align === "left") {
      style.right = window.innerWidth - rect.right;
    } else if (align === "right") {
      style.left = rect.left;
    } else {
      style.left = rect.left + rect.width / 2;
      style.transform = "translateX(-50%)";
    }
    setBubbleStyle(style);
  };

  const hideBubble = () => setBubbleStyle(null);

  return (
    <span
      ref={iconRef}
      className="info-tip"
      tabIndex={0}
      aria-label={text}
      onMouseEnter={showBubble}
      onMouseLeave={hideBubble}
      onFocus={showBubble}
      onBlur={hideBubble}
    >
      i
      {bubbleStyle &&
        createPortal(
          // children이 있으면(제외 목록 등 긴 리스트) 스크롤 가능한 말풍선으로 바꾼다
          <span
            className={`info-tip__bubble${children ? " info-tip__bubble--rich" : ""}`}
            role="tooltip"
            style={bubbleStyle}
          >
            {children ?? text}
          </span>,
          document.body,
        )}
    </span>
  );
}
