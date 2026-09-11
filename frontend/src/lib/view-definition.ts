/** 뷰 정의 SQL 표시의 순수 로직 — 히트 컬럼 토큰 판별 / pure helpers for the definition panel. */

import type { SqlToken } from "@/lib/preview-utils";

export interface HighlightedToken extends SqlToken {
  hit: boolean;
}

/** 이름을 이루는 문자 — 한정자 점과 대괄호·따옴표 인용까지 한 덩어리로 본다 */
const NAME_RUN = /([\w$@#.[\]"`]+)/;
const NAME_CHAR = /[\w$@#.[\]"`]/;

/** 맨 식별자가 흩어질 수 있는 토큰 타입 — keyword·string 경계는 이름이 아니다 */
const SPLITTABLE: ReadonlySet<SqlToken["type"]> = new Set(["plain", "number"]);

/** 인용부호·별칭 접두를 벗기고 소문자로 — a.[APRV_CD] ↔ APRVCD 비교용 */
export function normalizeIdentifier(text: string): string {
  const last = text.split(".").pop() ?? text;
  return last.replace(/^[["`]|[\]"`]$/g, "").toLowerCase();
}

/** tokenizeSql은 자체 생성 SQL 전용이라 맨 식별자를 plain/number에 흩뿌린다(`dbo.T` + `1`).
 *  뷰 정의는 임의 T-SQL이므로 이름이 토큰 경계에서 잘린 곳을 먼저 이어 붙여야 비교가 선다. */
function joinSplitNames(tokens: SqlToken[]): SqlToken[] {
  const joined: SqlToken[] = [];
  for (const token of tokens) {
    const prev = joined[joined.length - 1];
    if (prev !== undefined && SPLITTABLE.has(prev.type) && SPLITTABLE.has(token.type)
        && NAME_CHAR.test(prev.text.slice(-1)) && NAME_CHAR.test(token.text.slice(0, 1))) {
      prev.text += token.text;
    } else {
      joined.push({ ...token });
    }
  }
  return joined;
}

/** 토큰 안의 이름 조각만 따로 떼어 히트를 표시한다 — 색은 원래 토큰 타입을 그대로 물려준다 */
function splitOnHits(token: SqlToken, target: string): HighlightedToken[] {
  return token.text
    .split(NAME_RUN)
    .filter((piece) => piece.length > 0)
    .map((piece) => ({
      type: token.type,
      text: piece,
      hit: normalizeIdentifier(piece) === target,
    }));
}

export function markHitTokens(tokens: SqlToken[], column: string | null): HighlightedToken[] {
  const target = column ? normalizeIdentifier(column) : null;
  if (target === null) return tokens.map((tk) => ({ ...tk, hit: false }));
  return joinSplitNames(tokens).flatMap((tk) => splitOnHits(tk, target));
}
