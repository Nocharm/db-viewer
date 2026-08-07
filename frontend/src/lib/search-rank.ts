/** 서비스 공통 검색 랭킹 — 정확 > 접두어 > 포함 > 순서 유사 (스펙 §검색 랭킹). */

export function getMatchRank(query: string, text: string): number {
  const q = query.trim().toUpperCase();
  const t = text.toUpperCase();
  if (q === "") return Infinity;
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
  // 순서 유사: 검색어 문자가 대상에 순서대로 등장 (HREMP → HR_EMP)
  let cursor = 0;
  for (const ch of q) {
    cursor = t.indexOf(ch, cursor);
    if (cursor < 0) return Infinity;
    cursor += 1;
  }
  return 3;
}

export function rankSearchResults<T>(
  query: string, items: T[], getText: (item: T) => string,
): T[] {
  if (query.trim() === "") return items;
  return items
    .map((item) => ({ item, rank: getMatchRank(query, getText(item)) }))
    .filter((entry) => entry.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank
      || getText(a.item).localeCompare(getText(b.item)))
    .map((entry) => entry.item);
}
