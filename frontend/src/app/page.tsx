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
import { SourceSelector } from "@/components/SourceSelector";
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
import { readSourceId, withSourceQuery } from "@/lib/source-param";
import type { ObjectSummary } from "@/lib/types";
import { useDataSources } from "@/lib/use-data-sources";
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
  // useSearchParams()에서 초기값을 뽑는다 — window.location은 SSR(standalone 출력)에서
  // 없다. 이후 갱신은 history.replaceState가 맡고 이 state가 진실 소스가 된다(Next 라우터를
  // 거치지 않는 replaceState는 useSearchParams()에 반영되지 않는다) / seeded from the
  // router's searchParams (SSR-safe, unlike window.location); later changes go through
  // this state directly since a plain history.replaceState never updates useSearchParams().
  const [sourceId, setSourceId] = useState<number | null>(
    () => readSourceId(`?${params.toString()}`),
  );
  const sources = useDataSources();
  const selectedSource = sourceId !== null ? sources.find((s) => s.id === sourceId) : null;
  // 기본 소스(null)는 항상 MSSQL — 아직 목록이 안 실렸을 때도 헤더 링크를 숨기지 않는다
  const sourceEngine = sourceId === null ? null : (selectedSource?.engine ?? null);
  // 검증 화면은 항상 기본(MSSQL) 소스만 본다 — 다른 소스를 보는 중엔 진입시키지 않는다
  const isMssqlSource = sourceEngine === null || sourceEngine === "mssql";

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
  const previewAllowed = usePreviewAllowlist(sourceId);
  const previewRef = useRef<HTMLDivElement | null>(null);

  // 카탈로그 조회 — 소스가 바뀔 때마다 다시 조회한다 / re-fetched whenever the source changes
  useEffect(() => {
    fetchAllObjects(sourceId)
      .then((res) => setTables(res.items))
      .catch((e) => setError(e.message));
    fetchJoinKeys(sourceId)
      .then((res) => setJoinKeys(res.items))
      .catch(() => undefined); // 키 집계 실패는 브라우징을 막지 않는다
    fetchColumnsIndex(sourceId)
      .then((res) => setColumnsIndex(
        new Map(res.items.map((item) => [item.object_id, item.columns]))))
      .catch(() => undefined); // 컬럼 검색만 비활성화될 뿐 / only degrades column search
    fetchSchemaCategories(sourceId)
      .then((res) => setSchemas(res.items))
      .catch(() => undefined); // 매핑 실패 시 스키마명이 곧 카테고리 / falls back by design
  }, [sourceId]);

  // DB 필터는 개인 설정 — 마운트 시 1회만 브라우저 저장값을 불러온다(소스 전환과 무관)
  useEffect(() => {
    setDbFilter(loadDbFilter());
  }, []);

  // 소스 전환 — 이전 소스의 선택·미리보기·필터가 새 소스에 없는 객체를 가리킬 수 있어
  // 목록이 갱신되기 전에 먼저 지운다. dbFilter는 []로 리셋: 이전 소스의 스키마명이 새
  // 소스에 없으면 목록이 통째로 빈 것처럼 보인다(버그로 오인하기 쉽다).
  // / switching sources: clear anything that might point at the old source's objects
  // before the new catalog loads; dbFilter resets to [] since a stale schema-name filter
  // would otherwise silently empty the whole list on the new source.
  const changeSource = useCallback((nextSourceId: number | null) => {
    setSourceId(nextSourceId);
    setSelected(null);
    setDetail(null);
    setPreviewTabs([]);
    setActivePreviewId(null);
    setSplitPreviewId(null);
    setSelectedKey(null);
    setCategory(null);
    setDbFilter([]);
    setError(null);

    const url = new URL(window.location.href);
    if (nextSourceId === null) url.searchParams.delete("source");
    else url.searchParams.set("source", String(nextSourceId));
    url.searchParams.delete("table"); // 방금 지운 선택과 URL을 맞춘다
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, []);

  const changeDbFilter = useCallback((next: string[]) => {
    setDbFilter(next);
    saveDbFilter(next);
  }, []);

  const assignCategory = useCallback((schema: string, next: string) => {
    assignSchemaCategory(schema, next, sourceId)
      .then((updated) => setSchemas((current) => current.map(
        (item) => (item.schema === schema ? { ...item, ...updated } : item))))
      .catch((e) => setError(e.message));
  }, [sourceId]);

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

  // withSourceQuery로 ?source=를 지금 선택된 값 그대로 실어 보낸다 — 안 그러면 테이블을
  // 클릭할 때마다 URL에서 소스가 빠져 새로고침·공유가 조용히 기본 소스로 돌아간다
  const selectTable = useCallback((table: ObjectSummary) => {
    router.push(withSourceQuery(`/?table=${table.id}`, sourceId), { scroll: false });
  }, [router, sourceId]);

  // 카테고리를 바꾸면 선택된 표가 목록에서 빠질 수 있다 — 목록에 없는 표의 상세가 남으면
  // 무엇을 보고 있는지 어긋난다 / drop the selection when the new category filters it out
  const changeCategory = useCallback((code: string | null) => {
    setCategory(code);
    if (!selected || code === null) return;
    if (resolveCategory(selected.schema, categoryBySchema) !== code) {
      router.push(withSourceQuery("/", sourceId), { scroll: false });
    }
  }, [selected, categoryBySchema, router, sourceId]);

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
    // 검색어가 있을 때만 등급 정렬 — 빈 검색어의 기본 목록은 백엔드 (schema, name) 순서를 보존한다
    if (query.trim() !== "") {
      items.sort((a, b) => a.match.rank - b.match.rank
        || a.table.name.localeCompare(b.table.name));
    }
    return items;
  }, [typedObjects, category, categoryBySchema, selectedKey, query, columnsIndex]);

  // 재검색 = 원본 소스에 새 질의 (fixture는 합성으로 대응) / refetch re-queries the source
  const refetchPreview = useCallback((id: number, opts: RefetchOptions) => {
    setPreviewTabs((cur) => cur.map((tab) =>
      tab.id === id ? { ...tab, loading: true } : tab));
    fetchObjectPreview(id, opts.filters, opts.limit)
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
        data: null, loading: true, hidden: [], sort: null, order: [],
      }]);
      refetchPreview(id, {});
    }
    setActivePreviewId(id);
    setTimeout(() => previewRef.current?.scrollIntoView(
      { behavior: "smooth", block: "start" }), 60);
  }, [selected, previewTabs, refetchPreview]);

  // ERD 우클릭 메뉴의 「미리보기」 딥링크(?table=&preview=1) — 선택이 잡히면 한 번 열고
  // 파라미터를 소진한다(남기면 새로고침·뒤로가기마다 재발동). 미허용 스키마면 열지 않고
  // 소진만 — 상세의 잠긴 버튼과 사유 문구가 상태를 설명한다
  // / one-shot auto-preview for the ERD context-menu deep link; the param is consumed
  //   either way so refresh/back never re-triggers it
  const previewParam = params.get("preview");
  useEffect(() => {
    if (previewParam !== "1" || !selected) return;
    if (previewAllowed.has(selected.schema)) openPreview();
    router.replace(withSourceQuery(`/?table=${selected.id}`, sourceId), { scroll: false });
  }, [previewParam, selected, previewAllowed, openPreview, router, sourceId]);

  const closePreview = useCallback((id: number) => {
    setPreviewTabs((cur) => {
      const next = cur.filter((tab) => tab.id !== id);
      setActivePreviewId((act) => (act === id ? next[next.length - 1]?.id ?? null : act));
      setSplitPreviewId((split) => (split === id ? null : split));
      return next;
    });
  }, []);

  const patchPreview = useCallback(
    (id: number, patch: Partial<Pick<PreviewTabState, "hidden" | "sort" | "order">>) => {
      setPreviewTabs((cur) => cur.map((tab) =>
        tab.id === id ? { ...tab, ...patch } : tab));
    }, []);

  const handleOpenErd = useCallback(() => {
    if (!selected) return;
    const url = `/erd?focus=${selected.id}&label=${selected.schema}.${selected.name}`;
    router.push(withSourceQuery(url, sourceId)); // 지금 보던 소스 그대로 연다
  }, [router, selected, sourceId]);

  // 3열 리사이즈 — lg(nowrap)에서만 핸들이 보인다. min/max는 섹션이 깨지지 않는 실측 하한·
  // 상한: 카테고리는 행 라벨+카운트, 목록은 검색줄+타입 칩이 min을 정하고, max는 상세가
  // 유효 폭을 잃지 않는 선 (상세 자체는 lg:min-w-80으로 최후 방어)
  const [paneWidths, setPaneWidths] = useState({ rail: 176, list: 320 });
  const startPaneResize = (pane: "rail" | "list") => (event: React.PointerEvent) => {
    event.preventDefault();
    const limits = pane === "rail" ? { min: 150, max: 300 } : { min: 260, max: 520 };
    const startX = event.clientX;
    const startWidth = paneWidths[pane];
    // PreviewTable 컬럼 리사이즈와 같은 window 리스너 관용구 / same idiom as the column resize
    const onMove = (e: PointerEvent) => {
      const next = Math.min(Math.max(startWidth + (e.clientX - startX), limits.min), limits.max);
      setPaneWidths((cur) => ({ ...cur, [pane]: Math.round(next) }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // 컬럼 클릭 → 조인 검증 페이지로 직행 — 소스 테이블·컬럼 프리필, target이 실려 오면
  // (조인 체크 결과의 「검증에 추가」) 타깃까지 채워 게이트부터 시작한다.
  // 검증은 항상 기본(MSSQL) 소스만 보므로, 다른 소스를 보는 중엔 엉뚱한 소스의 검증
  // 화면으로 이어지지 않도록 조용히 막는다 / verify always targets the default source, so
  // block the jump while browsing a non-mssql source instead of landing on the wrong data.
  const handleOpenColumn = useCallback(
    (
      columnId: number,
      target?: { qname: string; columnId: number; column: string },
    ) => {
      if (!selected || !isMssqlSource) return;
      const label = `${selected.schema}.${selected.name}`;
      let url = `/verify?src=${selected.id}&srcLabel=${encodeURIComponent(label)}`
        + `&srcCol=${columnId}`;
      if (target) {
        url += `&tgtLabel=${encodeURIComponent(target.qname)}&tgtCol=${target.columnId}`;
      }
      router.push(url);
    },
    [router, selected, isMssqlSource],
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader sourceEngine={sourceEngine}>
        <SourceSelector value={sourceId} onChange={changeSource} />
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
            previewAllowed={previewAllowed}
            width={paneWidths.rail}
          />
          {/* 리사이저 — wrap 모드(좁은 화면)에선 열 개념이 없어 숨긴다 */}
          <div className="pane-resize hidden lg:block"
               onPointerDown={startPaneResize("rail")}
               data-testid="Home-railResizeHandle" />
          <TableList
            items={listItems}
            selectedId={selected?.id ?? null}
            query={query}
            typeFilter={typeFilter}
            onQuery={setQuery}
            onTypeFilter={setTypeFilter}
            onSelect={selectTable}
            width={paneWidths.list}
          />
          <div className="pane-resize hidden lg:block"
               onPointerDown={startPaneResize("list")}
               data-testid="Home-listResizeHandle" />
          <section className="card h-[70vh] min-w-0 flex-1 basis-full overflow-hidden lg:h-auto lg:basis-0 lg:min-w-80">
            <TableDetail
              detail={detail}
              loading={detailLoading}
              previewLoading={previewTabs.find((tab) => tab.id === selected?.id)?.loading ?? false}
              previewAllowed={
                selected !== null && previewAllowed.has(selected.schema)
              }
              isMssqlSource={isMssqlSource}
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
