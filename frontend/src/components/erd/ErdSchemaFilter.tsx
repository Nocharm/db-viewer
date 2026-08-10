"use client";

/** ERD 좌측 스키마 필터 — 홈 좌측 레일과 같은 자리(좌측), 접을 수 있다.
 * 미허용 스키마엔 잠금 아이콘 + 툴팁 / collapsible left-rail schema filter;
 * schemas outside the preview allowlist carry a lock icon with a tooltip. */

import { useMemo, useState } from "react";

import { CaretDownIcon, CaretRightIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import { PreviewLockMarks } from "@/components/PreviewLockMarks";
import type { GraphNode } from "@/lib/types";

interface ErdSchemaFilterProps {
  /** 전체 그래프 노드 — 카운트·스키마 목록은 필터와 무관하게 원본 기준 */
  nodes: GraphNode[];
  selected: string | null;
  onSelect: (schema: string | null) => void;
  /** 미리보기 허용 스키마 — 잠금 아이콘 표시 판단 / preview allowlist for the lock marker */
  previewAllowed: Set<string>;
}

export function ErdSchemaFilter({
  nodes, selected, onSelect, previewAllowed,
}: ErdSchemaFilterProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);

  const items = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) counts.set(node.schema, (counts.get(node.schema) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [nodes]);

  // 그래프가 아직 없으면(로딩) 빈 패널 대신 아무것도 그리지 않는다
  if (items.length === 0) return null;

  return (
    <div
      className="w-72 rounded-lg border pb-1"
      style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
      data-testid="ErdSchemaFilter-root"
    >
      <button
        className="flex w-full items-center gap-1 px-3 py-2 text-xs"
        onClick={() => setOpen((current) => !current)}
        data-testid="ErdSchemaFilter-toggle"
      >
        {open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
        <span className="font-semibold uppercase tracking-widest"
              style={{ color: "var(--muted)" }}>
          {t("erd.schemaFilter")}
        </span>
        {/* 접힌 상태에서도 걸린 필터가 보여야 한다 — 목록이 왜 짧은지 화면이 설명하게 */}
        {!open && selected && (
          <span className="truncate font-mono" style={{ color: "var(--stat-ink)" }}
                data-testid="ErdSchemaFilter-collapsedBadge">
            {selected}
          </span>
        )}
      </button>
      {open && (
        <div className="scroll-area scroll-area--y max-h-[50vh] overflow-y-auto">
          <button
            className={`pressable list-row ${selected === null ? "list-row--selected" : ""}`}
            onClick={() => onSelect(null)}
            data-testid="ErdSchemaFilter-all"
          >
            <span className="flex-1">{t("erd.filterAll")}</span>
            <span className="text-xs" style={{ color: "var(--muted)" }}>{nodes.length}</span>
          </button>
          {items.map(([schema, count]) => (
            <button
              key={schema}
              className={`pressable list-row ${selected === schema ? "list-row--selected" : ""}`}
              onClick={() => onSelect(selected === schema ? null : schema)}
              data-testid={`ErdSchemaFilter-item-${schema}`}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{schema}</span>
              {/* 허용/미허용 양쪽 다 표시 — 홈 DB 탭과 같은 문법 / same marks as the home DB tab */}
              <PreviewLockMarks hasAllowed={previewAllowed.has(schema)}
                                hasLocked={!previewAllowed.has(schema)}
                                allowedTitle={t("preview.schemaAllowed")}
                                lockedTitle={t("preview.schemaLocked")}
                                testidPrefix={`ErdSchemaFilter-${schema}`} />
              <span className="text-xs" style={{ color: "var(--muted)" }}>{count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
