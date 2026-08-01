"use client";

/** 엣지 시각 언어 범례 / edge visual-language legend. */

import { getEdgeVisual, type EdgeKind } from "@/lib/edge-style";

const ITEMS: { kind: EdgeKind; label: string }[] = [
  { kind: "fk", label: "확정 (FK)" },
  { kind: "inferred", label: "추정 (검증 통과)" },
  { kind: "ai_suggested", label: "AI 제안 (미검증)" },
  { kind: "view_lineage", label: "뷰 lineage" },
  { kind: "unresolved", label: "미해석" },
];

export function Legend() {
  return (
    <div
      className="absolute bottom-3 left-3 z-10 rounded-lg border bg-white px-3 py-2"
      style={{ borderColor: "var(--hairline)" }}
      data-testid="ErdCanvas-legend"
    >
      {ITEMS.map(({ kind, label }) => {
        const v = getEdgeVisual(kind);
        return (
          <div key={kind} className="flex items-center gap-2 py-0.5 text-xs">
            <svg width="32" height="6">
              <line
                x1="0" y1="3" x2="32" y2="3"
                stroke={v.stroke}
                strokeWidth={v.strokeWidth}
                strokeDasharray={v.strokeDasharray}
                opacity={v.opacity}
              />
            </svg>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
