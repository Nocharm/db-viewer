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
