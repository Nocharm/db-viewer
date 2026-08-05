/** 까그발 마커 defs — 캔버스에 한 번만 심고 엣지가 url(#id)로 참조한다.
 * Crow's-foot marker defs, mounted once and referenced by edges. */

import { MARKER_ID } from "@/lib/edge-style";

/** 마커 좌표계: refX=10이 선 끝, 표기는 선 끝에서 안쪽으로 그린다. */
export function CardinalityMarkerDefs() {
  return (
    <svg
      className="pointer-events-none absolute h-0 w-0"
      aria-hidden="true"
      data-testid="ErdCanvas-cardinalityMarkers"
    >
      <defs>
        {/* 단일 — 선에 수직인 막대 하나 / "one": a single perpendicular bar */}
        <marker
          id={MARKER_ID.one}
          viewBox="0 0 12 12"
          refX="10" refY="6"
          markerWidth="12" markerHeight="12"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 4 1 L 4 11" stroke="currentColor" strokeWidth="1.6" fill="none" />
        </marker>
        {/* 다중 — 세 갈래 까그발 / "many": the three-pronged crow's foot */}
        <marker
          id={MARKER_ID.many}
          viewBox="0 0 12 12"
          refX="10" refY="6"
          markerWidth="12" markerHeight="12"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path
            d="M 11 6 L 2 1 M 11 6 L 2 6 M 11 6 L 2 11"
            stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round"
          />
        </marker>
      </defs>
    </svg>
  );
}
