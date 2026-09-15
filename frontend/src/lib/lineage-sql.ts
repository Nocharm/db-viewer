/** 맵 ↔ 정의 SQL 상호 탐색의 순수 로직 — 줄 분해·식별자 매칭·스크롤 목표 계산.
 *
 * 파서는 토큰 위치를 남기지 않는다(`view_parsing.py`는 구조만 뽑는다). 그래서 연결은
 * **이름 매칭**이고, 같은 이름 컬럼이 두 소스에 있으면 양쪽이 함께 물든다 —
 * 화면에서도 근거를 "이름 일치"라고 밝혀야 사용자가 과신하지 않는다.
 * / name matching, not parser offsets: ambiguous names light up together by design.
 */

import { tokenizeSql, type SqlToken } from "@/lib/preview-utils";
import { normalizeIdentifier } from "@/lib/view-definition";

export interface SqlLine {
  /** 1부터 시작 / 1-based */
  no: number;
  text: string;
  tokens: SqlToken[];
}

/** 호버한 줄이 멈출 위치 — 뷰포트 높이 대비 비율. 정확히 가운데(0.5)면 시선이 아래로 쏠려
 * 바로 다음 줄들이 안 보인다. 살짝 위(0.38)여야 주변 문맥이 아래로 남는다. */
export const SQL_ANCHOR_RATIO = 0.38;

/** 토큰을 줄 단위로 쪼갠다 — 토큰 하나가 여러 줄에 걸칠 수 있다(공백·블록 주석). */
export function splitSqlLines(sql: string): SqlLine[] {
  const lines: SqlLine[] = [{ no: 1, text: "", tokens: [] }];
  for (const token of tokenizeSql(sql)) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push({ no: lines.length + 1, text: "", tokens: [] });
      const line = lines[lines.length - 1];
      if (part !== "") {
        line.text += part;
        line.tokens.push({ type: token.type, text: part });
      }
    });
  }
  return lines;
}

/** 식별자 토큰만 본다 — `FROM`·`SUM(` 같은 예약어·함수는 같은 철자여도 매칭하지 않는다.
 * qname(`dbo.ORD_SO_DTL`)은 마지막 조각으로 비교한다(정의 SQL은 별칭·대괄호를 섞어 쓴다). */
export function findNamesInLine(line: SqlLine, names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const wanted = new Map<string, string>();
  for (const name of names) wanted.set(normalizeIdentifier(name), name);
  const hits = new Set<string>();
  for (const token of line.tokens) {
    if (token.type !== "identifier") continue;
    const original = wanted.get(normalizeIdentifier(token.text));
    if (original !== undefined) hits.add(original);
  }
  return [...hits];
}

/** 이 이름들이 등장하는 줄 번호 — 오름차순, 중복 없음. */
export function findLinesForNames(lines: SqlLine[], names: readonly string[]): number[] {
  if (names.length === 0) return [];
  return lines.filter((line) => findNamesInLine(line, names).length > 0).map((line) => line.no);
}

/** 강조 줄이 앵커 위치에 오도록 스크롤 목표를 계산한다.
 *
 * 맨 위 줄은 0으로 잘려 그대로 최상단에 붙는다(요구: 최상단은 위에 있어도 됨). 맨 아래
 * 줄까지 앵커로 끌어올리려면 콘텐츠 아래에 `getSqlBottomPadding()`만큼 여백이 있어야 한다.
 */
export function getSqlScrollTop(
  lineOffsetTop: number,
  viewportHeight: number,
  lineHeight: number,
): number {
  return Math.max(0, lineOffsetTop - viewportHeight * SQL_ANCHOR_RATIO + lineHeight / 2);
}

/** SQL 블록 아래 여백 — 마지막 줄도 앵커까지 올라올 수 있어야 네비게이션이 끊기지 않는다. */
export function getSqlBottomPadding(viewportHeight: number): number {
  return Math.max(0, Math.round(viewportHeight * (1 - SQL_ANCHOR_RATIO)));
}
