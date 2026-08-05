/** 엣지 시각 언어 — 3등급 압축(확정/추정/미검증) + 계보 별도 축.
 * Five kinds collapse into three grades; provenance keeps its own axis. */

export type EdgeKind =
  | "fk"
  | "confirmed"
  | "inferred"
  | "ai_suggested"
  | "view_lineage"
  | "unresolved";

/** 사용자가 구분해야 하는 축은 "얼마나 믿을 수 있나" 하나뿐 — 근거는 클릭 시 표시.
 * The only axis a reader needs is trust level; provenance shows on click. */
export type EdgeGrade = "confirmed" | "inferred" | "unresolved" | "lineage";

export interface EdgeVisual {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  opacity: number;
}

const GRADE: Record<EdgeKind, EdgeGrade> = {
  fk: "confirmed",
  confirmed: "confirmed",
  inferred: "inferred",
  ai_suggested: "inferred",
  unresolved: "unresolved",
  view_lineage: "lineage",
};

export function getEdgeGrade(kind: EdgeKind): EdgeGrade {
  return GRADE[kind];
}

/** confidence 3단계 스텝 — 연속 투명도는 비교 불가 (design-app.md) */
export function confidenceOpacity(confidence: number): number {
  if (confidence >= 0.99) return 1.0;
  if (confidence >= 0.95) return 0.7;
  return 0.45;
}

const GRADE_STYLE: Record<EdgeGrade, { stroke: string; dash?: string; opacity: number }> = {
  confirmed: { stroke: "var(--rel-confirmed)", opacity: 1.0 },
  inferred: { stroke: "var(--rel-inferred)", dash: "8 4", opacity: 1.0 },
  unresolved: { stroke: "var(--rel-unresolved)", dash: "2 4", opacity: 0.5 },
  lineage: { stroke: "var(--rel-lineage)", dash: "1.5 4", opacity: 0.5 },
};

export function getEdgeVisual(kind: EdgeKind, confidence?: number): EdgeVisual {
  const grade = getEdgeGrade(kind);
  const style = GRADE_STYLE[grade];
  return {
    stroke: style.stroke,
    strokeWidth: 2,
    strokeDasharray: style.dash,
    // 추정 등급 안에서만 confidence로 단계 구분 / confidence steps within the inferred grade
    opacity: grade === "inferred" && confidence !== undefined
      ? confidenceOpacity(confidence)
      : style.opacity,
  };
}

/** 까그발 표기 한쪽 끝 / one end of a crow's-foot notation. */
export type CardinalityEnd = "one" | "many" | null;

export interface CardinalityEnds {
  source: CardinalityEnd;
  target: CardinalityEnd;
}

/** React Flow 마커 element id — CardinalityMarkerDefs가 defs로 심는다. */
export const MARKER_ID: Record<"one" | "many", string> = {
  one: "dbv-card-one",
  many: "dbv-card-many",
};

function parseEnd(token: string): CardinalityEnd {
  if (token === "1") return "one";
  if (token === "N" || token === "M") return "many";
  return null;
}

/** "1:N" → {source:"one", target:"many"}. 미검증(null·미인식)은 양끝 null.
 * The string is always src:tgt, matching how ErdCanvas orders edge endpoints. */
export function getCardinalityEnds(
  cardinality: string | null | undefined,
): CardinalityEnds {
  const parts = (cardinality ?? "").split(":");
  if (parts.length !== 2) return { source: null, target: null };
  const source = parseEnd(parts[0]);
  const target = parseEnd(parts[1]);
  if (source === null || target === null) return { source: null, target: null };
  return { source, target };
}
