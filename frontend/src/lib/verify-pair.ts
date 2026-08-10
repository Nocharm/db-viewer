/** 컬럼 페어 식별·수동 조립 — /verify 컴포넌트에서 뺀 순수 판정.
 * Pair identity and manual assembly, lifted out of the /verify components. */

import type { ObjectDetail, PairCandidate } from "./api";

/** 페어를 가리키는 최소 식별자 — 컬럼 둘이면 페어가 정해진다. */
export interface PairKey {
  src_column_id: number;
  tgt_column_id: number;
}

/** 드롭다운의 반쪽 선택 — 한 쪽만 고른 중간 상태를 담는다. */
export interface ManualSelection {
  srcColumnId: number | null;
  tgtColumnId: number | null;
}

type DetailColumn = ObjectDetail["columns"][number];

/**
 * 늦게 도착한 응답을 적용해도 되는지 / whether an in-flight result still applies.
 *
 * 페어 A를 검증하는 동안 사용자가 페어 B로 넘어가면, 뒤늦게 온 A의 결과가 B의 판정으로
 * 둔갑해 "게이트를 통과한 적 없는 페어에 확정 버튼이 열리는" 상태를 만든다. 요청 시점의
 * 키를 캡처해 두고 적용 직전에 이 함수로 대조한다.
 */
export function isSamePair(a: PairKey | null, b: PairKey | null): boolean {
  if (a === null || b === null) return false;
  return a.src_column_id === b.src_column_id && a.tgt_column_id === b.tgt_column_id;
}

/** 대기 큐를 선택된 테이블로 거른다 — 테이블은 어느 쪽 끝에 있어도 관련 항목이고
 * (큐 항목이 방향을 갖고 있어 클릭 시 그 방향대로 실리므로 안전), 여러 테이블을
 * 골랐으면 전부 걸려 있어야 한다. 빈 선택은 필터 없음(원본 참조 반환).
 * / filter the queue by picked tables: a table matches on either end, and every
 *   picked table must match. An empty pick returns the original reference. */
export function filterPendingRelations<T extends { src_object: string; tgt_object: string }>(
  items: T[], qnames: string[],
): T[] {
  if (qnames.length === 0) return items;
  return items.filter((item) =>
    qnames.every((qname) => item.src_object === qname || item.tgt_object === qname));
}

/** 선택된 페어를 드롭다운 초기값으로 / seeds the selects from the current pair. */
export function toManualSelection(pair: PairKey | null): ManualSelection {
  return {
    srcColumnId: pair?.src_column_id ?? null,
    tgtColumnId: pair?.tgt_column_id ?? null,
  };
}

/** 한 쪽만 갱신하고 반대쪽 선택은 보존한다 — 이 중간 상태가 없으면 페어를 완성할 수 없다. */
export function applyManualSelection(
  current: ManualSelection, side: "src" | "tgt", columnId: number | null,
): ManualSelection {
  return side === "src"
    ? { ...current, srcColumnId: columnId }
    : { ...current, tgtColumnId: columnId };
}

/** 양쪽이 실제 컬럼으로 다 채워졌을 때만 페어. 수동 선택은 점수·신호가 없어 0/{}이다. */
export function buildManualPair(
  selection: ManualSelection, srcColumns: DetailColumn[], tgtColumns: DetailColumn[],
): PairCandidate | null {
  const src = srcColumns.find((c) => c.id === selection.srcColumnId);
  const tgt = tgtColumns.find((c) => c.id === selection.tgtColumnId);
  if (!src || !tgt) return null;
  return {
    src_column_id: src.id, src_column: src.name, src_data_type: src.data_type,
    tgt_column_id: tgt.id, tgt_column: tgt.name, tgt_data_type: tgt.data_type,
    tgt_is_pk: tgt.is_pk, score: 0, signals: {},
  };
}
