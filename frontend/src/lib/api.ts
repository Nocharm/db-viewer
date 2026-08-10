/** 백엔드 조회 API 클라이언트 / thin fetch wrappers for the query API. */

import type {
  AiTableHit,
  CandidatesResponse,
  ContainmentResponse,
  ErdResponse,
  SearchResponse,
} from "./types";

// 토큰은 렌더 단계에서 동기 주입된다 — effect는 자식 fetch와 레이스 (bpm 패턴)
// token set during render, not in an effect, to avoid first-fetch 401 races
let authToken: string | null = null;
export function setAuthToken(token: string | null): void {
  authToken = token;
}
// auth OFF 개발 모드 전용 / dev-mode identity when auth is disabled
let devUser: string | null = "dev.user";
export function setDevUser(loginId: string | null): void {
  devUser = loginId;
}

function authHeaders(): Record<string, string> {
  if (authToken) return { Authorization: `Bearer ${authToken}` };
  if (devUser) return { "X-Dev-User": devUser };
  return {};
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // 백엔드 에러 규약: {"error": {code, message, context}}
    const body = await res.json().catch(() => null);
    const message = body?.error?.message ?? `request failed (${res.status})`;
    throw new Error(message);
  }
  return res.json();
}

async function getJson<T>(url: string): Promise<T> {
  return handle(await fetch(url, { headers: authHeaders() }));
}

async function postJson<T>(
  url: string, body: unknown, extraHeaders?: Record<string, string>,
): Promise<T> {
  return handle(await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
  }));
}

async function putJson<T>(
  url: string, body: unknown, extraHeaders?: Record<string, string>,
): Promise<T> {
  return handle(await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
  }));
}

async function deleteJson<T>(
  url: string, extraHeaders?: Record<string, string>,
): Promise<T> {
  return handle(await fetch(url, {
    method: "DELETE",
    headers: { ...authHeaders(), ...extraHeaders },
  }));
}

export interface Me {
  login_id: string;
  name: string;
  department: string | null;
  whitelisted: boolean;
  is_sysadmin: boolean;
  auth_enabled: boolean;
}

export function fetchMe(): Promise<Me> {
  return getJson("/api/me");
}

export interface WhitelistEntry {
  login_id: string;
  name: string | null;
  note: string | null;
  added_by: string;
  created_at: string;
}

export function fetchWhitelist(): Promise<{ items: WhitelistEntry[] }> {
  return getJson("/api/admin/whitelist");
}

export function addWhitelist(loginId: string, note?: string): Promise<{ created: boolean }> {
  return postJson("/api/admin/whitelist", { login_id: loginId, note });
}

export function removeWhitelist(loginId: string): Promise<{ removed: boolean }> {
  return deleteJson(`/api/admin/whitelist/${encodeURIComponent(loginId)}`);
}

export function syncUsers(): Promise<{ scanned: number; upserted: number; excluded: number; purged: number }> {
  return postJson("/api/admin/users/sync", {});
}

/** AD 동기화로 적재된 사용자 — 화이트리스트와 별개 테이블 / AD-synced users, not the whitelist. */
export interface AppUserEntry {
  login_id: string;
  name: string | null;
  department: string | null;
  email: string | null;
  active: boolean;
  source: string;
  role: string | null;
}

export interface AppUserPage {
  items: AppUserEntry[];
  total: number;
  has_more: boolean;
}

/** 검색은 서버(전체 집합)에서, 결과는 페이지 단위 — 화면이 전량을 들고 있지 않는다. */
export function fetchUsers(
  { q = "", offset = 0, limit = 100 }: { q?: string; offset?: number; limit?: number } = {},
): Promise<AppUserPage> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (q) params.set("q", q);
  return getJson(`/api/admin/users?${params}`);
}

export function searchObjects(q: string, type?: "table" | "view"): Promise<SearchResponse> {
  const params = new URLSearchParams({ q });
  if (type) params.set("type", type);
  return getJson(`/api/objects?${params}`);
}

/** confirmed+FK만 담은 읽기 전용 전체 그래프 — /erd 전용(앵커·검색 없음). */
export function fetchErdGraph(): Promise<ErdResponse> {
  return getJson("/api/erd");
}

