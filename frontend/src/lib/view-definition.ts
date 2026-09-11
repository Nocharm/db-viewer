/** 뷰 정의 SQL 표시의 순수 로직 — 히트 컬럼 토큰 판별 / pure helpers for the definition panel. */

import type { SqlToken } from "@/lib/preview-utils";

export interface HighlightedToken extends SqlToken {
  hit: boolean;
}

/** 인용부호·별칭 접두를 벗기고 소문자로 — a.[APRV_CD] ↔ APRVCD 비교용 */
export function normalizeIdentifier(text: string): string {
  const last = text.split(".").pop() ?? text;
  return last.replace(/^[["`]|[\]"`]$/g, "").toLowerCase();
}

/** 히트 컬럼과 같은 이름의 식별자 토큰만 표시한다 — 한정자(`a.`)는 별개 토큰이라 컬럼 조각만
 *  물들고, 예약어·함수 호출은 식별자가 아니므로 같은 철자여도 건드리지 않는다.
 *  / mark identifier tokens matching the hit column; qualifiers, keywords and calls stay plain */
export function markHitTokens(tokens: SqlToken[], column: string | null): HighlightedToken[] {
  const target = column ? normalizeIdentifier(column) : null;
  return tokens.map((tk) => ({
    ...tk,
    hit: target !== null && tk.type === "identifier" && normalizeIdentifier(tk.text) === target,
  }));
}
