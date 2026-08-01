"use client";

/** 메인 화면 — 검색 + ERD 캔버스 / main screen: search plus ERD canvas. */

import { useState } from "react";

import { ErdCanvas } from "@/components/erd/ErdCanvas";
import { SearchPanel } from "@/components/SearchPanel";
import type { ObjectSummary } from "@/lib/types";

export default function Home() {
  const [anchor, setAnchor] = useState<ObjectSummary | null>(null);

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
      </header>
      <main className="flex min-h-0 flex-1">
        <SearchPanel onSelect={setAnchor} selectedId={anchor?.id ?? null} />
        <section className="min-w-0 flex-1">
          <ErdCanvas anchorId={anchor?.id ?? null} />
        </section>
      </main>
    </div>
  );
}
