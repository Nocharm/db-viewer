"use client";

/** 엣지 시각 언어 범례 — 3등급 + 계보, 접을 수 있다 / collapsible three-grade legend. */

import { useState } from "react";

import { CaretDownIcon, CaretRightIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import { getEdgeVisual, type EdgeKind } from "@/lib/edge-style";
import type { MessageKey } from "@/lib/i18n";

// 등급 대표 kind 하나씩 — 같은 등급은 시각이 동일하므로 하나만 그린다
const ITEMS: { kind: EdgeKind; labelKey: MessageKey }[] = [
  { kind: "fk", labelKey: "erd.legendConfirmed" },
  { kind: "inferred", labelKey: "erd.legendInferredGrade" },
  { kind: "unresolved", labelKey: "erd.legendUnresolvedGrade" },
  { kind: "view_lineage", labelKey: "erd.legendLineageGrade" },
];

export function Legend() {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);

  return (
    <div
      className="absolute bottom-3 right-3 z-10 rounded-lg border px-3 py-2"
      style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
      data-testid="ErdCanvas-legend"
    >
      <button
        className="flex items-center gap-1 text-xs"
        onClick={() => setOpen((current) => !current)}
        data-testid="ErdCanvas-legendToggle"
      >
        {open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
        {t("erd.legendToggle")}
      </button>
      {open && ITEMS.map(({ kind, labelKey }) => {
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
