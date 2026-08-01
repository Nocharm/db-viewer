/** 백엔드 조회 API 클라이언트 / thin fetch wrappers for the query API. */

import type { GraphResponse, SearchResponse } from "./types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    // 백엔드 에러 규약: {"error": {code, message, context}}
    const body = await res.json().catch(() => null);
    const message = body?.error?.message ?? `request failed (${res.status})`;
    throw new Error(message);
  }
  return res.json();
}

export function searchObjects(q: string, type?: "table" | "view"): Promise<SearchResponse> {
  const params = new URLSearchParams({ q });
  if (type) params.set("type", type);
  return getJson(`/api/objects?${params}`);
}

export function fetchGraph(objectId: number, depth = 1): Promise<GraphResponse> {
  return getJson(`/api/objects/${objectId}/graph?depth=${depth}`);
}
