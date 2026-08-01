import { describe, expect, it } from "vitest";

import { categoryLabel, deriveCategoryCode } from "./category";

describe("deriveCategoryCode", () => {
  it("strips style prefixes and maps the first token", () => {
    expect(deriveCategoryCode("T_HR_EMP")).toBe("HR");
    expect(deriveCategoryCode("TB_QC_SAMPLE_RSLT")).toBe("QC");
    expect(deriveCategoryCode("MES_BATCH_HDR")).toBe("MES");
  });

  it("falls back to ETC for unknown prefixes", () => {
    expect(deriveCategoryCode("ZZZ_FOO")).toBe("ETC");
    expect(categoryLabel("ETC")).toBe("기타");
  });

  it("maps codes to Korean labels", () => {
    expect(categoryLabel("PRD")).toBe("생산");
    expect(categoryLabel("QC")).toBe("품질");
  });
});