export function fetchCandidates(columnId: number): Promise<CandidatesResponse> {
  return getJson(`/api/columns/${columnId}/candidates`);
}

export interface PairCandidate {
  src_column_id: number; src_column: string; src_data_type: string;
  tgt_column_id: number; tgt_column: string; tgt_data_type: string;
  tgt_is_pk: boolean; score: number; signals: Record<string, number>;
}

/** 두 오브젝트 사이 컬럼 페어 후보 — /verify 페어 선택 단계에서 쓴다. */
export function fetchPairCandidates(
  srcObjectId: number, tgtObjectId: number,
): Promise<{ items: PairCandidate[] }> {
  return getJson(`/api/validate/pair-candidates?src_object_id=${srcObjectId}&tgt_object_id=${tgtObjectId}`);
}

export function runContainment(
  srcColumnId: number, tgtColumnId: number,
): Promise<ContainmentResponse> {
  return postJson("/api/validate/containment", {
    src_column_id: srcColumnId, tgt_column_id: tgtColumnId, triggered_by: "ui",
  });
}

export interface GateSide {
  qname: string; column: string; data_type: string; family: string;
  sample_rows: number | null; sample_distinct: number | null;
  ratio: number | null; cached: boolean;
}

export interface GateResult {
  verdict: "pass" | "blocked";
  reason: "type_mismatch" | "both_low_distinct" | null;
  threshold: number; src: GateSide; tgt: GateSide;
}

/** containment 실행 전 사전 게이트 — 타입 패밀리 + 표본 유니크니스로 값 조회 없이 차단. */
export function runGate(srcColumnId: number, tgtColumnId: number): Promise<GateResult> {
  return postJson("/api/validate/gate",
    { src_column_id: srcColumnId, tgt_column_id: tgtColumnId });
}

export interface JoinSamplePreview {
  src: string; tgt: string; rows: Record<string, unknown>[];
  limit: number; masked_columns: string[]; observed_at: string;
}

/** 확정 직전 1:1 페어 샘플 미리보기 — /verify 흐름 전용(N-웨이 아님). */
export function runValidatePreview(
  srcColumnId: number, tgtColumnId: number,
): Promise<JoinSamplePreview> {
  return postJson("/api/validate/preview",
    { src_column_id: srcColumnId, tgt_column_id: tgtColumnId, requested_by: "ui" });
}

export function confirmRelation(
  srcColumnId: number, tgtColumnId: number,
): Promise<{ status: string }> {
  return postJson("/api/relations/confirm", {
    src_column_id: srcColumnId, tgt_column_id: tgtColumnId, confirmed_by: "ui",
  });
}

export interface PendingRelation {
  id: number; status: "candidate" | "validated"; origin: string;
  confidence: number | null; reason: string | null;
  src_object: string; src_column: string; tgt_object: string; tgt_column: string;
  src_object_id: number | null; src_column_id: number | null;
  tgt_object_id: number | null; tgt_column_id: number | null;
}

/** 아직 확정 안 된 관계 큐 — /verify 진입점(무엇부터 검증할지) 목록. */
export function fetchPendingRelations(): Promise<{ items: PendingRelation[]; total: number }> {
  return getJson("/api/relations/pending");
}

/** mock=true면 LLM 미연결 휴리스틱 결과 — 실 판단으로 오독되지 않게 화면에 표시한다.
 * mock marks heuristic output produced without a live LLM. */
export function searchTablesAi(q: string): Promise<{ items: AiTableHit[]; mock: boolean }> {
  return getJson(`/api/ai/search-tables?q=${encodeURIComponent(q)}`);
}

export interface SnapshotSummary {
  id: number;
  collected_at: string;
  source_db: string;
  status: string;
  object_count: number;
}

export function fetchSnapshots(): Promise<{ items: SnapshotSummary[] }> {
  return getJson("/api/snapshots");
}

export interface ParseStats {
  snapshot_id: number;
  total_views: number;
  counts: Record<string, number>;
  success_rate: number | null;
  failed_views: { id: number; name: string; status: string; error: string | null }[];
}

