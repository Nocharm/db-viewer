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
  "tablelist.countSuffix": { ko: "개", en: " objects" },

  "detail.empty": { ko: "왼쪽 목록에서 테이블을 선택하세요", en: "Select a table from the list" },
  "detail.preview": { ko: "미리보기 TOP 20", en: "Preview TOP 20" },
  "detail.loading": { ko: "조회 중…", en: "Loading…" },
  "detail.openErd": { ko: "ERD 보기 →", en: "Open ERD →" },
  "detail.columns": { ko: "컬럼", en: "Columns" },
  "detail.columnsHint": { ko: "클릭하면 ERD에서 조인 검증", en: "click to validate joins in the ERD" },
  "detail.usingViews": { ko: "이 테이블을 사용하는 뷰", en: "Views using this table" },
  "detail.baseTables": { ko: "구성 테이블 (lineage)", en: "Base tables (lineage)" },
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
  "preview.csv": { ko: "CSV 다운로드", en: "Download CSV" },
  "preview.limitTitle": { ko: "표시 행수", en: "Row limit" },
  "preview.columnsMenu": { ko: "컬럼", en: "Columns" },
  "preview.showAllColumns": { ko: "모두 표시", en: "Show all" },
  "preview.sortAsc": { ko: "오름차순 정렬", en: "Sort ascending" },
  "preview.sortDesc": { ko: "내림차순 정렬", en: "Sort descending" },
  "preview.clearSort": { ko: "정렬 해제", en: "Clear sort" },
  "preview.hideColumn": { ko: "이 컬럼 숨기기", en: "Hide this column" },
  "preview.uniqueValues": { ko: "고유값 보기", en: "Unique values" },
  "preview.uniqueBasis": { ko: "로드된 {n}행 기준", en: "based on {n} loaded rows" },
  "preview.valueHeader": { ko: "값", en: "Value" },
  "preview.countHeader": { ko: "건수", en: "Count" },
  "preview.split": { ko: "분할", en: "Split" },
  "preview.single": { ko: "단일", en: "Single" },
  "preview.sqlView": { ko: "SQL로 보기", en: "View as SQL" },
  "preview.sqlHint": {
    ko: "현재 화면(보이는 컬럼·필터·정렬·행수)과 동치인 쿼리입니다.",
    en: "The query equivalent of the current view (visible columns, filter, sort, limit).",
  },
  "preview.copy": { ko: "클립보드 복사", en: "Copy to clipboard" },
  "preview.copied": { ko: "복사됨 ✓", en: "Copied ✓" },
  "preview.copyFailed": { ko: "복사 실패 — 직접 선택해 복사하세요", en: "Copy failed — select manually" },

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
  "erd.aiNotice": { ko: "AI 제안: {s}건 판정, {n}건 생성 — 검증 큐에서 확인", en: "AI suggestions: {s} judged, {n} created — see the validation queue" },
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
  "erd.searchOpen": { ko: "테이블 검색 열기", en: "Open table search" },
  "erd.searchClose": { ko: "접기", en: "Fold" },
  "erd.hideTable": { ko: "이 테이블 숨기기", en: "Hide this table" },
  "erd.hideOthers": { ko: "다른 테이블 모두 숨기기", en: "Hide all others" },
  "erd.hiddenTables": { ko: "숨긴 테이블", en: "Hidden tables" },
  "erd.showAll": { ko: "모두 표시", en: "Show all" },
  "erd.noHidden": { ko: "숨긴 테이블 없음", en: "No hidden tables" },
  "erd.legendConfirmed": { ko: "확정 (FK·사용자 확정)", en: "Confirmed (FK / user)" },
  "erd.legendInferredGrade": { ko: "추정 (검증·AI 제안)", en: "Inferred (validated / AI)" },
  "erd.legendUnresolvedGrade": { ko: "미검증", en: "Unverified" },
  "erd.legendLineageGrade": { ko: "뷰 계보", en: "View lineage" },
  "erd.legendToggle": { ko: "범례", en: "Legend" },
  "erd.expandColumns": { ko: "컬럼 펼치기", en: "Expand columns" },
  "erd.collapseColumns": { ko: "접기", en: "Collapse" },
  "erd.expandNeighbors": { ko: "이웃 1-hop 확장", en: "Expand 1-hop neighbors" },
  "erd.showViews": { ko: "뷰 표시", en: "Show views" },
  "erd.viewsHidden": { ko: "뷰 {n}개 숨김", en: "{n} views hidden" },
  "erd.viewsHiddenTip": {
    ko: "뷰를 통해서만 이어지던 경로는 끊겨 보입니다 — 켜면 복원됩니다.",
    en: "Paths that only ran through views appear broken — turn views on to restore them.",
  },
  "erd.viewConfirm": {
    ko: "뷰를 포함하면 {n}개 노드를 그립니다. 계속할까요?",
    en: "Including views renders {n} nodes. Continue?",
  },

  "panel.verify": { ko: "T2 검증", en: "Verify (T2)" },
  "panel.preview20": { ko: "미리보기 20행", en: "Preview 20 rows" },
  "panel.confirm": { ko: "확정", en: "Confirm" },
  "panel.noCandidates": { ko: "후보 없음", en: "No candidates" },
  "panel.history": { ko: "검증 이력", en: "Validation history" },

  "collect.title": { ko: "카탈로그 수집", en: "Catalog collection" },
  "collect.hint": {
    ko: "n8n에 수집을 트리거하고 단계 진행을 추적합니다 (로컬은 픽스처 리플레이)",
    en: "Triggers n8n collection and tracks stages (local replays fixtures)",
  },
  "collect.step1": { ko: "1단계: 카탈로그 수집", en: "Step 1: collect catalog" },
  "collect.step2": { ko: "2단계: 뷰 의존·파싱", en: "Step 2: view deps & parsing" },
  "collect.full": { ko: "전체 실행", en: "Run all" },
  "collect.stageCatalogRunning": { ko: "카탈로그 수집 중", en: "Collecting catalog" },
  "collect.stageCatalogDone": { ko: "카탈로그 적재 완료", en: "Catalog loaded" },
  "collect.stageDepsRunning": { ko: "뷰 의존·파싱 중", en: "Parsing view deps" },
  "collect.stageReady": { ko: "완료", en: "Ready" },
  "collect.failed": { ko: "실패", en: "Failed" },
  "collect.chunkProgress": { ko: "분할 진행", en: "Chunk progress" },
  "collect.cancel": { ko: "중단", en: "Cancel" },
  "collect.cancelHint": {
    ko: "n8n 실행은 그대로 두고 잡만 닫습니다 — 멈춘 잡이 새 수집을 막을 때 사용",
    en: "Closes the job only (the n8n run keeps going) — use when a stuck job blocks a new collection",
  },
  "collect.recent": { ko: "최근 수집 잡", en: "Recent jobs" },
  "collect.none": { ko: "수집 이력 없음", en: "No collection history" },
  "collect.snapshot": { ko: "스냅샷", en: "snapshot" },

  "admin.embedIndexTitle": { ko: "AI 임베딩 인덱싱", en: "AI embedding index" },
  "admin.embedIndexHint": {
    ko: "테이블 임베딩을 상한·배치·대기로 나눠 생성합니다 — 재실행이 남은 분량을 이어갑니다.",
    en: "Builds table embeddings in capped, throttled batches — reruns continue where it left off.",
  },
  "admin.embedIndexButton": { ko: "인덱싱 시작", en: "Start indexing" },
  "admin.embedIndexRunning": { ko: "인덱싱 중…", en: "Indexing…" },
  "admin.embedIndexProgress": { ko: "진행", en: "Progress" },
  "admin.embedIndexDone": {
    ko: "완료 — 인덱싱 {indexed} · 스킵 {skipped} · 잔여 {remaining}",
    en: "Done — indexed {indexed} · skipped {skipped} · remaining {remaining}",
  },
  "admin.embedIndexFailed": { ko: "인덱싱 실패", en: "Indexing failed" },

  "check.title": { ko: "조인 검증", en: "Join validation" },
  "check.fetchingCandidates": { ko: "후보 조회 중…", en: "Finding candidates…" },
  "check.validating": { ko: "실데이터 검증 중", en: "Validating with real data" },
  "check.longRunHint": {
    ko: "원본에 집계 질의를 보내는 중입니다 — 큰 테이블은 수십 초 걸릴 수 있습니다.",
    en: "Running aggregate queries on the source — large tables can take a while.",
  },
  "check.summaryTitle": { ko: "검증 요약", en: "Validation summary" },
  "check.excluded": { ko: "검증 제외", en: "Excluded from validation" },
  "check.noCandidates": { ko: "조인 후보 없음", en: "No join candidates" },
  "check.noData": { ko: "값 데이터 없음", en: "no value data" },
  "check.failed": { ko: "실패", en: "failed" },
  "check.target": { ko: "대상", en: "Target" },
  "check.goErd": { ko: "ERD에서 상세 검증 →", en: "Continue in the ERD →" },
  "check.back": { ko: "돌아가기", en: "Back" },

  "ai.generateSummary": { ko: "AI 요약 생성", en: "Generate AI summary" },
  "ai.explainView": { ko: "AI 설명", en: "AI explanation" },
  "ai.explainValidation": { ko: "AI 해석", en: "Explain with AI" },
  "ai.working": { ko: "생성 중…", en: "Generating…" },
  "ai.failed": { ko: "AI 작업 실패", en: "AI job failed" },
  "ai.mockBadge": { ko: "AI 미연결 — 목업", en: "AI offline — mock" },

  "chat.title": { ko: "스키마 Q&A", en: "Schema Q&A" },
  "chat.placeholder": { ko: "스키마에 대해 질문…", en: "Ask about the schema…" },
  "chat.send": { ko: "전송", en: "Send" },
  "chat.mockBadge": { ko: "AI 미연결 — 목업 응답", en: "AI offline — mock reply" },
  "chat.emptyHint": {
    ko: "예: 수주와 출하를 잇는 테이블은?",
    en: "e.g. which tables link orders to shipping?",
  },
  "chat.you": { ko: "나", en: "You" },

  "browser.categories": { ko: "카테고리", en: "Categories" },
  "browser.dbTab": { ko: "DB", en: "DB" },
  "db.showAll": { ko: "필터 해제", en: "Clear" },
  "db.checkAll": { ko: "전체 선택", en: "Select all" },
  "db.editCategory": { ko: "카테고리 변경 — 이 DB의 테이블이 함께 이동", en: "Change category — moves the whole DB" },
  "db.categoryPlaceholder": { ko: "카테고리명 (비우면 DB명)", en: "Category (empty = DB name)" },
  "tip.dbFilter": {
    ko: "체크한 DB만 목록·카테고리에 표시됩니다. 선택은 이 브라우저에 저장됩니다. DB명을 눌러 카테고리를 바꾸면 그 DB의 테이블이 통째로 이동합니다 (전원 공용).",
    en: "Only checked DBs appear. The selection is stored in this browser; category changes are shared with everyone.",
  },

  "tip.joinKeys": {
    ko: "FK·뷰 JOIN·검증된 관계에서 집계한 조인 키입니다. 칩을 누르면 그 키로 조인되는 테이블만 목록에 남습니다.",
    en: "Join keys aggregated from FKs, view JOINs and validated relations. Pick one to keep only tables joinable by it.",
  },
  "tip.categories": {
    ko: "테이블명 접두어(HR·ORD 등)로 나눈 업무 분류입니다. 뷰는 V_ 접두어를 벗겨 같은 기준으로 분류합니다.",
    en: "Business buckets derived from name prefixes (HR, ORD…). Views classify the same way after stripping V_.",
  },
  "tip.tableList": {
    ko: "테이블·뷰 목록입니다. 이름·컬럼·카테고리로 검색(한글 초성 지원)하고 타입 칩으로 좁힙니다.",
    en: "Tables and views. Search by name, column or category (Korean initials supported); narrow with the type chips.",
  },
  "tip.columns": {
    ko: "이 객체의 컬럼입니다. 칩을 누르면 ERD 검증 패널이 열려 그 컬럼의 조인 후보를 실데이터로 검증할 수 있습니다. 초록 테두리는 키로 쓰이는 컬럼.",
    en: "Columns of this object. Click a chip to open the ERD validation panel and verify join candidates with real data. Green border = key column.",
  },
  "tip.joinCheck": {
    ko: "타깃 테이블별 최고 후보 컬럼 페어에 실데이터 포함률(T2) 검증을 일괄 실행합니다. 값 데이터가 없는 페어는 배지로만 표시됩니다.",
    en: "Runs containment (T2) on the best candidate pair per target table. Pairs without value data are just badged.",
  },
  "tip.usingViews": {
    ko: "lineage 역추적으로 찾은, 이 테이블을 원천으로 쓰는 뷰들입니다. depth는 중첩 단계입니다.",
    en: "Views that resolve to this table via lineage. Depth is the nesting level.",
  },
  "tip.baseTables": {
    ko: "이 뷰가 최종적으로 읽는 원천 테이블입니다. 뷰 정의 파싱과 lineage로 복원했습니다.",
    en: "Base tables this view ultimately reads, recovered from definition parsing and lineage.",
  },
  "tip.similar": {
    ko: "컬럼명 일치율 30% 이상인 테이블입니다. 구조가 비슷하면 같은 도메인일 가능성이 있고, 검증 버튼으로 조인 가능성을 바로 확인할 수 있습니다.",
    en: "Tables sharing ≥30% of column names. Similar structure hints at the same domain; Check verifies joinability.",
  },
  "tip.fk": {
    ko: "카탈로그에 선언된 실제 FK 제약입니다. →는 이 테이블이 참조, ←는 피참조.",
    en: "Real FK constraints from the catalog. → outgoing, ← incoming.",
  },
  "tip.relations": {
    ko: "실데이터 검증을 통과했거나(추정) 사람이 확정(✓)한 관계입니다. 숫자는 신뢰도.",
    en: "Relations that passed validation (inferred) or were confirmed (✓). The number is confidence.",
  },
  "tip.preview": {
    ko: "원본 소스에 새 질의를 보내 받은 상위 N행입니다. 필터·행수 변경은 재질의하고, 정렬·고유값은 로드된 행 기준입니다.",
    en: "Top-N rows from a fresh source query. Filter and limit re-query; sort and unique values use the loaded rows.",
  },

  "scan.button": { ko: "전수 탐색 (T3)", en: "Full scan (T3)" },
  "scan.hint": {
    ko: "이름과 무관하게 타입 호환 전 컬럼을 샘플→정밀 2단계로 훑습니다.",
    en: "Name-agnostic sweep of every type-compatible column, sample then full recheck.",
  },
  "scan.queued": { ko: "대기 중…", en: "Queued…" },
  "scan.running": { ko: "탐색 중", en: "Scanning" },
  "scan.results": { ko: "탐색 결과 (상위)", en: "Top hits" },
  "scan.none": { ko: "탐색 결과 없음", en: "No hits" },
  "scan.failed": { ko: "탐색 실패", en: "Scan failed" },

  "erd.graphLoading": { ko: "그래프 계산 중…", en: "Computing graph…" },

  "common.seconds": { ko: "{n}초", en: "{n}s" },
  "common.none": { ko: "없음", en: "None" },
  "common.loading": { ko: "불러오는 중…", en: "Loading…" },
} as const;

export type MessageKey = keyof typeof MESSAGES;

export function getMessage(key: MessageKey, lang: Lang): string {
  return MESSAGES[key][lang];
}
