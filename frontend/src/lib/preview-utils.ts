/** 미리보기 클라이언트 연산 — 정렬·고유값·CSV. 전부 로드된 행 기준(재질의 없음).
 * Client-side preview ops over loaded rows: sort, unique counts, CSV. */

export type PreviewRow = Record<string, unknown>;

export interface SortSpec {
  column: string;
  dir: "asc" | "desc";
}

/** 숫자면 수치 비교, 아니면 문자열 비교 — 원본 배열은 불변 / numeric-aware, non-mutating. */
export function sortRows(rows: PreviewRow[], sort: SortSpec | null): PreviewRow[] {
  if (!sort) return rows;
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[sort.column];
    const right = b[sort.column];
    if (left === null || left === undefined) return 1; // 빈 값은 항상 뒤로
    if (right === null || right === undefined) return -1;
    const ln = Number(left);
    const rn = Number(right);
    if (!Number.isNaN(ln) && !Number.isNaN(rn) && String(left).trim() !== "" && String(right).trim() !== "") {
      return (ln - rn) * factor;
    }
    return String(left).localeCompare(String(right)) * factor;
  });
}

/** 값별 건수 — 건수 내림차순, 동수는 값 오름차순 / value counts, desc by count. */
export function countUniqueValues(
  rows: PreviewRow[], column: string,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = String(row[column] ?? "");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function escapeCsvCell(value: unknown): string {
  const text = String(value ?? "");
  // 쉼표·따옴표·개행 포함 시 인용 / quote when the cell needs it
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** 보이는 컬럼·현재 정렬 그대로 CSV — 엑셀 한글 대응 BOM 포함.
 * CSV of the visible columns in current order, with a BOM for Excel. */
export function buildCsv(columns: string[], rows: PreviewRow[]): string {
  const lines = [columns.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvCell(row[column])).join(","));
  }
  return `﻿${lines.join("\r\n")}`;
}
