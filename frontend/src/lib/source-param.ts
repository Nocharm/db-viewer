/** 소스 선택은 URL 쿼리에 실린다 — 링크 공유와 새로고침을 견디게.
 *  The selected source lives in the URL so links survive a reload. */

export function readSourceId(search: string): number | null {
  const raw = new URLSearchParams(search).get("source");
  if (raw === null) return null;
  // 숫자가 아니면 무시한다 — 검증되지 않은 값을 API로 흘려보내지 않는다
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function withSourceParam(path: string, sourceId: number | null): string {
  if (sourceId === null) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}source_id=${sourceId}`;
}
