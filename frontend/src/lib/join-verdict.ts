/** 조인 판정 — 수치가 아니라 증상명과 처방을 낸다.
 * Turns a containment observation into a symptom and a remedy. */

import type { ContainmentResponse } from "./types";

export type VerdictLevel = "safe" | "caution" | "danger" | "unknown";

export interface JoinVerdict {
  level: VerdictLevel;
  symptom: string;
  /** 사용자가 취할 조치 — 없으면 null / actionable fix, null when none applies */
  remedy: string | null;
}

/** 관측 패턴 라벨 — 접힌 수치 영역에서 쓴다 / pattern labels for the numbers panel. */
export const PATTERN_LABELS: Record<string, string> = {
  stable_confirmed: "지속 1.0 — 사실상 확정 FK",
  stable_with_orphans: "관계 유효 · 고아 데이터 존재",
  drop_alert: "급락 — 스키마·데이터 변경 의심",
  small_sample_only: "소량 데이터 — 우연 가능",
  unstable: "불안정",
};

/** 나쁠수록 큰 값 — 전체 판정은 최악값이 된다 / higher is worse. */
const SEVERITY: Record<VerdictLevel, number> = {
  safe: 0,
  unknown: 1,
  caution: 2,
  danger: 3,
};

/**
 * 표 순서대로 평가한다 — N:M이 containment 100%보다 우선이다.
 * `result`가 null이면 값 데이터가 없어 검증 불가(404)를 뜻한다.
 */
export function getJoinVerdict(
  result: ContainmentResponse | null,
  excludedReason: string | null,
): JoinVerdict {
  if (excludedReason) {
    return {
      level: "danger",
      symptom: "값 종류가 너무 적어 우연히 맞을 수 있습니다",
      remedy: "조인 키로 부적합합니다",
    };
  }
  if (result === null) {
    return {
      level: "unknown",
      symptom: "값 데이터가 없어 검증할 수 없습니다",
      remedy: null,
    };
  }
  if (result.cardinality === "N:M") {
    return {
      level: "danger",
      symptom: "양쪽 다 중복 — 조인하면 행이 폭증합니다",
      remedy: "중간 테이블이 필요합니다",
    };
  }
  if (result.orphan_count > 0) {
    return {
      level: "caution",
      symptom: `짝 없는 행 ${result.orphan_count.toLocaleString()}건 — `
        + "INNER로 묶으면 유실됩니다",
      remedy: "LEFT JOIN 권장",
    };
  }
  if (result.pattern === "small_sample_only") {
    return {
      level: "caution",
      symptom: "표본이 적어 우연일 수 있습니다",
      remedy: "데이터가 쌓인 뒤 재검증하세요",
    };
  }
  if (result.containment >= 1.0) {
    return {
      level: "safe",
      symptom: "모든 행이 짝이 맞습니다",
      remedy: null,
    };
  }
  return {
    level: "caution",
    symptom: `짝이 맞는 행이 ${(result.containment * 100).toFixed(1)}%뿐입니다`,
    remedy: "LEFT JOIN 권장",
  };
}

/** 가장 약한 고리의 인덱스 — 동률이면 앞선 것 / index of the worst step, -1 if empty. */
export function getWorstVerdictIndex(verdicts: JoinVerdict[]): number {
  let worst = -1;
  let severity = -1;
  verdicts.forEach((verdict, index) => {
    if (SEVERITY[verdict.level] > severity) {
      severity = SEVERITY[verdict.level];
      worst = index;
    }
  });
  return worst;
}
