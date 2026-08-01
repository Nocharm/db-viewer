/** 엣지 시각 언어 — 색=신뢰도, 패턴=종류 (design-app.md) / edge visual language. */

export type EdgeKind =
  | "fk"
  | "confirmed"
  | "inferred"
  | "ai_suggested"
  | "view_lineage"
  | "unresolved";

export interface EdgeVisual {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  opacity: number;
}

/** confidence 3단계 스텝 — 연속 투명도는 비교 불가 (design-app.md) */
export function confidenceOpacity(confidence: number): number {
  if (confidence >= 0.99) return 1.0;
  if (confidence >= 0.95) return 0.7;
  return 0.45;
}

const DASH: Record<EdgeKind, string | undefined> = {
  fk: undefined, // 실선
  confirmed: undefined, // 실선 + ✓ 배지는 라벨에서
  inferred: "8 4",
  ai_suggested: "3 3",
  view_lineage: "1.5 4",
  unresolved: "10 4 2 4", // 일점쇄선
};

const COLOR: Record<EdgeKind, string> = {
  fk: "var(--rel-confirmed)",
  confirmed: "var(--rel-confirmed)",
  inferred: "var(--rel-inferred)",
  ai_suggested: "var(--rel-ai)",
  view_lineage: "var(--rel-lineage)",
  unresolved: "var(--rel-unresolved)",
};

export function getEdgeVisual(kind: EdgeKind, confidence?: number): EdgeVisual {
  return {
    stroke: COLOR[kind],
    strokeWidth: 2,
    strokeDasharray: DASH[kind],
    opacity: kind === "inferred" && confidence !== undefined
      ? confidenceOpacity(confidence)
      : 1.0,
  };
}
