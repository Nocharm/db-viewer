/** 백엔드 조회 API 클라이언트 / thin fetch wrappers for the query API. */

import type { PreviewFilterCond } from "./preview-utils";
import { withSourceParam } from "./source-param";
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
    // 로컬 세션 토큰은 갱신이 없다 — 만료되면 401이 오고, 여기가 유일한 응답 깔때기다.
    // 로그인 화면 자신에서는 리다이렉트하지 않는다(무한 루프 방지).
    if (res.status === 401 && typeof window !== "undefined"
        && window.location.pathname !== "/login") {
      const { clearStoredSession, readStoredSession } = await import("./session-token");
      if (readStoredSession() !== null) {
        clearStoredSession();
        setAuthToken(null);
        window.location.href = "/login";
      }
    }
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

async function patchJson<T>(
  url: string, body: unknown, extraHeaders?: Record<string, string>,
): Promise<T> {
  return handle(await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
  }));
}

export interface LdapLoginResponse {
  access_token: string;
  token_type: string;
  expires_at: string;
  login_id: string;
  name: string | null;
}

export function loginWithLdap(
  loginId: string, password: string,
): Promise<LdapLoginResponse> {
  return postJson("/api/auth/ldap-login", { login_id: loginId, password });
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

export interface DataSourceItem {
  id: number;
  name: string;
  engine: string;
  access_mode: string;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  file_path: string | null;
  has_password: boolean;
  is_enabled: boolean;
  is_managed: boolean;
  last_ok_at: string | null;
  last_error: string | null;
}

/** 등록된 소스 목록 — sysadmin 전용, 일반 사용자는 403(호출부가 감내한다). */
export function fetchDataSources(): Promise<{
  items: DataSourceItem[];
  secret_key_configured: boolean;
}> {
  return getJson("/api/sources");
}

/** 마이그레이션이 시드한 사내 MSSQL 소스 id — 소스 미지정 요청의 백엔드 기본값과 같다.
 *  뷰 파싱·관계 검증·AI처럼 MSSQL 전용인 화면은 이 값을 명시해야 한다: 스냅샷 id는
 *  전 소스 공통 시퀀스라 "최신 스냅샷"이 다른 소스 것으로 넘어갈 수 있다.
 *  The seeded in-house MSSQL source; MSSQL-only screens must pin to it because snapshot
 *  ids are one global sequence. */
export const MANAGED_MSSQL_SOURCE_ID = 1;

/** 소스 선택기용 최소 목록 — 접속정보 없음, 일반 사용자도 읽는다(조회 API와 같은 게이트).
 *  관리 콘솔은 전체 레코드가 필요해 계속 `fetchDataSources`를 쓴다. */
export interface SourceOption {
  id: number;
  name: string;
  engine: string;
  is_enabled: boolean;
}

export function fetchSourceOptions(): Promise<{ items: SourceOption[] }> {
  return getJson("/api/sources/options");
}

export interface DataSourceInput {
  name: string;
  engine: "postgres" | "sqlite";
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  // 쓰기 전용 — 응답에는 절대 실리지 않는다 / write-only, never echoed back
  password?: string;
  file_path?: string;
}

/** 소스 등록 — SOURCE_SECRET_KEY 미설정이면 503, 필수 필드 누락이면 400. */
export function createDataSource(
  input: DataSourceInput, password: string,
): Promise<DataSourceItem> {
  return postJson("/api/sources", input, { "X-Preview-Password": password });
}

/** 소스 부분 수정 — is_enabled 전환도 여기서. is_managed 소스는 백엔드가 409로 거부. */
export function updateDataSource(
  id: number, input: Partial<DataSourceInput> & { is_enabled?: boolean },
  password: string,
): Promise<DataSourceItem> {
  return patchJson(`/api/sources/${id}`, input, { "X-Preview-Password": password });
}

export interface DeleteBlockedContext {
  snapshots?: number;
  preview_allowlist?: number;
  schema_categories?: number;
}

/** 삭제 차단(409) 안내 문구를 조립한다 — 백엔드는 context에 개수를 실어 보내는데 공용
 * handle()은 message만 남기고 context를 버린다. 그 개수가 없으면 "무엇이 얼마나 막고
 * 있는지"를 안내할 수 없어, deleteDataSource만 이 함수로 직접 조립한다. */
export function formatDeleteBlockedMessage(
  context: DeleteBlockedContext | null | undefined,
  fallback: string,
): string {
  if (!context) return fallback;
  const counts = [
    context.snapshots ? `스냅샷 ${context.snapshots}건` : null,
    context.preview_allowlist ? `허용 목록 ${context.preview_allowlist}건` : null,
    context.schema_categories ? `카테고리 ${context.schema_categories}건` : null,
  ].filter((part): part is string => part !== null);
  if (counts.length === 0) return fallback;
  return `${counts.join("·")}이 이 소스를 참조하고 있어 삭제할 수 없습니다 — `
    + "비활성화하거나 먼저 정리하세요.";
}

/** is_managed거나 스냅샷·정책 행이 남아있으면 409 — 공용 handle()을 거치지 않고 직접
 * 응답을 읽어 context의 개수를 메시지에 싣는다(공유 헬퍼는 그대로 둔다). */
export async function deleteDataSource(
  id: number, password: string,
): Promise<{ id: number; removed: boolean }> {
  const res = await fetch(`/api/sources/${id}`, {
    method: "DELETE",
    headers: { ...authHeaders(), "X-Preview-Password": password },
  });
  if (res.ok) return res.json();
  const body = await res.json().catch(() => null);
  const fallback = body?.error?.message ?? `request failed (${res.status})`;
  throw new Error(formatDeleteBlockedMessage(body?.error?.context, fallback));
}

/** 연결 테스트 — sysadmin이면 비밀번호 없이 호출. 비활성 소스도 테스트 가능(의도적).
 * 흔한 컨테이너명 오접속을 잡기 위해 실제로 붙은 DB의 이름·버전을 회신한다. */
export function testDataSource(id: number): Promise<{
  ok: boolean; version: string; database: string; latency_ms: number;
}> {
  return postJson(`/api/sources/${id}/test`, {});
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

export function searchObjects(
  q: string, type?: "table" | "view", sourceId: number | null = null,
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q });
  if (type) params.set("type", type);
  return getJson(withSourceParam(`/api/objects?${params}`, sourceId));
}

