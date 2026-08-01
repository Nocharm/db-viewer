import { describe, expect, it } from "vitest";

import { resolveEdgeHandles, type NodeAnchorInfo } from "./edge-anchors";
import type { GraphEdge } from "./types";

function makeEdge(kind: GraphEdge["kind"], columns: unknown[]): GraphEdge {
  return { id: "e1", kind, src_object_id: 1, tgt_object_id: 2, columns } as GraphEdge;
}

const PAIR = [{ src_column: "SO_NO", tgt_column: "SO_NO2" }];
const openWith = (...cols: string[]): NodeAnchorInfo => ({
  expanded: true, visibleColumns: new Set(cols),
});
const folded: NodeAnchorInfo = { expanded: false, visibleColumns: new Set(["SO_NO"]) };

describe("resolveEdgeHandles", () => {
  it("anchors both ends to column rows when expanded and visible", () => {
    expect(resolveEdgeHandles(makeEdge("fk", PAIR), openWith("SO_NO"), openWith("SO_NO2")))
      .toEqual({ sourceHandle: "s-SO_NO", targetHandle: "t-SO_NO2" });
  });

  it("falls back per side — folded node or cut-off column keeps the header handle", () => {
    // 접힌 소스 / folded source
    expect(resolveEdgeHandles(makeEdge("fk", PAIR), folded, openWith("SO_NO2")))
      .toEqual({ targetHandle: "t-SO_NO2" });
    // 표시 상한에 잘린 타깃 컬럼 / target column beyond the render cap
    expect(resolveEdgeHandles(makeEdge("fk", PAIR), openWith("SO_NO"), openWith("OTHER")))
      .toEqual({ sourceHandle: "s-SO_NO" });
  });

  it("returns no handles for lineage edges and empty pairs", () => {
    expect(resolveEdgeHandles(makeEdge("view_lineage", PAIR), openWith("SO_NO"), openWith("SO_NO2")))
      .toEqual({});
    expect(resolveEdgeHandles(makeEdge("fk", []), openWith("SO_NO"), openWith("SO_NO2")))
      .toEqual({});
  });
});
