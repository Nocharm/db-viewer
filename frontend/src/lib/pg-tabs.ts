/** 업무 Postgres 미리보기 탭의 id 규칙. / tab ids for the business-Postgres preview.
 *
 * 카탈로그 객체와 달리 이 소스에는 서버가 주는 숫자 id가 없다 — 화면이 (연결, 목록 순번)에서
 * 만든다. 소스를 오가며 두 DB의 테이블을 나란히 비교할 수 있어야 하므로, 서로 다른 연결의
 * 같은 순번이 절대 같은 id가 되면 안 된다(같으면 한쪽 탭이 다른 쪽 데이터로 덮인다).
 */

// 소스 하나가 차지하는 id 구간 — 목록 상한(테이블 수)보다 넉넉하게 / per-source id block
const BLOCK = 100_000;

export function getPgTabId(slug: string, index: number): number {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) % 100_000;
  return hash * BLOCK + index;
}
