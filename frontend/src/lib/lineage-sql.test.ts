import { describe, expect, it } from "vitest";

import {
  findLinesForNames, findNamesInLine, getSqlBottomPadding, getSqlScrollTop,
  SQL_ANCHOR_RATIO, splitSqlLines,
} from "@/lib/lineage-sql";

const SQL = [
  "CREATE VIEW dbo.V_ORD_SO_SUMMARY AS",
  "SELECT  d.SO_NO,",
  "        d.QTY * d.UNIT_PRICE AS AMT_VAL",
  "FROM    dbo.ORD_SO_DTL d",
  "JOIN    dbo.TB_VND_VENDOR v ON d.VENDOR_NO = v.VENDOR_NO",
].join("\n");

describe("splitSqlLines", () => {
  it("줄 번호는 1부터, 원문 줄 수와 같다", () => {
    const lines = splitSqlLines(SQL);
    expect(lines).toHaveLength(5);
    expect(lines[0].no).toBe(1);
    expect(lines[4].text).toContain("VENDOR_NO");
  });

  it("여러 줄에 걸친 토큰(들여쓰기 공백)이 줄을 섞지 않는다", () => {
    const lines = splitSqlLines("SELECT\n\n  A");
    expect(lines).toHaveLength(3);
    expect(lines[1].text.trim()).toBe("");
    expect(lines[2].text).toContain("A");
  });

  it("빈 SQL도 줄 하나를 돌려준다 — 렌더가 빈 배열을 특수 처리하지 않게", () => {
    expect(splitSqlLines("")).toHaveLength(1);
  });
});

describe("findNamesInLine", () => {
  it("qname은 마지막 조각으로 매칭한다", () => {
    const lines = splitSqlLines(SQL);
    expect(findNamesInLine(lines[3], ["dbo.ORD_SO_DTL"])).toEqual(["dbo.ORD_SO_DTL"]);
  });

  it("예약어는 같은 철자여도 매칭하지 않는다", () => {
    const lines = splitSqlLines("SELECT VIEW_X FROM dbo.T");
    // "VIEW"는 예약어 토큰이라 이름 후보로 잡히면 안 된다
    expect(findNamesInLine(lines[0], ["VIEW"])).toEqual([]);
  });

  it("대괄호·대소문자 표기 차이를 흡수한다", () => {
    const lines = splitSqlLines("SELECT [apRv_Cd] FROM dbo.T");
    expect(findNamesInLine(lines[0], ["APRV_CD"])).toEqual(["APRV_CD"]);
  });

  it("이름이 없으면 빈 배열 — 순회 비용을 들이지 않는다", () => {
    const lines = splitSqlLines(SQL);
    expect(findNamesInLine(lines[0], [])).toEqual([]);
  });
});

describe("findLinesForNames", () => {
  it("등장한 모든 줄을 오름차순으로 준다", () => {
    const lines = splitSqlLines(SQL);
    expect(findLinesForNames(lines, ["VENDOR_NO"])).toEqual([5]);
    expect(findLinesForNames(lines, ["SO_NO", "AMT_VAL"])).toEqual([2, 3]);
  });

  it("같은 이름이 여러 소스에 있으면 여러 줄이 함께 잡힌다 — 이름 매칭의 한계", () => {
    const lines = splitSqlLines(SQL);
    expect(findLinesForNames(lines, ["d"]).length).toBeGreaterThan(1);
  });
});

describe("스크롤 네비게이션", () => {
  it("강조 줄을 가운데보다 살짝 위에 세운다", () => {
    const top = getSqlScrollTop(1000, 400, 20);
    expect(top).toBe(1000 - 400 * SQL_ANCHOR_RATIO + 10);
    expect(SQL_ANCHOR_RATIO).toBeLessThan(0.5);
  });

  it("최상단 줄은 음수로 넘어가지 않고 맨 위에 붙는다", () => {
    expect(getSqlScrollTop(0, 400, 20)).toBe(0);
  });

  it("아래 여백이 있어야 마지막 줄도 앵커까지 올라온다", () => {
    const viewport = 400;
    const lineHeight = 20;
    const lastLineTop = 1000;
    const padding = getSqlBottomPadding(viewport);
    expect(padding).toBeGreaterThan(viewport * 0.5);
    // 콘텐츠는 마지막 줄 끝(offsetTop + 높이)에서 여백만큼 더 간다
    const contentHeight = lastLineTop + lineHeight + padding;
    expect(getSqlScrollTop(lastLineTop, viewport, lineHeight))
      .toBeLessThanOrEqual(contentHeight - viewport);
  });
});
