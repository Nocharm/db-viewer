/** API 응답 타입 — 백엔드 조회 API와 1:1 / mirrors the backend query API. */

export interface ObjectSummary {
  id: number;
  schema: string;
  name: string;
  type: "table" | "view";
  row_count: number | null;
  column_count: number;
  dmv_unresolved: boolean;
}

export interface SearchResponse {
  snapshot_id: number;
  /** 필터 적용 후 전체 수 — items는 limit만큼만 담긴다 / full count; items holds one page */
  total: number;
  items: ObjectSummary[];
}

export interface GraphColumn {
  id: number;
  name: string;
  data_type: string;
  is_pk: boolean;
  is_nullable: boolean;
  is_computed: boolean;
}

export interface GraphNode {
  id: number;
  schema: string;
  name: string;
  type: "table" | "view";
  row_count: number | null;
  dmv_unresolved: boolean;
  lineage_flag: "cycle" | "depth_exceeded" | null;
  unresolved_dep_count: number;
  ai_summary?: string | null;
  columns: GraphColumn[];
}

export interface AiTableHit {
  object_id: number | null;
  object: string;
  score: number;
  reason: string;
}

export interface GraphEdge {
  id: string;
  kind: "fk" | "view_lineage" | "inferred" | "confirmed" | "ai_suggested";
  name?: string;
  src_object_id: number;
  tgt_object_id: number;
  columns: { src_column: string; tgt_column: string }[] | string[];
  min_depth?: number;
  confidence?: number | null;
  cardinality?: string | null;
  last_verified_at?: string | null;
  reason?: string | null;
}

export interface CandidateItem {
  column_id: number;
  object: string;
  column: string;
  score: number;
  signals: Record<string, number>;
  is_pk: boolean;
}

export interface CandidatesResponse {
  column_id: number;
  column?: string;
  excluded: { reason: string } | null;
  candidates: CandidateItem[];
}

export interface ContainmentResponse {
  src: string;
  tgt: string;
  containment: number;
  matched: number;
  src_distinct: number;
  orphan_count: number;
  cardinality: string;
  confidence: number | null;
  pattern: string;
  observations: number;
  observed_at: string;
}

export interface JoinPreviewResponse {
  rows: Record<string, unknown>[];
  /** W2가 실제로 실행한 SQL — 화면 표시용으로 조립하지 않는다 */
  query: string;
  limit: number;
  /** "{schema}.{table}.{column}" — 스키마까지 포함해 동명 테이블 별칭 충돌을 피한다 */
  masked_columns: string[];
  observed_at: string;
}

export interface GraphResponse {
  snapshot_id: number;
  anchor_id: number;
  depth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ErdResponse {
  snapshot_id: number | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
