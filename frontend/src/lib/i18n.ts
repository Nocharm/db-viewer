/** 한/영 UI 문자열 사전 — 라이브러리 없는 경량 i18n. / dictionary for the ko/en toggle. */

export type Lang = "ko" | "en";

export const LANG_STORAGE_KEY = "dbv.lang";

// 카테고리 라벨(생산·품질 등)은 도메인 데이터라 사전 대상에서 제외 / domain labels stay Korean
export const MESSAGES = {
  "nav.tables": { ko: "테이블", en: "Tables" },
  "nav.verify": { ko: "조인 검증", en: "Join Verify" },
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
  "detail.columnsMore": { ko: "컬럼 더보기", en: "Show all columns" },
  "detail.columnsFold": { ko: "컬럼 접기", en: "Fold columns" },
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
    ko: "검증된 관계 없음 — ERD에서 조인을 만들어 발견하세요",
    en: "No validated relations — build a join in the ERD to discover them",
  },
  "detail.inferred": { ko: "추정", en: "inferred" },

  "joincheck.title": { ko: "조인 가능성 찾기", en: "Find joinable tables" },
  "joincheck.hint": {
    ko: "타깃 테이블별 최고 후보 컬럼 페어에 실데이터 포함률 검증을 일괄 실행합니다. 값 데이터가 없는 페어는 배지로만 표시됩니다.",
    en: "Runs containment on the best candidate pair per target table. Pairs without value data are just badged.",
  },
  "joincheck.checkAll": { ko: "후보 일괄 검증", en: "Check all candidates" },
  "joincheck.check": { ko: "검증", en: "Check" },
  "joincheck.running": { ko: "검증 중…", en: "Checking…" },
  "joincheck.noData": { ko: "값 데이터 없음", en: "no value data" },
  "joincheck.noTargets": { ko: "후보 타깃 없음", en: "No candidate targets" },
  "joincheck.addToBuilder": { ko: "빌더에 추가", en: "Add to builder" },

  "preview.title": { ko: "미리보기", en: "Preview" },
  "preview.masked": { ko: "마스킹", en: "masked" },
  "preview.maskedSuffix": { ko: "컬럼", en: "cols" },
  "preview.rowsSuffix": { ko: "건", en: "rows" },
  "preview.selectColumn": { ko: "필터 컬럼 선택", en: "Select filter column" },
  // 매칭 방식은 옆 셀렉트가 말한다 — 플레이스홀더는 값 자체만 / the mode select owns the wording
  "preview.valuePlaceholder": { ko: "값", en: "Value" },
  "preview.matchContains": { ko: "부분 일치", en: "Contains" },
  "preview.matchExact": { ko: "정확 일치", en: "Exact" },
  "preview.matchModeTitle": { ko: "값 매칭 방식 — 소스 쿼리 WHERE로 내려간다", en: "Value match mode, pushed into the source WHERE clause" },
  // SQL 보기의 컬럼 칩 편집 / pill-based column editing in the SQL view
  "preview.editColumns": { ko: "컬럼 편집", en: "Edit columns" },
  "preview.editColumnsHint": {
    ko: "×나 Backspace로 컬럼을 빼고 적용 — 뺀 컬럼은 일괄 숨김, 남은 순서가 표시 순서",
    en: "Remove pills with × or Backspace, then apply — removed columns hide in bulk",
  },
  "preview.applyColumns": { ko: "적용", en: "Apply" },
  "preview.resetColumns": { ko: "초기화", en: "Reset" },
  "preview.editColumnsEmpty": {
    ko: "최소 한 개 컬럼은 남겨야 합니다",
    en: "Keep at least one column",
  },
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
  // 0행일 때 "원본이 실제로 비었다"임을 밝힌다 — 실행기 미연결과 헷갈리지 않게
  "preview.emptyLive": {
    ko: "원본 소스가 0행을 반환했습니다 (쿼리는 실행됨)",
    en: "The source returned 0 rows (the query did run)",
  },
  // HIDDEN_SCHEMAS — 이름은 남고 컬럼·진입만 막히는 스키마 / hidden-schema surface
  "hidden.badge": { ko: "컬럼 비공개", en: "Columns hidden" },
  "hidden.notNavigable": {
    ko: "컬럼을 공개하지 않는 스키마입니다 — 이 테이블로는 이동할 수 없습니다",
    en: "This schema does not expose its columns — you cannot navigate into this table",
  },
  "hidden.columns": {
    ko: "이 스키마는 컬럼을 공개하지 않습니다 (서버 설정)",
    en: "This schema does not expose its columns (server configuration)",
  },
  "preview.notAllowed": { ko: "미리보기 미허용", en: "Preview not allowed" },
  "preview.notAllowedHint": {
    ko: "이 테이블의 스키마가 미리보기 허용 목록에 없습니다 — 관리자에게 요청하세요",
    en: "This table's schema is not on the preview allowlist — ask an admin to add it",
  },
  // 스키마·카테고리 행의 자물쇠 툴팁 / lock-icon tooltips on schema and category rows
  "preview.schemaLocked": {
    ko: "미리보기 미허용 스키마 — 관리자에게 요청하세요",
    en: "Schema not on the preview allowlist — ask an admin to add it",
  },
  "preview.schemaAllowed": {
    ko: "미리보기 허용 스키마",
    en: "Schema on the preview allowlist",
  },
  "preview.categoryHasAllowed": {
    ko: "미리보기 허용 스키마 포함",
    en: "Contains preview-allowed schemas",
  },
  "preview.categoryHasLocked": {
    ko: "미리보기 미허용 스키마 포함",
    en: "Contains schemas not on the preview allowlist",
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

  "erd.typeAll": { ko: "전체", en: "All" },
  "erd.typeTable": { ko: "테이블", en: "Tables" },
  "erd.typeView": { ko: "뷰", en: "Views" },
  "erd.noResults": { ko: "결과 없음", en: "No results" },
  "erd.aiNotice": { ko: "AI 제안: {s}건 판정, {n}건 생성 — 검증 큐에서 확인", en: "AI suggestions: {s} judged, {n} created — see the validation queue" },
  "erd.cancel": { ko: "취소", en: "Cancel" },
  "erd.moreColumns": { ko: "… {n}개 더 불러오는 중", en: "… loading {n} more" },
  "erd.unresolved": { ko: "미해석", en: "unresolved" },
  "erd.legendConfirmed": { ko: "확정 (FK·사용자 확정)", en: "Confirmed (FK / user)" },
  "erd.legendInferredGrade": { ko: "추정 (검증·AI 제안)", en: "Inferred (validated / AI)" },
  "erd.legendUnresolvedGrade": { ko: "미검증", en: "Unverified" },
  "erd.legendLineageGrade": { ko: "뷰 계보", en: "View lineage" },
  "erd.legendToggle": { ko: "범례", en: "Legend" },
  "erd.expandColumns": { ko: "컬럼 펼치기", en: "Expand columns" },
  "erd.collapseColumns": { ko: "접기", en: "Collapse" },
  "erd.expandNeighbors": { ko: "이웃 1-hop 확장", en: "Expand 1-hop neighbors" },
  "erd.resetPositions": { ko: "노드 위치 초기화", en: "Reset node positions" },
  "erd.emptyReadOnly": {
    ko: "검증된 관계가 아직 없습니다 — 조인 검증에서 키를 확정하면 여기 그려집니다",
    en: "No verified relations yet — confirm a key in Join Verify and it shows up here",
  },
  "erd.focusMissing": { ko: "{label}은 아직 검증되지 않았습니다", en: "{label} has not been verified yet" },
  "erd.goVerify": { ko: "조인 검증으로", en: "Open Join Verify" },
  "erd.edgeVerifiedAt": { ko: "검증 시각", en: "Verified at" },
  "erd.searchPlaceholder": { ko: "ERD에서 테이블 찾기", en: "Find a table in the ERD" },
  "erd.searchEmpty": {
    ko: "그래프에 없는 테이블입니다 — 검증된 테이블만 그려집니다",
    en: "Not in the graph — only verified tables are drawn",
  },
  // 좌측 스키마 필터 / left-rail schema filter
  "erd.schemaFilter": { ko: "스키마", en: "Schemas" },
  "erd.filterAll": { ko: "전체", en: "All" },
  // 노드 우클릭 메뉴 / node context menu
  "erd.menuPreview": { ko: "미리보기", en: "Preview" },
  "erd.menuDetail": { ko: "테이블 상세로", en: "Open table detail" },
  "erd.menuVerify": { ko: "조인 검증하기", en: "Verify a join" },
  "erd.menuCopyName": { ko: "테이블명 복사", en: "Copy table name" },
  "erd.menuCopied": { ko: "복사됨", en: "Copied" },

  "panel.verify": { ko: "조인 검증", en: "Check join" },

  // /verify — 게이트 → 포함률 → 미리보기 → 확정 4단계 화면 / the four-step verification page
  "verify.startHint": {
    ko: "왼쪽에서 테이블 두 개를 고르세요",
    en: "Pick two tables on the left",
  },
  "verify.srcTitle": { ko: "출발 테이블", en: "Source table" },
  "verify.tgtTitle": { ko: "대상 테이블", en: "Target table" },
  "verify.searchPlaceholder": { ko: "테이블 검색", en: "Search tables" },
  "verify.clearSelection": { ko: "선택 해제", en: "Clear" },
  "verify.candidates.title": { ko: "컬럼 페어 후보", en: "Column pair candidates" },
  "verify.candidates.empty": {
    ko: "후보 없음 — 아래에서 직접 고르세요",
    en: "No candidates — pick the columns manually below",
  },
  "verify.candidates.manual": { ko: "직접 고르기", en: "Pick manually" },
  "verify.gate.title": { ko: "1단계 · 사전 게이트", en: "Step 1 · Pre-gate" },
  "verify.gate.run": { ko: "게이트 실행", en: "Run gate" },
  "verify.gate.pass": { ko: "통과 — 검증할 수 있습니다", en: "Passed — ready to validate" },
  "verify.gate.typeMismatch": {
    ko: "타입 불일치 ({src} vs {tgt}) — 조인 불가",
    en: "Type mismatch ({src} vs {tgt}) — cannot join",
  },
  "verify.gate.bothLowDistinct": {
    ko: "양측 모두 중복 심함 (m:n 추정) — 다른 컬럼을 선택하세요",
    en: "Both sides are highly duplicated (likely m:n) — pick another column",
  },
  "verify.gate.ratioLabel": { ko: "표본 유니크 비율", en: "Sample distinct ratio" },
  "verify.containment.title": { ko: "2단계 · 포함률 검증", en: "Step 2 · Containment" },
  "verify.containment.run": { ko: "포함률 검증", en: "Run containment" },
  "verify.preview.title": { ko: "3단계 · 샘플 확인", en: "Step 3 · Sample check" },
  "verify.preview.join": { ko: "조인 샘플 보기", en: "Show join sample" },
  "verify.preview.sample": { ko: "Top 200 샘플", en: "Top 200 sample" },
  "verify.preview.notAllowed": {
    ko: "미리보기 허용 목록에 없는 스키마입니다 — 관리자에게 요청하세요",
    en: "This schema is not on the preview allowlist — ask an admin to add it",
  },
  "verify.confirm.title": { ko: "4단계 · 확정", en: "Step 4 · Confirm" },
  "verify.confirm.button": { ko: "키 확정", en: "Confirm key" },
  "verify.confirm.done": { ko: "확정됨 — 관계 큐에서 내려갑니다", en: "Confirmed — removed from the queue" },
  "verify.pending.title": { ko: "검증 대기 관계", en: "Pending relations" },
  "verify.pending.empty": { ko: "대기 중인 관계 없음", en: "No pending relations" },
  "verify.pending.emptyFiltered": {
    ko: "선택한 테이블 관련 대기 항목이 없습니다",
    en: "No pending items involve the selected tables",
  },
  "verify.pending.aiSuggest": { ko: "AI 관계 제안", en: "AI relation suggestions" },

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

  "ai.generateSummary": { ko: "AI 요약 생성", en: "Generate AI summary" },
  "ai.explainView": { ko: "AI 설명", en: "AI explanation" },
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
  // 미지정 DB의 고스트 칩 — 스키마명 반복 대신 지정 유도 / ghost chip for unmapped DBs
  "db.addCategory": { ko: "+ 분류", en: "+ Category" },
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
    ko: "타깃 테이블별 최고 후보 컬럼 페어에 실데이터 포함률 검증을 일괄 실행합니다.",
    en: "Runs containment on the best candidate pair per target table.",
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

  "erd.graphLoading": { ko: "그래프 계산 중…", en: "Computing graph…" },

  "common.seconds": { ko: "{n}초", en: "{n}s" },
  "common.none": { ko: "없음", en: "None" },
  "common.loading": { ko: "불러오는 중…", en: "Loading…" },

  // 수치 패널 chrome 라벨 — symptom/remedy·PATTERN_LABELS(도메인 문구)는 카테고리 라벨과 같은 이유로 제외
  // chrome labels for the numbers panel — symptom/remedy and PATTERN_LABELS stay out, same reason as category labels
  "join.numbersContainment": { ko: "containment", en: "containment" },
  "join.numbersOrphan": { ko: "고아", en: "orphans" },
  "join.previewMasked": { ko: "마스킹된 컬럼: {cols}", en: "Masked columns: {cols}" },
  "join.previewEmpty": { ko: "조인 결과가 0행입니다", en: "The join returned no rows" },
  "join.confirming": { ko: "확정 중…", en: "Confirming…" },
  "join.confirmFailed": { ko: "확정 실패 — {error}", en: "Confirm failed — {error}" },
} as const;

export type MessageKey = keyof typeof MESSAGES;

export function getMessage(key: MessageKey, lang: Lang): string {
  return MESSAGES[key][lang];
}
