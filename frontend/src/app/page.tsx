"use client";

/** 메인 — 테이블 브라우저. 선택은 URL(?table=)로 관리해 뒤로가기가 이전 테이블로 돌아간다.
 * Table browser home; selection lives in the URL so browser back restores it. */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { CategoryList, type CategoryEntry } from "@/components/browser/CategoryList";
import { JoinKeyBar } from "@/components/browser/JoinKeyBar";
import { PreviewSection } from "@/components/browser/PreviewSection";
import { TableDetail } from "@/components/browser/TableDetail";
import { TableList, type TableListItem } from "@/components/browser/TableList";
import {
  fetchAllTables,
  fetchColumnsIndex,
  fetchJoinKeys,
  fetchObjectDetail,
  fetchObjectPreview,
  type JoinKeyItem,
  type ObjectDetail,
  type TablePreview,
} from "@/lib/api";
import { categoryLabel, deriveCategoryCode } from "@/lib/category";
import { matchTable } from "@/lib/search";
import type { ObjectSummary } from "@/lib/types";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeInner />
    </Suspense>
  );
}

function HomeInner() {
  const router = useRouter();
  const params = useSearchParams();
  const tableParam = params.get("table");

  const [tables, setTables] = useState<ObjectSummary[]>([]);
  const [columnsIndex, setColumnsIndex] = useState<Map<number, string[]>>(new Map());
  const [joinKeys, setJoinKeys] = useState<JoinKeyItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<JoinKeyItem | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ObjectSummary | null>(null);
  const [detail, setDetail] = useState<ObjectDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [preview, setPreview] = useState<TablePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchAllTables()
      .then((res) => setTables(res.items))
      .catch((e) => setError(e.message));
    fetchJoinKeys()
      .then((res) => setJoinKeys(res.items))
      .catch(() => undefined); // 키 집계 실패는 브라우징을 막지 않는다
    fetchColumnsIndex()
      .then((res) => setColumnsIndex(
        new Map(res.items.map((item) => [item.object_id, item.columns]))))
      .catch(() => undefined); // 컬럼 검색만 비활성화될 뿐 / only degrades column search
  }, []);

  // URL(?table=) → 선택 동기화 — 뒤로가기·딥링크 지원 / sync selection from the URL
  useEffect(() => {
    if (!tableParam || tables.length === 0) {
      setSelected(null);
      setDetail(null);
      setPreview(null);
      return;
    }
    const id = Number(tableParam);
    if (selected?.id === id) return;
    const table = tables.find((t) => t.id === id);
    if (!table) return;
    setSelected(table);
    setDetail(null);
    setPreview(null);
    setDetailLoading(true);
    fetchObjectDetail(table.id)
      .then(setDetail)
      .catch((e) => setError(e.message))
      .finally(() => setDetailLoading(false));
  }, [tableParam, tables, selected]);

  const selectTable = useCallback((table: ObjectSummary) => {
    router.push(`/?table=${table.id}`, { scroll: false });
  }, [router]);

  const selectByQname = useCallback((qname: string) => {
    const [schema, name] = qname.split(".", 2);
    const table = tables.find((t) => t.schema === schema && t.name === name);
    if (table) selectTable(table);
  }, [tables, selectTable]);

  const categories = useMemo<CategoryEntry[]>(() => {
    const counts = new Map<string, number>();
    for (const table of tables) {
      const code = deriveCategoryCode(table.name);
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([code, count]) => ({ code, label: categoryLabel(code), count }))
      .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  }, [tables]);

  const listItems = useMemo<TableListItem[]>(() => {
    const keyIds = selectedKey ? new Set(selectedKey.table_ids) : null;
    const items: TableListItem[] = [];
    for (const table of tables) {
      if (category !== null && deriveCategoryCode(table.name) !== category) continue;
      if (keyIds !== null && !keyIds.has(table.id)) continue;
      const match = matchTable(query, {
        name: table.name,
        categoryLabel: categoryLabel(deriveCategoryCode(table.name)),
        columns: columnsIndex.get(table.id) ?? [],
      });
      if (match.matched) items.push({ table, match });
    }
    return items;
  }, [tables, category, selectedKey, query, columnsIndex]);

  // 재검색 = 원본 소스에 새 질의 (fixture는 합성으로 대응) / refetch re-queries the source
  const loadPreview = useCallback(
    (filter?: { column: string; value: string }, scrollTo = false) => {
      if (!selected) return;
      setPreviewLoading(true);
      fetchObjectPreview(selected.id, filter)
        .then((res) => {
          setPreview(res);
          if (scrollTo) {
            setTimeout(() => previewRef.current?.scrollIntoView(
              { behavior: "smooth", block: "start" }), 60);
          }
        })
        .catch((e) => setError(e.message))
        .finally(() => setPreviewLoading(false));
    },
    [selected],
  );

  const handleOpenErd = useCallback(() => {
    if (!selected) return;
    router.push(`/erd?anchor=${selected.id}&label=${selected.schema}.${selected.name}`);
  }, [router, selected]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader>
        {error && (
          <span className="text-sm" style={{ color: "var(--error)" }}
                data-testid="Home-errorText">
            {error}
          </span>
        )}
      </AppHeader>
      <JoinKeyBar items={joinKeys} selected={selectedKey} onSelect={setSelectedKey} />
      {/* 카드 레이아웃 — 선 대신 바탕 톤·여백으로 구분 / cards on a muted surface */}
      <div className="scroll-area surface-muted min-h-0 flex-1">
        <main className="box-border flex gap-4 p-4" style={{ height: "100%" }}>
          <CategoryList
            categories={categories}
            selected={category}
            totalCount={tables.length}
            onSelect={setCategory}
          />
          <TableList
            items={listItems}
            selectedId={selected?.id ?? null}
            query={query}
            onQuery={setQuery}
            onSelect={selectTable}
          />
          <section className="card min-w-0 flex-1 overflow-hidden">
            <TableDetail
              detail={detail}
              loading={detailLoading}
              previewLoading={previewLoading}
              onPreview={() => loadPreview(undefined, true)}
              onOpenErd={handleOpenErd}
              onSelectTable={selectByQname}
            />
          </section>
        </main>
        {preview && (
          <div ref={previewRef} className="px-4 pb-4">
            <PreviewSection
              preview={preview}
              loading={previewLoading}
              onSearch={(column, value) => loadPreview({ column, value })}
              onClear={() => loadPreview(undefined)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
