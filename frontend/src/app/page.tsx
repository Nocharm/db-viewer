"use client";

/** 메인 — 테이블 브라우저: 조인키 필터 → 카테고리 → 테이블 → 상세·미리보기. / table browser home. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { CategoryList, type CategoryEntry } from "@/components/browser/CategoryList";
import { JoinKeyBar } from "@/components/browser/JoinKeyBar";
import { TableDetail } from "@/components/browser/TableDetail";
import { TableList } from "@/components/browser/TableList";
import {
  fetchAllTables,
  fetchJoinKeys,
  fetchObjectDetail,
  fetchObjectPreview,
  type JoinKeyItem,
  type ObjectDetail,
  type TablePreview,
} from "@/lib/api";
import { categoryLabel, deriveCategoryCode } from "@/lib/category";
import type { ObjectSummary } from "@/lib/types";

export default function Home() {
  const router = useRouter();
  const [tables, setTables] = useState<ObjectSummary[]>([]);
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

  useEffect(() => {
    fetchAllTables()
      .then((res) => setTables(res.items))
      .catch((e) => setError(e.message));
    fetchJoinKeys()
      .then((res) => setJoinKeys(res.items))
      .catch(() => undefined); // 키 집계 실패는 브라우징을 막지 않는다
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

  const filtered = useMemo(() => {
    const keyIds = selectedKey ? new Set(selectedKey.table_ids) : null;
    const term = query.trim().toUpperCase();
    return tables.filter((table) =>
      (category === null || deriveCategoryCode(table.name) === category)
      && (keyIds === null || keyIds.has(table.id))
      && (term === "" || table.name.toUpperCase().includes(term)));
  }, [tables, category, selectedKey, query]);

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

  const handlePreview = useCallback(() => {
    if (!selected) return;
    setPreviewLoading(true);
    fetchObjectPreview(selected.id)
      .then(setPreview)
      .catch((e) => setError(e.message))
      .finally(() => setPreviewLoading(false));
  }, [selected]);

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
      <main className="flex min-h-0 flex-1">
        <CategoryList
          categories={categories}
          selected={category}
          totalCount={tables.length}
          onSelect={setCategory}
        />
        <TableList
          tables={filtered}
          selectedId={selected?.id ?? null}
          query={query}
          onQuery={setQuery}
          onSelect={handleSelect}
        />
        <section className="min-w-0 flex-1">
          <TableDetail
            detail={detail}
            loading={detailLoading}
            preview={preview}
            previewLoading={previewLoading}
            onPreview={handlePreview}
            onOpenErd={handleOpenErd}
          />
        </section>
      </main>
    </div>
  );
}
