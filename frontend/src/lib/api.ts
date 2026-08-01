/** 백엔드 조회 API 클라이언트 / thin fetch wrappers for the query API. */

import type {
  CandidatesResponse,
  ContainmentResponse,
  GraphResponse,
  HistoryItem,
  PreviewResponse,
  SearchResponse,
} from "./types";

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
  return handle(await fetch(url));
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return handle(await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
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