export function fetchParseStats(snapshotId: number): Promise<ParseStats> {
  return getJson(`/api/snapshots/${snapshotId}/parse-stats`);
}

export interface JoinKeyItem {
  key: string;
  table_count: number;
  usage: number;
  table_ids: number[];
}

export function fetchJoinKeys(): Promise<{ items: JoinKeyItem[] }> {
  return getJson("/api/join-keys");
}

// 서버 페이지 상한과 동일 — 왕복 수를 최소화한다 / matches the server-side page cap
const OBJECTS_PAGE_SIZE = 1000;

/** 테이블+뷰 전체 — total까지 페이징해 전량 수집 / every object, paged until complete.
 *
 * 한 번에 다 못 받는다: 실규모 3,224개 > 서버 페이지 상한 1,000. 예전엔 limit=1000
 * 한 방이라 2,224개가 조용히 잘렸고, 목록에 없는 테이블이 링크로만 열렸다.
 * 목록·카테고리 집계·초성/컬럼 검색이 모두 이 전량 집합을 쓰므로 여기서 다 모은다
 * (렌더는 TableList가 무한 스크롤로 잘라서 그린다). */
export async function fetchAllObjects(): Promise<SearchResponse> {
  const first = await getJson<SearchResponse>(`/api/objects?limit=${OBJECTS_PAGE_SIZE}`);
  const items = [...first.items];
  while (items.length < first.total) {
    const page = await getJson<SearchResponse>(
      `/api/objects?limit=${OBJECTS_PAGE_SIZE}&offset=${items.length}`,
    );
    if (page.items.length === 0) break; // 서버가 빈 페이지를 주면 중단 — 무한 루프 방지
    items.push(...page.items);
  }
  return { ...first, items };
}

export interface SchemaCategoryItem {
  schema: string;
  /** 미지정이면 스키마명 자체 / falls back to the schema name */
  category: string;
  /** 사용자가 지정한 값인지 — 기본값과 구분 표시 / user-set vs default */
  mapped: boolean;
  object_count: number;
}

export function fetchSchemaCategories(): Promise<{ items: SchemaCategoryItem[] }> {
  return getJson("/api/schema-categories");
}

/** 스키마 하나의 카테고리 지정 — 빈 문자열이면 해제. 그 DB의 테이블이 통째로 이동한다.
 * Assigning moves every table of that schema at once; "" clears the mapping. */
export function assignSchemaCategory(
  schema: string, category: string,
): Promise<SchemaCategoryItem> {
  return putJson(`/api/schema-categories/${encodeURIComponent(schema)}`, { category });
}

export interface ObjectDetail {
  id: number;
  name: string;
  type: "table" | "view";
  row_count: number | null;
  column_count: number;
  ai_summary: string | null;
  /** HIDDEN_SCHEMAS 스키마 — columns가 항상 빈 배열로 내려온다 / columns are withheld */
  hidden: boolean;
  columns: { id: number; name: string; data_type: string; is_pk: boolean; is_join_key: boolean }[];
  using_views: { id: number; name: string; min_depth: number }[];
  base_tables: { id: number; name: string; min_depth: number }[];
  similar_tables: { id: number; name: string; match_rate: number; common_columns: number }[];
  fk_out: string[];
  fk_in: string[];
  relations: {
    other: string; src_column: string; tgt_column: string;
    status: string; confidence: number | null; cardinality: string | null;
    reason?: string | null;
  }[];
}

export function fetchObjectDetail(objectId: number): Promise<ObjectDetail> {
  return getJson(`/api/objects/${objectId}/detail`);
}

export interface JoinCheckItem {
  target_object: string;
  src_column: string;
  tgt_column: string;
  /** 조인 빌더 딥링크용 — 이름만으로는 컬럼을 특정할 수 없다 */
  src_column_id: number;
  tgt_column_id: number;
  score: number;
  signals: Record<string, number>;
  status: "checked" | "no_data";
  containment?: number;
  orphan_count?: number;
  cardinality?: string;
  confidence?: number;
  pattern?: string;
}

