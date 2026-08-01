"use client";

/** 메인 화면 — 검색 + ERD 캔버스 + 컬럼 패널 / search, canvas, column panel. */

import { useCallback, useState } from "react";

import { ColumnPanel, type SelectedColumn } from "@/components/ColumnPanel";
import { ErdCanvas } from "@/components/erd/ErdCanvas";
import { LogoutButton } from "@/components/logout-button";
import { useMe } from "@/components/providers";
import { SearchPanel } from "@/components/SearchPanel";
import type { ObjectSummary } from "@/lib/types";

export default function Home() {
  const me = useMe();
  const [anchor, setAnchor] = useState<ObjectSummary | null>(null);
  const [selectedColumn, setSelectedColumn] = useState<SelectedColumn | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);

  const handleSelectColumn = useCallback(
    (columnId: number, columnName: string, objectQname: string) =>
      setSelectedColumn({ id: columnId, name: columnName, object: objectQname }),
    [],
  );

  return (
    <div className="flex h-screen flex-col">
      <header
        className="flex items-center gap-3 border-b px-4 py-2"
        style={{ borderColor: "var(--hairline)" }}
      >
        <h1 className="erd-node__header !border-0 !p-0">db-viewer</h1>
        <span className="text-sm" style={{ color: "var(--muted)" }}>
          {anchor ? `${anchor.schema}.${anchor.name}` : "테이블을 검색해 시작하세요"}
        </span>
        <button
          className="icon-button ml-auto"
          onClick={() => {
            import("@/lib/api").then(({ suggestRelationsAi }) =>
              suggestRelationsAi().then((res) =>
                setAiNotice(`AI 제안 ${res.created}건 생성 — 검증 큐에서 확인`)));
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
        <a
          className="text-sm underline"
          style={{ color: "var(--action-blue)" }}
          href="/parsing"
          data-testid="Home-parsingLink"
        >
          파싱 지표
        </a>
        {(me?.is_sysadmin || me?.auth_enabled === false) && (
          <a className="text-sm underline" style={{ color: "var(--action-blue)" }}
             href="/admin" data-testid="Home-adminLink">
            관리
          </a>
        )}
        {me && (
          <span className="text-sm" style={{ color: "var(--slate)" }}
                data-testid="Home-userName">
            {me.name}
          </span>
        )}
        {me?.auth_enabled && <LogoutButton />}
      </header>
      <main className="flex min-h-0 flex-1">
        <SearchPanel onSelect={setAnchor} selectedId={anchor?.id ?? null} />
        <section className="min-w-0 flex-1">
          <ErdCanvas anchorId={anchor?.id ?? null} onSelectColumn={handleSelectColumn} />
        </section>
        <ColumnPanel column={selectedColumn} onClose={() => setSelectedColumn(null)} />
      </main>
    </div>
  );
}
