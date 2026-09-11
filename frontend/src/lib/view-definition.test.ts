import { describe, expect, it } from "vitest";

import { tokenizeSql } from "./preview-utils";
import { markHitTokens, normalizeIdentifier } from "./view-definition";

describe("normalizeIdentifier", () => {
  it("strips quoting and qualifiers so a.[APRV_CD] matches APRV_CD", () => {
    expect(normalizeIdentifier("a.[APRV_CD]")).toBe("aprv_cd");
    expect(normalizeIdentifier('"Aprv_Cd"')).toBe("aprv_cd");
    expect(normalizeIdentifier("dbo.T_ORD")).toBe("t_ord");
  });
});

describe("markHitTokens", () => {
  it("flags identifier tokens equal to the hit column, case-insensitively", () => {
    const tokens = tokenizeSql("SELECT a.APRVCD AS related_cd, b.ItemCd FROM dbo.APV_APRV a");
    const marked = markHitTokens(tokens, "aprvcd");
    const hits = marked.filter((tk) => tk.hit).map((tk) => tk.text);
    expect(hits).toEqual(["a.APRVCD"]);
  });

  it("marks nothing without a column", () => {
    const tokens = tokenizeSql("SELECT 1");
    expect(markHitTokens(tokens, null).some((tk) => tk.hit)).toBe(false);
  });

  it("keeps the full text when the pieces are stitched back together", () => {
    const sql = "SELECT a.ADDR1, [b].[ADDR1] FROM dbo.T1 a JOIN dbo.T2 b ON a.ID = b.ID";
    const marked = markHitTokens(tokenizeSql(sql), "ADDR1");
    expect(marked.map((tk) => tk.text).join("")).toBe(sql);
    expect(marked.filter((tk) => tk.hit).map((tk) => tk.text)).toEqual(["a.ADDR1", "[ADDR1]"]);
  });
});
