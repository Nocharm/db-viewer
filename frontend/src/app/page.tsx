"use client";

/** 메인 — 테이블 브라우저: 조인키 필터 → 카테고리 → 테이블 → 상세, 하단 미리보기. / table browser home. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

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
  const router = useRouter();
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

  const handleSelect = useCallback((table: ObjectSummary) => {
    setSelected(table);
    setPreview(null);
    setDetail(null);
    setDetailLoading(true);
    fetchObjectDetail(table.id)
      .then(setDetail)
      .catch((e) => setError(e.message))
      .finally(() => setDetailLoading(false));
  }, []);

  const loadPreview = useCallback(
    (filter?: { column: string; value: string }, scrollTo = false) => {
      if (!selected) return;
      setPreviewLoading(true);
      fetchObjectPreview(selected.id, filter)
        .then((res) => {
          setPreview(res);
          if (scrollTo) {
            // 미리보기 로드 후 하단으로 자동 이동 / auto-navigate down to the preview
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
      {/* 미리보기가 열리면 이 컨테이너에 세로 스크롤이 생긴다 / vertical scroll appears with preview */}
      <div className="scroll-area min-h-0 flex-1">
        <main className="flex" style={{ height: "100%" }}>
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
            onSelect={handleSelect}
          />
          <section className="min-w-0 flex-1">
            <TableDetail
              detail={detail}
              loading={detailLoading}
              previewLoading={previewLoading}
              onPreview={() => loadPreview(undefined, true)}
              onOpenErd={handleOpenErd}
            />
          </section>
        </main>
        {preview && (
          <div ref={previewRef}>
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
