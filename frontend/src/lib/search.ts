/** 테이블 검색 매처 — 초성·컬럼·카테고리 매칭 + 하이라이트 범위. / table search matcher. */

import { getMatchRank } from "./search-rank";

const CHOSUNG = [
  "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];

/** 한글 음절 → 초성 나열, 그 외 문자는 그대로 / Korean syllables to initial consonants. */
export function toChosung(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      out += CHOSUNG[Math.floor((code - 0xac00) / 588)];
    } else {
      out += ch;
    }
  }
  return out;
}

export function isChosungQuery(query: string): boolean {
  return query.length > 0 && [...query].every((ch) => CHOSUNG.includes(ch));
}

export interface SearchTarget {
  name: string;
  categoryLabel: string;
  columns: string[];
}

export interface SearchMatch {
  matched: boolean;
  /** 테이블명 하이라이트 [시작, 끝) / highlight range in the name */
  nameRange: [number, number] | null;
  /** 컬럼 매칭 시 해당 컬럼명 / matched column name if the hit came from a column */
  matchedColumn: string | null;
  /** 컬럼명 하이라이트 [시작, 끝) */
  columnRange: [number, number] | null;
  /** 정렬용 등급 — 이름 0~3(정확·접두·포함·순서유사) < 컬럼 4 < 카테고리 5, 비매칭 Infinity */
  rank: number;
}

const NO_MATCH: SearchMatch = {
  matched: false, nameRange: null, matchedColumn: null, columnRange: null, rank: Infinity,
};

/** 검색 모드 — fuzzy는 현행(순서 유사·초성까지), exact는 입력 그대로 포함된 것만.
 * / fuzzy keeps the current behavior; exact restricts to literal substrings. */
export type SearchMode = "fuzzy" | "exact";

/** 우선순위: 테이블명 → 컬럼명 → 카테고리(부분·초성) / name, then columns, then category. */
export function matchTable(
  rawQuery: string, target: SearchTarget, mode: SearchMode = "fuzzy",
): SearchMatch {
  const query = rawQuery.trim();
  if (query === "") {
    return { matched: true, nameRange: null, matchedColumn: null, columnRange: null, rank: 0 };
  }
  const upper = query.toUpperCase();

  const nameIndex = target.name.toUpperCase().indexOf(upper);
  if (nameIndex >= 0) {
    return {
      matched: true, nameRange: [nameIndex, nameIndex + query.length],
      matchedColumn: null, columnRange: null,
      // indexOf가 찾았다는 건 정확·접두·포함 중 하나 — getMatchRank로 등급만 산출
      rank: getMatchRank(query, target.name),
    };
  }

  // 이름 부분 포함이 실패해도 순서 유사(rank 3)는 한 번 더 시도한다 — fuzzy 한정.
  // 다만 순서 유사는 불연속 매칭이라 하이라이트 범위를 그릴 수 없어 nameRange는 null.
  if (mode === "fuzzy" && getMatchRank(query, target.name) === 3) {
    return { matched: true, nameRange: null, matchedColumn: null, columnRange: null, rank: 3 };
  }

  for (const column of target.columns) {
    const columnIndex = column.toUpperCase().indexOf(upper);
    if (columnIndex >= 0) {
      return {
        matched: true, nameRange: null,
        matchedColumn: column, columnRange: [columnIndex, columnIndex + query.length],
        rank: 4,
      };
    }
  }

  if (target.categoryLabel.includes(query)) {
    return { matched: true, nameRange: null, matchedColumn: null, columnRange: null, rank: 5 };
  }
  // 초성 확장도 유사 매칭이다 — exact에선 입력 그대로만 / chosung expansion is fuzzy-only
  if (mode === "fuzzy" && isChosungQuery(query) && toChosung(target.categoryLabel).includes(query)) {
    return { matched: true, nameRange: null, matchedColumn: null, columnRange: null, rank: 5 };
  }
  return NO_MATCH;
}