export interface JoinCheckResult {
  object: string;
  target: string | null;
  checked: JoinCheckItem[];
  no_data: JoinCheckItem[];
  observed_at: string;
}

/** 테이블 단위 조인 가능성 검증 — 타깃 미지정 시 상위 후보 일괄 / table-level join check. */
export function runJoinCheck(
  objectId: number, targetObjectId?: number,
): Promise<JoinCheckResult> {
  return postJson(`/api/objects/${objectId}/join-check`,
    targetObjectId === undefined ? {} : { target_object_id: targetObjectId });
}

export interface CollectJob {
  job_id: number;
  mode: "step" | "full";
  stage: "catalog_running" | "catalog_done" | "deps_running" | "ready" | "failed";
  snapshot_id: number | null;
  counts: Record<string, number>;
  triggered_by: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function triggerCollectCatalog(): Promise<CollectJob> {
  return postJson("/api/collect/catalog", {});
}

export function triggerCollectViewDeps(jobId: number): Promise<CollectJob> {
  return postJson("/api/collect/view-deps", { job_id: jobId });
}

export function triggerCollectFull(): Promise<CollectJob> {
  return postJson("/api/collect/full", {});
}

export function cancelCollectJob(jobId: number): Promise<CollectJob> {
  return postJson(`/api/collect/jobs/${jobId}/cancel`, {});
}

export function fetchCollectJobs(): Promise<{ items: CollectJob[] }> {
  return getJson("/api/collect/jobs");
}

export interface ScanJobStatus {
  job_id: number;
  status: "queued" | "running" | "done" | "failed";
  progress: { done: number; total: number };
  error: string | null;
  results: {
    rank: number; tgt_object: string; tgt_column: string;
    containment_sample: number; containment_full: number | null;
    cardinality: string | null;
  }[];
}

/** T3 전수 탐색 시작 — 202 + 폴링 규약 / start an exploratory scan. */
export function startScan(columnId: number): Promise<{ job_id: number; status: string }> {
  return postJson("/api/scan", { column_id: columnId });
}

export function fetchScanJob(jobId: number): Promise<ScanJobStatus> {
  return getJson(`/api/jobs/${jobId}`);
}

/** AI 요약 생성·갱신 (캐시 무시) / regenerate the cached AI summary. */
export function generateAiSummary(
  objectId: number,
): Promise<{ summary: string; mock: boolean }> {
  return postJson(`/api/ai/summarize/${objectId}?force=true`, {});
}

export function explainViewAi(
  objectId: number,
): Promise<{ explanation: string; mock: boolean }> {
  return postJson(`/api/ai/explain-view/${objectId}`, {});
}

/** 값 재검색 매칭 방식 — contains = LIKE 부분일치, exact = 정확 일치 */
export type PreviewFilterMode = "contains" | "exact";

export interface TablePreview {
  object: string;
  columns: string[];
  rows: Record<string, unknown>[];
  masked_columns: string[];
  /** 행이 어디서 왔는지 — 0행일 때 "원본이 비었다"와 "실행기 미연결"을 가른다 */
  source: "live" | "fixture";
  limit: number;
  filter: { column: string; value: string | null; mode: PreviewFilterMode } | null;
}

/** 미리보기가 허용된 스키마 목록 — 버튼 활성 판단용 (일반 사용자도 읽는다). */
export function fetchPreviewAllowlist(): Promise<{ items: string[] }> {
  return getJson("/api/objects/preview-allowlist");
}

/** 컬럼을 감춘 스키마(HIDDEN_SCHEMAS, 소문자) + 좌측 목록 렌더 토글. */
export function fetchHiddenSchemas(): Promise<{ items: string[]; render: boolean }> {
  return getJson("/api/objects/hidden-schemas");
}

export interface AuditEntry {
  id: number;
  action: string;
  detail: string;
  requested_by: string;
  requested_at: string;
}

export interface AuditPage {
  total: number;
  /** 실제로 쌓인 action 목록 — 필터 드롭다운을 채운다 */
  actions: string[];
  items: AuditEntry[];
}

export function fetchAuditLog(
  opts: { action?: string; limit?: number; offset?: number } = {},
): Promise<AuditPage> {
  const params = new URLSearchParams();
  if (opts.action) params.set("action", opts.action);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  const query = params.toString();
  return getJson(`/api/admin/audit${query ? `?${query}` : ""}`);
}

export function fetchHiddenSchemaRender(): Promise<{ render: boolean; schemas: string[] }> {
  return getJson("/api/admin/hidden-schema-render");
}

/** 렌더 토글 변경 — 미리보기 허용 목록과 같은 비밀번호 게이트. */
export function setHiddenSchemaRender(
  render: boolean, password: string,
): Promise<{ render: boolean }> {
  return putJson("/api/admin/hidden-schema-render", { render }, {
    "X-Preview-Password": password,
  });
}

export interface PreviewAllowEntry {
  schema: string;
  note: string | null;
  added_by: string;
  created_at: string;
}

export interface PreviewAllowlistAdmin {
  /** PREVIEW_ADMIN_PASSWORD 설정 여부 — 미설정이면 수정 자체가 불가하다 */
  password_configured: boolean;
  items: PreviewAllowEntry[];
}

export function fetchPreviewAllowlistAdmin(): Promise<PreviewAllowlistAdmin> {
  return getJson("/api/admin/preview-allowlist");
}

// 비밀번호는 헤더로만 실어 보낸다 — URL·본문에 남기지 않는다 (로그·히스토리 노출 방지)
export function addPreviewAllow(
  schema: string, password: string, note?: string,
): Promise<{ created: boolean }> {
  return postJson("/api/admin/preview-allowlist", { schema, note },
                  { "X-Preview-Password": password });
}

export function removePreviewAllow(
  schema: string, password: string,
): Promise<{ removed: boolean }> {
  return deleteJson(`/api/admin/preview-allowlist/${encodeURIComponent(schema)}`,
                    { "X-Preview-Password": password });
}

export function fetchObjectPreview(
  objectId: number,
  filter?: { column: string; value: string; mode?: PreviewFilterMode },
  limit?: number,
): Promise<TablePreview> {
  const params = new URLSearchParams();
  if (filter?.column && filter.value) {
    params.set("filter_column", filter.column);
    params.set("filter_value", filter.value);
    if (filter.mode) params.set("filter_mode", filter.mode);
  }
  if (limit !== undefined) params.set("limit", String(limit));
  const suffix = params.size > 0 ? `?${params}` : "";
  return getJson(`/api/objects/${objectId}/preview${suffix}`);
}

export function fetchColumnsIndex(): Promise<{
  items: { object_id: number; columns: string[] }[];
}> {
  return getJson("/api/objects/columns-index");
}

export interface AiJobStatus {
  job_id: number;
  kind: string;
  status: "queued" | "running" | "done" | "failed";
  progress_done: number;
  progress_total: number;
  // suggest: {suggested, created, rejected} / embed_index: {indexed, skipped, remaining}
  result: { suggested: number; created: number; rejected: number }
    | { indexed: number; skipped: number; remaining: number }
    | null;
  error: string | null;
}

/** AI 관계 제안 잡 시작 — 202 + 폴링 규약 (T3 스캔과 동일) / start the async suggest job. */
export function startAiSuggest(): Promise<{ job_id: number; status: string }> {
  return postJson("/api/ai/suggest-relations", {});
}

export function fetchAiJob(jobId: number): Promise<AiJobStatus> {
  return getJson(`/api/ai/jobs/${jobId}`);
}

/** 임베딩 인덱싱 잡 시작 — 202 + ai_jobs 폴링 (사이클2 Task 8). / start the capped embed-index job. */
export function startEmbedIndex(): Promise<{ job_id: number; status: string }> {
  return postJson("/api/ai/embed-index", {});
}

export interface ChatTurn { role: "user" | "assistant"; content: string }
export interface ChatResponse { answer: string; tables: string[]; mock: boolean }

/** 스키마 Q&A — 히스토리는 서버가 6턴으로 캡 (사이클2 Task 10). / schema chat; history capped server-side at 6 turns. */
export function chatAi(question: string, history: ChatTurn[]): Promise<ChatResponse> {
  return postJson("/api/ai/chat", { question, history });
}
