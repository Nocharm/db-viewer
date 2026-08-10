/** DB(스키마) → 업무 카테고리 / schema to business category.
 *
 * 실 스키마는 `ATM.PI_~`처럼 DB 단위라 분류 축도 테이블명이 아니라 스키마다.
 * 매핑은 서버(schema_categories)가 갖고, 지정이 없으면 스키마명 자체가 카테고리다
 * — 설정 전에도 목록이 채워진다.
 */

export type SchemaCategoryMap = Map<string, string>;

/** 서버 매핑에서 카테고리 결정 — 없으면 스키마명 / falls back to the schema name. */
export function resolveCategory(schema: string, mapping: SchemaCategoryMap): string {
  return mapping.get(schema) ?? schema;
}

/** 카테고리의 미리보기 잠금 집계 — 허용/미허용 스키마 포함 여부.
 * 여러 DB가 혼재한 카테고리는 둘 다 true가 되어 풀림·잠김 자물쇠를 같이 띄운다.
 * / per-category preview-lock aggregate; a mixed category raises both flags
 *   so the row shows an open and a closed lock side by side. */
export interface CategoryLockState {
  hasAllowed: boolean;
  hasLocked: boolean;
}

export function getCategoryLockStates(
  schemas: { schema: string; category: string }[],
  previewAllowed: Set<string>,
): Map<string, CategoryLockState> {
  const states = new Map<string, CategoryLockState>();
  for (const { schema, category } of schemas) {
    const state = states.get(category) ?? { hasAllowed: false, hasLocked: false };
    if (previewAllowed.has(schema)) state.hasAllowed = true;
    else state.hasLocked = true;
    states.set(category, state);
  }
  return states;
}
