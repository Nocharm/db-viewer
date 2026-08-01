/** 테이블 검색 매처 — 초성·컬럼·카테고리 매칭 + 하이라이트 범위. / table search matcher. */

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
}

const NO_MATCH: SearchMatch = {
  matched: false, nameRange: null, matchedColumn: null, columnRange: null,
};

/** 우선순위: 테이블명 → 컬럼명 → 카테고리(부분·초성) / name, then columns, then category. */
export function matchTable(rawQuery: string, target: SearchTarget): SearchMatch {
  const query = rawQuery.trim();
  if (query === "") {
    return { matched: true, nameRange: null, matchedColumn: null, columnRange: null };
  }
  const upper = query.toUpperCase();

  const nameIndex = target.name.toUpperCase().indexOf(upper);
  if (nameIndex >= 0) {
    return {
      matched: true, nameRange: [nameIndex, nameIndex + query.length],
      matchedColumn: null, columnRange: null,
    };
  }

  for (const column of target.columns) {
    const columnIndex = column.toUpperCase().indexOf(upper);
    if (columnIndex >= 0) {
      return {
        matched: true, nameRange: null,
        matchedColumn: column, columnRange: [columnIndex, columnIndex + query.length],
      };
    }
  }

  if (target.categoryLabel.includes(query)) {
    return { matched: true, nameRange: null, matchedColumn: null, columnRange: null };
  }
  if (isChosungQuery(query) && toChosung(target.categoryLabel).includes(query)) {
    return { matched: true, nameRange: null, matchedColumn: null, columnRange: null };
  }
  return NO_MATCH;
}
