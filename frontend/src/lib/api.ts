/** 백엔드 조회 API 클라이언트 / thin fetch wrappers for the query API. */

import type {
  AiTableHit,
  CandidatesResponse,
  ContainmentResponse,
  GraphResponse,
  HistoryItem,
  JoinPreviewResponse,
  PreviewResponse,
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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return handle(await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  }));
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  return handle(await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  }));
}

async function deleteJson<T>(url: string): Promise<T> {
  return handle(await fetch(url, { method: "DELETE", headers: authHeaders() }));
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

export function fetchGraph(objectId: number, depth = 1): Promise<GraphResponse> {
  return getJson(`/api/objects/${objectId}/graph?depth=${depth}`);
}

export function fetchCandidates(columnId: number): Promise<CandidatesResponse> {
  return getJson(`/api/columns/${columnId}/candidates`);
}

export function runContainment(
  srcColumnId: number, tgtColumnId: number,
): Promise<ContainmentResponse> {
  return postJson("/api/validate/containment", {
    src_column_id: srcColumnId, tgt_column_id: tgtColumnId, triggered_by: "ui",
  });
}

export function runPreview(
  srcColumnId: number, tgtColumnId: number,
): Promise<PreviewResponse> {
  return postJson("/api/validate/preview", {
    src_column_id: srcColumnId, tgt_column_id: tgtColumnId, requested_by: "ui",
  });
}

/** N-웨이 조인 미리보기 — 행과 실행 SQL을 함께 받는다 / rows plus the executed SQL. */
export async function runJoinPreview(
  steps: { left_column_id: number; right_column_id: number; join_type: string }[],
): Promise<JoinPreviewResponse> {
  return postJson("/api/join/preview", { steps, requested_by: "ui" });
}

export function confirmRelation(
  srcColumnId: number, tgtColumnId: number,
): Promise<{ status: string }> {
  return postJson("/api/relations/confirm", {
    src_column_id: srcColumnId, tgt_column_id: tgtColumnId, confirmed_by: "ui",
  });
}

export function fetchHistory(
  srcColumnId: number, tgtColumnId: number,
): Promise<{ items: HistoryItem[] }> {
  return getJson(
    `/api/validate/history?src_column_id=${srcColumnId}&tgt_column_id=${tgtColumnId}`,
  );
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

export function explainValidationAi(
  srcColumnId: number, tgtColumnId: number,
): Promise<{ explanation: string; mock: boolean }> {
  return postJson(
    `/api/ai/explain-validation?src_column_id=${srcColumnId}&tgt_column_id=${tgtColumnId}`, {});
}

export interface TablePreview {
  object: string;
  columns: string[];
  rows: Record<string, unknown>[];
  masked_columns: string[];
  limit: number;
  filter: { column: string; value: string | null } | null;
}

export function fetchObjectPreview(
  objectId: number,
  filter?: { column: string; value: string },
  limit?: number,
): Promise<TablePreview> {
  const params = new URLSearchParams();
  if (filter?.column && filter.value) {
    params.set("filter_column", filter.column);
    params.set("filter_value", filter.value);
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
