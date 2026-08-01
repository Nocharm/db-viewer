/** 한/영 UI 문자열 사전 — 라이브러리 없는 경량 i18n. / dictionary for the ko/en toggle. */

export type Lang = "ko" | "en";

export const LANG_STORAGE_KEY = "dbv.lang";

// 카테고리 라벨(생산·품질 등)은 도메인 데이터라 사전 대상에서 제외 / domain labels stay Korean
export const MESSAGES = {
  "nav.tables": { ko: "테이블", en: "Tables" },
  "nav.erd": { ko: "ERD", en: "ERD" },
  "nav.parsing": { ko: "파싱 지표", en: "Parse Stats" },
  "nav.admin": { ko: "관리", en: "Admin" },
  "header.themeToggle": { ko: "다크/라이트 전환", en: "Toggle dark/light" },
  "header.langToggle": { ko: "English로 전환", en: "한국어로 전환" },
  "header.logout": { ko: "로그아웃", en: "Sign out" },
  "header.homeTitle": { ko: "처음으로 (필터 초기화)", en: "Home (reset filters)" },

  "joinkeys.all": { ko: "전체", en: "All" },
  "joinkeys.fold": { ko: "접기", en: "Fold" },

  "category.all": { ko: "전체", en: "All" },

  "tablelist.searchPlaceholder": {
    ko: "테이블·컬럼·카테고리 검색 (초성 가능)",
    en: "Search tables · columns · categories",
  },
  "tablelist.empty": { ko: "조건에 맞는 테이블 없음", en: "No tables match" },
  "tablelist.columnPrefix": { ko: "컬럼", en: "column" },

  "detail.empty": { ko: "왼쪽 목록에서 테이블을 선택하세요", en: "Select a table from the list" },
  "detail.preview": { ko: "미리보기 TOP 20", en: "Preview TOP 20" },
  "detail.loading": { ko: "조회 중…", en: "Loading…" },
  "detail.openErd": { ko: "ERD 보기 →", en: "Open ERD →" },
  "detail.columns": { ko: "컬럼", en: "Columns" },
  "detail.columnsHint": { ko: "클릭하면 ERD에서 조인 검증", en: "click to validate joins in the ERD" },
  "detail.usingViews": { ko: "이 테이블을 사용하는 뷰", en: "Views using this table" },
  "detail.similar": { ko: "유사 테이블 (컬럼명 일치율)", en: "Similar tables (column match)" },
  "detail.none": { ko: "없음", en: "None" },
  "detail.noSimilar": { ko: "일치율 30% 이상 없음", en: "No match above 30%" },
  "detail.fk": { ko: "FK 관계", en: "FK relations" },
  "detail.fkOut": { ko: "참조", en: "out" },
  "detail.fkIn": { ko: "피참조", en: "in" },
  "detail.noFk": { ko: "FK 없음", en: "No FKs" },
  "detail.relations": { ko: "추론·확정 관계", en: "Inferred · confirmed relations" },
  "detail.noRelations": {
    ko: "검증된 관계 없음 — ERD에서 T2 검증으로 발견",
    en: "No validated relations — discover via T2 in the ERD",
  },
  "detail.inferred": { ko: "추정", en: "inferred" },

  "joincheck.title": { ko: "조인 가능성 검증", en: "Join-ability check" },
  "joincheck.hint": {
    ko: "타깃 테이블별 최고 후보 컬럼 페어에 T2 검증 실행",
    en: "Runs T2 containment on the best pair per target table",
  },
  "joincheck.checkAll": { ko: "후보 일괄 검증", en: "Check all candidates" },
  "joincheck.check": { ko: "검증", en: "Check" },
  "joincheck.running": { ko: "검증 중…", en: "Checking…" },
  "joincheck.noData": { ko: "값 데이터 없음", en: "no value data" },
  "joincheck.noTargets": { ko: "후보 타깃 없음", en: "No candidate targets" },

  "preview.title": { ko: "미리보기", en: "Preview" },
  "preview.masked": { ko: "마스킹", en: "masked" },
  "preview.maskedSuffix": { ko: "컬럼", en: "cols" },
  "preview.rowsSuffix": { ko: "건", en: "rows" },
  "preview.selectColumn": { ko: "필터 컬럼 선택", en: "Select filter column" },
  "preview.valuePlaceholder": { ko: "값 (부분 일치)", en: "Value (partial match)" },
  "preview.requery": { ko: "조건으로 재조회", en: "Re-query with filter" },
  "preview.requeryHint": {
    ko: "원본에 새 질의를 보냅니다 (로컬은 합성 데이터)",
    en: "Sends a fresh query to the source (local: synthetic data)",
  },
  "preview.clear": { ko: "필터 해제", en: "Clear filter" },
  "preview.empty": {
    ko: "조건에 맞는 행 없음 — 필터를 완화해 보세요",
    en: "No rows match — try relaxing the filter",
  },

  "parsing.title": { ko: "파싱 지표", en: "Parse metrics" },
  "parsing.snapshot": { ko: "스냅샷", en: "snapshot" },
  "parsing.successRate": { ko: "파싱 성공률", en: "Parse success rate" },
  "parsing.totalViews": { ko: "전체 뷰", en: "Total views" },
  "parsing.ok": { ko: "파싱 성공", en: "Parsed" },
  "parsing.partial": { ko: "부분 해석", en: "Partial" },
  "parsing.unsupported": { ko: "미지원", en: "Unsupported" },
  "parsing.failed": { ko: "파싱 실패", en: "Failed" },
  "parsing.noDefinition": { ko: "정의 없음(권한)", en: "No definition (perms)" },
  "parsing.isolated": {
    ko: "격리된 뷰 (파싱 실패 · 미지원)",
    en: "Isolated views (failed · unsupported)",
  },
  "parsing.view": { ko: "뷰", en: "View" },
  "parsing.status": { ko: "상태", en: "Status" },
  "parsing.error": { ko: "오류", en: "Error" },

  "erd.searchPlaceholder": { ko: "검색 (2자+) — ?로 시작하면 AI 탐색", en: "Search (2+ chars) — ? for AI" },
  "erd.typeAll": { ko: "전체", en: "All" },
  "erd.typeTable": { ko: "테이블", en: "Tables" },
  "erd.typeView": { ko: "뷰", en: "Views" },
  "erd.noResults": { ko: "결과 없음", en: "No results" },
  "erd.startHint": { ko: "테이블을 검색해 시작하세요", en: "Search a table to start" },
  "erd.aiSuggest": { ko: "AI 관계 제안", en: "AI relation suggestions" },
  "erd.aiNotice": { ko: "AI 제안 {n}건 생성 — 검증 큐에서 확인", en: "{n} AI suggestions created — see the validation queue" },
  "erd.emptyTitle": { ko: "앵커 테이블로 시작하세요", en: "Start from an anchor table" },
  "erd.emptyBody": {
    ko: "왼쪽에서 검색하거나, 예시를 눌러 바로 열 수 있습니다.",
    en: "Search on the left, or open an example right away.",
  },
  "erd.emptyBody2": {
    ko: "전체 스키마는 렌더링하지 않습니다 — 앵커에서 단계적으로 확장하세요.",
    en: "The full schema never renders — expand stepwise from the anchor.",
  },
  "erd.confirmTitle": { ko: "노드 {n}개를 렌더링할까요?", en: "Render {n} nodes?" },
  "erd.confirmBody": {
    ko: "이번 확장으로 {n}개가 추가됩니다. 큰 그래프는 탐색이 느려질 수 있습니다.",
    en: "This expansion adds {n} nodes. Large graphs can get slow.",
  },
  "erd.cancel": { ko: "취소", en: "Cancel" },
  "erd.render": { ko: "렌더링", en: "Render" },
  "erd.expandAll": { ko: "모두 펼치기", en: "Expand all" },
  "erd.collapseAll": { ko: "모두 접기", en: "Collapse all" },
  "erd.dblClickHint": { ko: "더블클릭 = 펼치기/접기", en: "double-click toggles a node" },
  "erd.moreColumns": { ko: "… 외 {n}개 컬럼", en: "… {n} more columns" },
  "erd.unresolved": { ko: "미해석", en: "unresolved" },
  "erd.legendFk": { ko: "확정 (FK)", en: "Confirmed (FK)" },
  "erd.legendInferred": { ko: "추정 (검증 통과)", en: "Inferred (validated)" },
  "erd.legendAi": { ko: "AI 제안 (미검증)", en: "AI suggested (unverified)" },
  "erd.legendLineage": { ko: "뷰 lineage", en: "View lineage" },
  "erd.legendUnresolved": { ko: "미해석", en: "Unresolved" },
  "erd.expandColumns": { ko: "컬럼 펼치기", en: "Expand columns" },
  "erd.collapseColumns": { ko: "접기", en: "Collapse" },
  "erd.expandNeighbors": { ko: "이웃 1-hop 확장", en: "Expand 1-hop neighbors" },

  "panel.verify": { ko: "T2 검증", en: "Verify (T2)" },
  "panel.preview20": { ko: "미리보기 20행", en: "Preview 20 rows" },
  "panel.confirm": { ko: "확정", en: "Confirm" },
  "panel.noCandidates": { ko: "후보 없음", en: "No candidates" },
  "panel.history": { ko: "검증 이력", en: "Validation history" },

  "common.none": { ko: "없음", en: "None" },
  "common.loading": { ko: "불러오는 중…", en: "Loading…" },
} as const;

export type MessageKey = keyof typeof MESSAGES;

export function getMessage(key: MessageKey, lang: Lang): string {
  return MESSAGES[key][lang];
}
