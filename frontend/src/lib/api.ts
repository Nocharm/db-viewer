/** 백엔드 조회 API 클라이언트 / thin fetch wrappers for the query API. */

import type {
  AiTableHit,
  CandidatesResponse,
  ContainmentResponse,
  GraphResponse,
  HistoryItem,
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

export function searchTablesAi(q: string): Promise<{ items: AiTableHit[] }> {
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

export function suggestRelationsAi(): Promise<{ suggested: number; created: number }> {
  return postJson("/api/ai/suggest-relations", {});
}
