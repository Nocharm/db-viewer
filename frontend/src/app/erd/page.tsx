"use client";

/** ERD 캔버스 화면 — 검색 + 캔버스 + 컬럼 패널 / the ERD canvas page. */

import { Suspense, useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { useI18n } from "@/components/i18n";
import { ColumnPanel, type SelectedColumn } from "@/components/ColumnPanel";
import { ErdCanvas } from "@/components/erd/ErdCanvas";
import { SearchPanel } from "@/components/SearchPanel";
import { searchObjects, suggestRelationsAi } from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";

export default function ErdPage() {
  return (
    <Suspense fallback={null}>
      <ErdPageInner />
    </Suspense>
  );
}

function anchorFromParams(id: string | null, label: string | null): ObjectSummary | null {
  if (!id || !label || !label.includes(".")) return null;
  const [schema, name] = label.split(".", 2);
  return {
    id: Number(id), schema, name, type: "table",
    row_count: null, column_count: 0, dmv_unresolved: false,
  };
}

function ErdPageInner() {
  const { t } = useI18n();
  const params = useSearchParams();
  const [anchor, setAnchor] = useState<ObjectSummary | null>(() =>
    anchorFromParams(params.get("anchor"), params.get("label")));
  // 브라우저 컬럼 칩 딥링크 → 조인 검증 패널 자동 오픈 / auto-open the validation panel
  const [selectedColumn, setSelectedColumn] = useState<SelectedColumn | null>(() => {
    const columnId = params.get("col");
    const columnName = params.get("colName");
    const label = params.get("label");
    if (columnId && columnName && label) {
      return { id: Number(columnId), name: columnName, object: label };
    }
    return null;
  });
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const handleSelectColumn = useCallback(
    (columnId: number, columnName: string, objectQname: string) =>
      setSelectedColumn({ id: columnId, name: columnName, object: objectQname }),
    [],
  );

  // 빈 캔버스 가이드 칩 → 검색 후 정확 일치 앵커 선택 / quick-start chip resolves an anchor
  const handleQuickStart = useCallback((name: string) => {
    void searchObjects(name).then((res) => {
      const hit = res.items.find((i) => i.name === name) ?? res.items[0];
      if (hit) setAnchor(hit);
    });
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader>
        <span className="text-sm" style={{ color: "var(--muted)" }}>
          {anchor ? `${anchor.schema}.${anchor.name}` : t("erd.startHint")}
        </span>
        <button
          className="icon-button"
          disabled={aiBusy}
          onClick={() => {
            setAiBusy(true);
            void suggestRelationsAi()
              .then((res) =>
                setAiNotice(t("erd.aiNotice").replace("{n}", String(res.created))))
              .finally(() => setAiBusy(false));
          }}
          data-testid="Home-aiSuggestButton"
        >
          {aiBusy ? t("ai.working") : t("erd.aiSuggest")}
        </button>
        {aiNotice && (
          <span className="text-sm" style={{ color: "var(--slate)" }}
                data-testid="Home-aiNotice">
            {aiNotice}
          </span>
        )}
      </AppHeader>
      {/* 캔버스 전체폭 — 검색·검증은 플로팅 오버레이 / full-bleed canvas, floating panels */}
      <main className="relative min-h-0 flex-1">
        <ErdCanvas
          anchorId={anchor?.id ?? null}
          onSelectColumn={handleSelectColumn}
          onQuickStart={handleQuickStart}
        />
        <SearchPanel onSelect={setAnchor} selectedId={anchor?.id ?? null} />
        <ColumnPanel column={selectedColumn} onClose={() => setSelectedColumn(null)} />
      </main>
    </div>
  );
}
