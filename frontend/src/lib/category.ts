/** 테이블명 → 업무 카테고리 매핑 / table-name prefix to business category. */

export const CATEGORY_LABELS: Record<string, string> = {
  HR: "인사", ORG: "조직", ORD: "수주", ITM: "품목", PRD: "생산", BOM: "BOM",
  SHP: "출하", INV: "재고", WMS: "창고", PUR: "구매", VND: "협력사", FIN: "재무",
  ACC: "회계", CST: "원가", CRM: "고객", QC: "품질", EQP: "설비", MNT: "보전",
  PLN: "계획", MES: "제조실행", LAB: "시험", EDU: "교육", DOC: "문서",
  SYS: "시스템", LOG: "로그", APV: "결재", EXT: "인터페이스",
};

/** T_/TB_/뷰(V_·V_SUM_·V_RPT_) 접두어 제거 후 첫 토큰이 카테고리 코드.
 * Strip style and view prefixes, then the first token is the category code. */
export function deriveCategoryCode(tableName: string): string {
  const stripped = tableName
    .replace(/^TB_/, "")
    .replace(/^T_/, "")
    .replace(/^V_(SUM_|RPT_)?/, "");
  const code = stripped.split("_")[0];
  return code in CATEGORY_LABELS ? code : "ETC";
}

export function categoryLabel(code: string): string {
  return CATEGORY_LABELS[code] ?? "기타";
}
