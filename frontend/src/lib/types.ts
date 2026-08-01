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
  columns: GraphColumn[];
}

export interface GraphEdge {
  id: string;
  kind: "fk" | "view_lineage";
  name?: string;
  src_object_id: number;
  tgt_object_id: number;
  columns: { src_column: string; tgt_column: string }[] | string[];
  min_depth?: number;
}

export interface GraphResponse {
  snapshot_id: number;
  anchor_id: number;
  depth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