/** confirmed+FK만 담은 읽기 전용 전체 그래프 — /erd 전용(앵커·검색 없음). */
export function fetchErdGraph(sourceId: number | null = null): Promise<ErdResponse> {
  return getJson(withSourceParam("/api/erd", sourceId));
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

/** 소스를 생략하면 전 소스의 이력을 준다(관리 콘솔용) — 특정 소스의 "최신 스냅샷"이
 *  필요한 화면은 반드시 소스를 넘겨야 한다. / omitting the source lists every source's
 *  history; callers that need one source's latest snapshot must pass it. */
export function fetchSnapshots(
  sourceId: number | null = null,
): Promise<{ items: SnapshotSummary[] }> {
  return getJson(withSourceParam("/api/snapshots", sourceId));
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

export function fetchJoinKeys(sourceId: number | null = null): Promise<{ items: JoinKeyItem[] }> {
  return getJson(withSourceParam("/api/join-keys", sourceId));
}

// 서버 페이지 상한과 동일 — 왕복 수를 최소화한다 / matches the server-side page cap
const OBJECTS_PAGE_SIZE = 1000;

/** 테이블+뷰 전체 — total까지 페이징해 전량 수집 / every object, paged until complete.
 *
 * 한 번에 다 못 받는다: 실규모 3,224개 > 서버 페이지 상한 1,000. 예전엔 limit=1000
 * 한 방이라 2,224개가 조용히 잘렸고, 목록에 없는 테이블이 링크로만 열렸다.
 * 목록·카테고리 집계·초성/컬럼 검색이 모두 이 전량 집합을 쓰므로 여기서 다 모은다
 * (렌더는 TableList가 무한 스크롤로 잘라서 그린다). */
export async function fetchAllObjects(sourceId: number | null = null): Promise<SearchResponse> {
  const first = await getJson<SearchResponse>(
    withSourceParam(`/api/objects?limit=${OBJECTS_PAGE_SIZE}`, sourceId),
  );
  const items = [...first.items];
  while (items.length < first.total) {
    const page = await getJson<SearchResponse>(
      withSourceParam(`/api/objects?limit=${OBJECTS_PAGE_SIZE}&offset=${items.length}`, sourceId),
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

export function fetchSchemaCategories(
  sourceId: number | null = null,
): Promise<{ items: SchemaCategoryItem[] }> {
  return getJson(withSourceParam("/api/schema-categories", sourceId));
}

/** 스키마 하나의 카테고리 지정 — 빈 문자열이면 해제. 그 DB의 테이블이 통째로 이동한다.
 * Assigning moves every table of that schema at once; "" clears the mapping. */
export function assignSchemaCategory(
  schema: string, category: string, sourceId: number | null = null,
): Promise<SchemaCategoryItem> {
  return putJson(
    withSourceParam(`/api/schema-categories/${encodeURIComponent(schema)}`, sourceId),
    { category },
  );
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

/** source_id 생략 시 기본 소스(사내 MSSQL) — DataSourcePanel이 신규 등록 소스를 지정해 쓴다.
 * direct 소스(postgres/sqlite)는 뷰 의존 단계가 없어 이 한 번의 호출로 수집이 끝난다. */
export function triggerCollectCatalog(sourceId: number | null = null): Promise<CollectJob> {
  return postJson("/api/collect/catalog", sourceId !== null ? { source_id: sourceId } : {});
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

export interface TablePreview {
  object: string;
  columns: string[];
  rows: Record<string, unknown>[];
  masked_columns: string[];
  /** 행이 어디서 왔는지 — 0행일 때 "원본이 비었다"와 "실행기 미연결"을 가른다 */
  source: "live" | "fixture";
  limit: number;
  /** 적용된 조건 목록(AND) — 서버가 검증해 되돌려준 값 / server-echoed conditions */
  filters: PreviewFilterCond[];
}

/** 미리보기가 허용된 스키마 목록 — 버튼 활성 판단용 (일반 사용자도 읽는다). 허용은 소스별. */
export function fetchPreviewAllowlist(
  sourceId: number | null = null,
): Promise<{ items: string[] }> {
  return getJson(withSourceParam("/api/objects/preview-allowlist", sourceId));
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

/** 허용 목록 PK가 (data_source_id, schema)라 조회도 소스별 — 미지정 시 사내 MSSQL. */
export function fetchPreviewAllowlistAdmin(
  sourceId: number | null = null,
): Promise<PreviewAllowlistAdmin> {
  return getJson(withSourceParam("/api/admin/preview-allowlist", sourceId));
}

// 비밀번호는 헤더로만 실어 보낸다 — URL·본문에 남기지 않는다 (로그·히스토리 노출 방지)
export function addPreviewAllow(
  schema: string, password: string, note?: string, sourceId: number | null = null,
): Promise<{ created: boolean }> {
  return postJson(
    "/api/admin/preview-allowlist",
    { schema, note, ...(sourceId !== null ? { source_id: sourceId } : {}) },
    { "X-Preview-Password": password },
  );
}

export function removePreviewAllow(
  schema: string, password: string, sourceId: number | null = null,
): Promise<{ removed: boolean }> {
  return deleteJson(
    withSourceParam(`/api/admin/preview-allowlist/${encodeURIComponent(schema)}`, sourceId),
    { "X-Preview-Password": password },
  );
}

export function fetchObjectPreview(
  objectId: number,
  filters?: PreviewFilterCond[],
  limit?: number,
): Promise<TablePreview> {
  const params = new URLSearchParams();
  if (filters && filters.length > 0) {
    params.set("filters", JSON.stringify(filters));
  }
  if (limit !== undefined) params.set("limit", String(limit));
  const suffix = params.size > 0 ? `?${params}` : "";
  return getJson(`/api/objects/${objectId}/preview${suffix}`);
}

export function fetchColumnsIndex(sourceId: number | null = null): Promise<{
  items: { object_id: number; columns: string[] }[];
}> {
  return getJson(withSourceParam("/api/objects/columns-index", sourceId));
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
