"use client";

/** 엣지 시각 언어 범례 / edge visual-language legend. */

import { useI18n } from "@/components/i18n";
import { getEdgeVisual, type EdgeKind } from "@/lib/edge-style";
import type { MessageKey } from "@/lib/i18n";

const ITEMS: { kind: EdgeKind; labelKey: MessageKey }[] = [
  { kind: "fk", labelKey: "erd.legendFk" },
  { kind: "inferred", labelKey: "erd.legendInferred" },
  { kind: "ai_suggested", labelKey: "erd.legendAi" },
  { kind: "view_lineage", labelKey: "erd.legendLineage" },
  { kind: "unresolved", labelKey: "erd.legendUnresolved" },
];

export function Legend() {
  const { t } = useI18n();
  return (
    <div
      className="absolute bottom-3 left-3 z-10 rounded-lg border px-3 py-2"
      style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
      data-testid="ErdCanvas-legend"
    >
      {ITEMS.map(({ kind, labelKey }) => {
        const v = getEdgeVisual(kind);
        return (
          <div key={kind} className="flex items-center gap-2 py-0.5 text-xs">
            <svg width="32" height="6">
              <line
                x1="0" y1="3" x2="32" y2="3"
                stroke={v.stroke}
                strokeWidth={v.strokeWidth}
                strokeDasharray={v.strokeDasharray}
                opacity={v.opacity}
              />
            </svg>
            <span>{t(labelKey)}</span>
          </div>
        );
      })}
    </div>
  );
}
