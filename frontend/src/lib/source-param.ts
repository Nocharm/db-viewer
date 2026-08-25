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

/** 라우터 이동 경로(`router.push`/`Link href`)에 `?source=`를 붙인다 — withSourceParam의
 * API용(`source_id`)과 짝을 이루는 브라우저 URL용. 안 붙이면 테이블 클릭 한 번으로 URL의
 * 소스가 사라져 새로고침·공유가 조용히 기본 소스로 돌아간다.
 * / the router-navigation counterpart to withSourceParam's API `source_id`; omitting it lets
 * one table click drop the source from the URL, so a reload or shared link silently falls
 * back to the default source. */
export function withSourceQuery(path: string, sourceId: number | null): string {
  if (sourceId === null) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}source=${sourceId}`;
}
