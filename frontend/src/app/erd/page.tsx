"use client";

/** ERD 캔버스 화면 — 검색 + 캔버스 + 컬럼 패널 / the ERD canvas page. */

import { Suspense, useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
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
  const params = useSearchParams();
  const [anchor, setAnchor] = useState<ObjectSummary | null>(() =>
    anchorFromParams(params.get("anchor"), params.get("label")));
  const [selectedColumn, setSelectedColumn] = useState<SelectedColumn | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);

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
          {anchor ? `${anchor.schema}.${anchor.name}` : "테이블을 검색해 시작하세요"}
        </span>
        <button
          className="icon-button"
          onClick={() => {
            void suggestRelationsAi().then((res) =>
              setAiNotice(`AI 제안 ${res.created}건 생성 — 검증 큐에서 확인`));
          }}
          data-testid="Home-aiSuggestButton"
        >
          AI 관계 제안
        </button>
        {aiNotice && (
          <span className="text-sm" style={{ color: "var(--slate)" }}
                data-testid="Home-aiNotice">
            {aiNotice}
          </span>
        )}
      </AppHeader>
      <main className="flex min-h-0 flex-1">
        <SearchPanel onSelect={setAnchor} selectedId={anchor?.id ?? null} />
        <section className="min-w-0 flex-1">
          <ErdCanvas
            anchorId={anchor?.id ?? null}
            onSelectColumn={handleSelectColumn}
            onQuickStart={handleQuickStart}
          />
        </section>
        <ColumnPanel column={selectedColumn} onClose={() => setSelectedColumn(null)} />
      </main>
    </div>
  );
}
