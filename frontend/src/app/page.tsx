"use client";

/** 메인 — 테이블 브라우저. 선택은 URL(?table=)로 관리해 뒤로가기가 이전 테이블로 돌아간다.
 * Table browser home; selection lives in the URL so browser back restores it. */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { CategoryList, type CategoryEntry } from "@/components/browser/CategoryList";
import { JoinKeyBar } from "@/components/browser/JoinKeyBar";
import {
  PreviewSection,
  type PreviewTabState,
  type RefetchOptions,
} from "@/components/browser/PreviewSection";
import { TableDetail } from "@/components/browser/TableDetail";
import { TableList, type TableListItem } from "@/components/browser/TableList";
import {
  assignSchemaCategory,
  fetchAllObjects,
  fetchColumnsIndex,
  fetchJoinKeys,
  fetchObjectDetail,
  fetchObjectPreview,
  fetchSchemaCategories,
  type JoinKeyItem,
  type ObjectDetail,
  type SchemaCategoryItem,
} from "@/lib/api";
import { resolveCategory, type SchemaCategoryMap } from "@/lib/category";
import { loadDbFilter, saveDbFilter } from "@/lib/db-filter";
import { matchTable } from "@/lib/search";
import type { ObjectSummary } from "@/lib/types";
import { useHiddenSchemaPolicy } from "@/lib/use-hidden-schemas";
import { usePreviewAllowlist } from "@/lib/use-preview-allowlist";

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
  const [schemas, setSchemas] = useState<SchemaCategoryItem[]>([]);
  // DB 필터는 개인 설정 — 브라우저별 유지 (카테고리 매핑은 서버 공용)
  const [dbFilter, setDbFilter] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<"all" | "table" | "view">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ObjectSummary | null>(null);
  const [detail, setDetail] = useState<ObjectDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 미리보기 다중 탭 — 같은 테이블은 탭 활성화로만 (중복 열기 차단)
  const [previewTabs, setPreviewTabs] = useState<PreviewTabState[]>([]);
  const [activePreviewId, setActivePreviewId] = useState<number | null>(null);
  const [splitPreviewId, setSplitPreviewId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 미리보기가 열려 있는 테이블 — 관리 콘솔의 허용 목록 (실제 차단은 서버가 한다)
  const previewAllowed = usePreviewAllowlist();
  const previewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchAllObjects()
      .then((res) => setTables(res.items))
      .catch((e) => setError(e.message));
    fetchJoinKeys()
      .then((res) => setJoinKeys(res.items))
      .catch(() => undefined); // 키 집계 실패는 브라우징을 막지 않는다
    fetchColumnsIndex()
      .then((res) => setColumnsIndex(
        new Map(res.items.map((item) => [item.object_id, item.columns]))))
      .catch(() => undefined); // 컬럼 검색만 비활성화될 뿐 / only degrades column search
    fetchSchemaCategories()
      .then((res) => setSchemas(res.items))
      .catch(() => undefined); // 매핑 실패 시 스키마명이 곧 카테고리 / falls back by design
    setDbFilter(loadDbFilter());
  }, []);

  const changeDbFilter = useCallback((next: string[]) => {
    setDbFilter(next);
    saveDbFilter(next);
  }, []);

  const assignCategory = useCallback((schema: string, next: string) => {
    assignSchemaCategory(schema, next)
      .then((updated) => setSchemas((current) => current.map(
        (item) => (item.schema === schema ? { ...item, ...updated } : item))))
      .catch((e) => setError(e.message));
  }, []);

  const categoryBySchema = useMemo<SchemaCategoryMap>(
    () => new Map(schemas.filter((s) => s.mapped).map((s) => [s.schema, s.category])),
    [schemas],
  );

  // URL(?table=) → 선택 동기화 — 뒤로가기·딥링크 지원 / sync selection from the URL
  // 미리보기 탭은 선택과 독립 수명 — 테이블을 바꿔도 탭은 유지된다
  useEffect(() => {
    if (!tableParam || tables.length === 0) {
      setSelected(null);
      setDetail(null);
      return;
    }
    const id = Number(tableParam);
    if (selected?.id === id) return;
    const table = tables.find((t) => t.id === id);
    if (!table) return;
    setSelected(table);
    setDetail(null);
    setDetailLoading(true);
    fetchObjectDetail(table.id)
      .then(setDetail)
      .catch((e) => setError(e.message))
      .finally(() => setDetailLoading(false));
  }, [tableParam, tables, selected]);

  const selectTable = useCallback((table: ObjectSummary) => {
    router.push(`/?table=${table.id}`, { scroll: false });
  }, [router]);

  // 카테고리를 바꾸면 선택된 표가 목록에서 빠질 수 있다 — 목록에 없는 표의 상세가 남으면
  // 무엇을 보고 있는지 어긋난다 / drop the selection when the new category filters it out
  const changeCategory = useCallback((code: string | null) => {
    setCategory(code);
    if (!selected || code === null) return;
    if (resolveCategory(selected.schema, categoryBySchema) !== code) {
      router.push("/", { scroll: false });
    }
  }, [selected, categoryBySchema, router]);

  const selectByQname = useCallback((qname: string) => {
    const [schema, name] = qname.split(".", 2);
    const table = tables.find((t) => t.schema === schema && t.name === name);
    if (table) selectTable(table);
  }, [tables, selectTable]);

  // 타입 필터 + DB 필터가 카테고리 집계에도 반영된다 / both filters feed the counts
  // 감춘 스키마도 여기서 함께 떨군다 — 좌측 스키마·카테고리 목록(categories)과 테이블
  // 목록(listItems)이 둘 다 이 배열에서 나오므로 한 곳만 걸러도 양쪽이 같이 사라진다.
  // 관리 콘솔 토글이 켜져 있으면 종전대로 목록에 남되 열 수는 없다(TableList의 비활성 행).
  // / hidden schemas drop out here too: both the schema/category rail and the table list
  //   derive from this array, so one filter covers both. With the admin toggle on they stay
  //   listed but remain unopenable.
  const hiddenPolicy = useHiddenSchemaPolicy();
  const typedObjects = useMemo(() => {
    const allowed = dbFilter.length > 0 ? new Set(dbFilter) : null;
    return tables.filter((t) =>
      (typeFilter === "all" || t.type === typeFilter)
      && (allowed === null || allowed.has(t.schema))
      && (hiddenPolicy.render || !hiddenPolicy.schemas.has(t.schema.toLowerCase())));
  }, [tables, typeFilter, dbFilter, hiddenPolicy]);

  // 좌측 DB(스키마) 목록은 카탈로그가 아니라 /api/schema-categories에서 오므로 typedObjects
  // 필터를 안 탄다 — 같은 규칙을 여기에도 건다 / the schema rail comes from a separate
  // endpoint, so it needs the same rule applied independently
  const visibleSchemas = useMemo(
    () => (hiddenPolicy.render
      ? schemas
      : schemas.filter((s) => !hiddenPolicy.schemas.has(s.schema.toLowerCase()))),
    [schemas, hiddenPolicy],
  );

  const categories = useMemo<CategoryEntry[]>(() => {
    const counts = new Map<string, number>();
    for (const table of typedObjects) {
      const code = resolveCategory(table.schema, categoryBySchema);
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([code, count]) => ({ code, label: code, count }))
      .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  }, [typedObjects, categoryBySchema]);

  const listItems = useMemo<TableListItem[]>(() => {
    const keyIds = selectedKey ? new Set(selectedKey.table_ids) : null;
    const items: TableListItem[] = [];
    for (const table of typedObjects) {
      const code = resolveCategory(table.schema, categoryBySchema);
      if (category !== null && code !== category) continue;
      if (keyIds !== null && !keyIds.has(table.id)) continue;
      const match = matchTable(query, {
        name: table.name,
        categoryLabel: code,
        columns: columnsIndex.get(table.id) ?? [],
      });
      if (match.matched) items.push({ table, match });
    }
    return items;
  }, [typedObjects, category, categoryBySchema, selectedKey, query, columnsIndex]);

  // 재검색 = 원본 소스에 새 질의 (fixture는 합성으로 대응) / refetch re-queries the source
  const refetchPreview = useCallback((id: number, opts: RefetchOptions) => {
    setPreviewTabs((cur) => cur.map((tab) =>
      tab.id === id ? { ...tab, loading: true } : tab));
    const filter = opts.filterColumn && opts.filterValue
      ? { column: opts.filterColumn, value: opts.filterValue }
      : undefined;
    fetchObjectPreview(id, filter, opts.limit)
      .then((res) => setPreviewTabs((cur) => cur.map((tab) =>
        tab.id === id ? { ...tab, data: res, loading: false } : tab)))
      .catch((e) => {
        setError(e.message);
        setPreviewTabs((cur) => cur.map((tab) =>
          tab.id === id ? { ...tab, loading: false } : tab));
      });
  }, []);

  // 미리보기 열기 — 이미 열려 있으면 탭 활성화만 (중복 열기 차단)
  const openPreview = useCallback(() => {
    if (!selected) return;
    const id = selected.id;
    const exists = previewTabs.some((tab) => tab.id === id);
    if (!exists) {
      setPreviewTabs((cur) => [...cur, {
        id, qname: `${selected.schema}.${selected.name}`,
        data: null, loading: true, hidden: [], sort: null,
      }]);
      refetchPreview(id, {});
    }
    setActivePreviewId(id);
    setTimeout(() => previewRef.current?.scrollIntoView(
      { behavior: "smooth", block: "start" }), 60);
  }, [selected, previewTabs, refetchPreview]);

  const closePreview = useCallback((id: number) => {
    setPreviewTabs((cur) => {
      const next = cur.filter((tab) => tab.id !== id);
      setActivePreviewId((act) => (act === id ? next[next.length - 1]?.id ?? null : act));
      setSplitPreviewId((split) => (split === id ? null : split));
      return next;
    });
  }, []);

  const patchPreview = useCallback(
    (id: number, patch: Partial<Pick<PreviewTabState, "hidden" | "sort">>) => {
      setPreviewTabs((cur) => cur.map((tab) =>
        tab.id === id ? { ...tab, ...patch } : tab));
    }, []);

  const handleOpenErd = useCallback(() => {
    if (!selected) return;
    router.push(`/erd?anchor=${selected.id}&label=${selected.schema}.${selected.name}`);
  }, [router, selected]);

  // 컬럼 클릭 → ERD 조인 빌더로 직행 (검증은 거기서 드래그로 한다). target이 실려 오면
  // (조인 검증 결과의 「빌더에 추가」) 하이라이트 대신 그 스텝을 바로 얹는다
  // column click goes straight to the ERD join builder — validation happens there via drag.
  // When a target rides along (join-check result's "add to builder"), the ERD seeds that
  // step directly instead of just highlighting
  const handleOpenColumn = useCallback(
    (
      columnId: number, columnName: string,
      target?: { qname: string; columnId: number; column: string },
    ) => {
      if (!selected) return;
      const label = `${selected.schema}.${selected.name}`;
      let url = `/erd?anchor=${selected.id}&label=${encodeURIComponent(label)}`
        + `&col=${columnId}&colName=${encodeURIComponent(columnName)}`;
      if (target) {
        url += `&tgtObject=${encodeURIComponent(target.qname)}`
          + `&tgtCol=${target.columnId}&tgtColName=${encodeURIComponent(target.column)}`;
      }
      router.push(url);
    },
    [router, selected],
  );

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
        {/* 좁은 폭에선 상세가 아래로 wrap — 깨짐 방지 / detail wraps below when narrow */}
        <main className="box-border flex flex-wrap content-start gap-4 p-4 lg:h-full lg:flex-nowrap">
          <CategoryList
            categories={categories}
            selected={category}
            totalCount={typedObjects.length}
            onSelect={changeCategory}
            schemas={visibleSchemas}
            dbFilter={dbFilter}
            onDbFilter={changeDbFilter}
            onAssignCategory={assignCategory}
          />
          <TableList
            items={listItems}
            selectedId={selected?.id ?? null}
            query={query}
            typeFilter={typeFilter}
            onQuery={setQuery}
            onTypeFilter={setTypeFilter}
            onSelect={selectTable}
          />
          <section className="card h-[70vh] min-w-0 flex-1 basis-full overflow-hidden lg:h-auto lg:basis-0">
            <TableDetail
              detail={detail}
              loading={detailLoading}
              previewLoading={previewTabs.find((tab) => tab.id === selected?.id)?.loading ?? false}
              previewAllowed={
                selected !== null && previewAllowed.has(selected.schema)
              }
              onPreview={openPreview}
              onOpenErd={handleOpenErd}
              onSelectTable={selectByQname}
              onOpenColumn={handleOpenColumn}
            />
          </section>
        </main>
        {previewTabs.length > 0 && (
          <div ref={previewRef} className="px-4 pb-4">
            <PreviewSection
              tabs={previewTabs}
              activeId={activePreviewId}
              splitId={splitPreviewId}
              onActivate={setActivePreviewId}
              onClose={closePreview}
              onSplitPick={setSplitPreviewId}
              onRefetch={refetchPreview}
              onPatch={patchPreview}
            />
          </div>
        )}
      </div>
    </div>
  );
}
