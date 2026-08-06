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
 * 평가 순서: 제외 사유 → 값 없음(404) → N:M → 고아 존재 → **표본 부족** →
 * containment 100% → 그 외. 스펙 표는 containment 100%를 표본 부족보다 앞에 두지만,
 * 표본이 적으면 100%조차 우연일 수 있어 그걸 safe라 부르면 오도한다 — 그래서 표본
 * 경고를 먼저 걸어 caution으로 낮춘다. 의도된 이탈이며 "warns about small samples"
 * 테스트가 이 순서를 고정한다.
 * Evaluation order: excluded → no data(404) → N:M → orphans → **small sample** →
 * 100% containment → fallback. The spec table lists 100% containment before the
 * small-sample case, but a small sample makes even 100% containment unreliable —
 * calling that "safe" would mislead, so the small-sample warning is checked first on
 * purpose. This is a deliberate deviation, pinned by the "warns about small samples" test.
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
