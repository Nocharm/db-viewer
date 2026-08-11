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

function escapeIdentifier(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

/** 조건 연산자 — 포함/정확과 그 제외형, NULL 검사 / condition operators. */
export type PreviewFilterOp =
  | "contains" | "eq" | "not_contains" | "neq" | "is_null" | "not_null";

export interface PreviewFilterCond {
  column: string;
  op: PreviewFilterOp;
  /** NULL 계열 op은 값이 없다 / null ops carry no value */
  value: string | null;
}

/** 값이 필요 없는 연산자인지 / whether the op takes no value. */
export function isNullOp(op: PreviewFilterOp): boolean {
  return op === "is_null" || op === "not_null";
}

export interface PreviewQueryState {
  object: string; // schema.name
  limit: number;
  /** AND 결합 조건 목록 — 빈 배열이면 무필터 / AND-combined, empty = unfiltered */
  filters: PreviewFilterCond[];
}

function renderCondSql(cond: PreviewFilterCond): string {
  const column = escapeIdentifier(cond.column);
  if (cond.op === "is_null") return `${column} IS NULL`;
  if (cond.op === "not_null") return `${column} IS NOT NULL`;
  const value = (cond.value ?? "").replace(/'/g, "''");
  if (cond.op === "eq") return `${column} = N'${value}'`;
  if (cond.op === "neq") return `${column} <> N'${value}'`;
  if (cond.op === "not_contains") return `${column} NOT LIKE N'%${value}%'`;
  return `${column} LIKE N'%${value}%'`;
}

/** 현재 미리보기 상태와 동치인 T-SQL 생성 — 보이는 컬럼·필터·정렬·행수 그대로.
 * 재현용 참고 쿼리다: 조건 목록(AND)의 연산자와 식별자 이스케이프를 보존한다.
 * The T-SQL equivalent of the current preview state, for reproduction elsewhere. */
export function buildPreviewSql(
  state: PreviewQueryState,
  visibleColumns: string[],
  sort: SortSpec | null,
): string {
  const [schema, ...rest] = state.object.split(".");
  const table = `${escapeIdentifier(schema)}.${escapeIdentifier(rest.join("."))}`;
  const columns = visibleColumns.map(escapeIdentifier).join(",\n       ");
  let sql = `SELECT TOP ${state.limit}\n       ${columns}\nFROM ${table}`;
  if (state.filters.length > 0) {
    sql += `\nWHERE ${state.filters.map(renderCondSql).join("\n  AND ")}`;
  }
  if (sort) {
    sql += `\nORDER BY ${escapeIdentifier(sort.column)} ${sort.dir.toUpperCase()}`;
  }
  return `${sql};`;
}

export interface SqlToken {
  type: "keyword" | "identifier" | "string" | "number" | "plain";
  text: string;
}

const SQL_TOKEN_PATTERNS: [SqlToken["type"], RegExp][] = [
  ["string", /^N?'(?:[^']|'')*'/],
  ["identifier", /^\[(?:[^\]]|\]\])*\]/],
  ["keyword", /^(?:SELECT|TOP|FROM|WHERE|NOT|LIKE|AND|IS|NULL|ORDER|BY|ASC|DESC)\b/i],
  ["number", /^\d+(?:\.\d+)?/],
];

/** 자체 생성 SQL 전용 경량 토크나이저 — 하이라이트 렌더용 (라이브러리 무추가).
 * Tiny tokenizer for our own generated SQL, used for syntax highlighting. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let rest = sql;
  while (rest.length > 0) {
    const match = SQL_TOKEN_PATTERNS
      .map(([type, pattern]) => ({ type, hit: pattern.exec(rest)?.[0] }))
      .find((m): m is { type: SqlToken["type"]; hit: string } => Boolean(m.hit));
    if (match) {
      tokens.push({ type: match.type, text: match.hit });
      rest = rest.slice(match.hit.length);
      continue;
    }
    // 매칭 안 되는 구간은 다음 토큰 시작 전까지 plain으로 병합
    const last = tokens[tokens.length - 1];
    if (last?.type === "plain") last.text += rest[0];
    else tokens.push({ type: "plain", text: rest[0] });
    rest = rest.slice(1);
  }
  return tokens;
}

/** 클립보드 복사 — 평문 HTTP(insecure context)에선 navigator.clipboard가 없어
 * textarea+execCommand 폴백을 쓴다 (bpm 운영 레슨: 사내 서버는 HTTP).
 * Copies text with an execCommand fallback so plain-HTTP deployments work. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 권한 거부 등 — 폴백으로 진행 / fall through to the legacy path
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } finally {
    area.remove();
  }
}

/** 저장된 순서를 컬럼 목록에 적용 — 순서에 없는 컬럼(재조회로 새로 온 것)은 뒤에 원래
 * 순서대로 붙는다. 빈 순서는 원본 그대로 / apply a saved order; unknown columns append. */
export function applyColumnOrder(columns: string[], order: string[]): string[] {
  if (order.length === 0) return columns;
  const present = new Set(columns);
  const known = order.filter((column) => present.has(column));
  const knownSet = new Set(known);
  return [...known, ...columns.filter((column) => !knownSet.has(column))];
}

/** 드래그한 컬럼을 대상 앞(또는 뒤)으로 — 결과가 새 저장 순서가 된다.
 * 대상이 없거나 자기 자신이면 원본 반환 / move dragged before/after target. */
export function moveColumn(
  columns: string[], dragged: string, target: string, after: boolean,
): string[] {
  if (dragged === target) return columns;
  const without = columns.filter((column) => column !== dragged);
  const targetIndex = without.indexOf(target);
  if (targetIndex < 0 || !columns.includes(dragged)) return columns;
  const insertAt = after ? targetIndex + 1 : targetIndex;
  return [...without.slice(0, insertAt), dragged, ...without.slice(insertAt)];
}