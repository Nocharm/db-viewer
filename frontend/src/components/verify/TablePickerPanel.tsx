"use client";

/** /verify 좌측 테이블 선택 패널 — 스키마 아코디언 + 하위 테이블 플라이아웃.
 *
 * 2천여 개를 한 목록에 쏟으면 상위 몇십 개 뒤로는 손이 닿지 않는다. 그래서 기본 진입은
 * 스키마(=DB) 목록이고, 스키마를 고르면 그 안의 테이블만 옆으로 펼친다. 검색어를 치면
 * 스키마를 가로질러 평면 결과로 전환한다. 어느 쪽이든 스크롤 끝에서 더 불러온다.
 * Schema-first accordion with a table flyout; typing switches to a flat ranked search.
 * Both lists page in as you scroll.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "@/components/i18n";
import { CaretRightIcon, CloseIcon, DatabaseIcon } from "@/components/icons";
import { fetchAllObjects } from "@/lib/api";
import { rankSearchResults } from "@/lib/search-rank";
import type { ObjectSummary } from "@/lib/types";

interface TablePickerPanelProps {
  side: "src" | "tgt";
  selected: ObjectSummary | null;
  /** 반대편에서 고른 테이블의 스키마 — 스키마 목록에서 맨 위로 올린다(대개 같은 DB끼리 조인) */
  peerSchema: string | null;
  /** null이면 선택 해제 / null clears the selection */
  onSelect: (obj: ObjectSummary | null) => void;
}

// 한 번에 그리는 항목 수 — 스크롤이 끝에 닿을 때마다 이만큼 더 붙인다
const PAGE_SIZE = 40;
// 목록 끝 판정 여유(px) — 마지막 항목이 보이기 시작할 때 미리 채운다
const SCROLL_EPSILON = 48;
// 플라이아웃 크기(px) — 뷰포트 안으로 접어 넣을 때 쓰는 공칭값 / nominal size for clamping
const FLYOUT_WIDTH = 288;
const FLYOUT_HEIGHT = 360;

// 카탈로그 전체(테이블만 2천여 개)는 세션 내내 바뀌지 않는다 — 모듈 단위로 캐시해
// src/tgt 두 패널이 동시에 마운트돼도 fetchAllObjects()가 한 번만 돈다.
// / the full catalog never changes mid-session; cache it once so the src/tgt
//   panels — both mounted on the page at once — don't each pay for their own fetch.
let cachedTables: ObjectSummary[] | null = null;
let inFlight: Promise<ObjectSummary[]> | null = null;

function loadTables(): Promise<ObjectSummary[]> {
  if (cachedTables) return Promise.resolve(cachedTables);
  inFlight ??= fetchAllObjects()
    .then((res) => {
      cachedTables = res.items.filter((o) => o.type === "table");
      return cachedTables;
    })
    .catch((e: Error) => {
      inFlight = null; // 실패는 캐시하지 않는다 — 다음 마운트에서 재시도
      throw e;
    });
  return inFlight;
}

function getLabel(obj: ObjectSummary): string {
  return `${obj.schema}.${obj.name}`;
}

/** 스크롤이 바닥 근처면 더 그린다 / grow the page when the scroll reaches the end. */
function handleScrollEnd(
  event: React.UIEvent<HTMLElement>, grow: () => void,
): void {
  const el = event.currentTarget;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_EPSILON) grow();
}

export function TablePickerPanel({
  side, selected, peerSchema, onSelect,
}: TablePickerPanelProps) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [tables, setTables] = useState<ObjectSummary[]>(() => cachedTables ?? []);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // 아코디언에서 펼친 스키마 + 플라이아웃 좌표. 좌측 열이 overflow-y:auto라 그 안의
  // absolute 박스는 열 밖으로 못 나간다 — fixed로 띄워 클리핑을 벗어난다
  // / the left column clips its overflow, so the flyout is fixed, not absolute
  const [openSchema, setOpenSchema] = useState<string | null>(null);
  const [flyoutPos, setFlyoutPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [schemaQ, setSchemaQ] = useState("");
  const [searchLimit, setSearchLimit] = useState(PAGE_SIZE);
  const [flyoutLimit, setFlyoutLimit] = useState(PAGE_SIZE);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (cachedTables) return;
    loadTables().then(setTables).catch((e: Error) => setError(e.message));
  }, []);

  // 바깥 클릭으로 닫기 — AppHeader.UserMenu와 동일 패턴 / close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeAll();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const closeAll = () => {
    setOpen(false);
    setOpenSchema(null);
    setSchemaQ("");
  };

  // 스키마 목록 — 상대편 스키마가 맨 위(대개 같은 DB끼리 조인한다), 나머지는 이름순
  const schemas = useMemo(() => {
    const counts = new Map<string, number>();
    for (const table of tables) {
      counts.set(table.schema, (counts.get(table.schema) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([schema, count]) => ({ schema, count }))
      .sort((a, b) => {
        if (a.schema === peerSchema) return -1;
        if (b.schema === peerSchema) return 1;
        return a.schema.localeCompare(b.schema);
      });
  }, [tables, peerSchema]);

  const searchHits = useMemo(
    () => (q ? rankSearchResults(q, tables, getLabel) : []),
    [q, tables],
  );
  const results = searchHits.slice(0, searchLimit);
  // 타이핑 중 목록이 줄어들면 이전 activeIndex가 범위를 벗어날 수 있다 — 렌더 시점에 보정
  const activeIdx = results.length === 0 ? -1 : Math.min(activeIndex, results.length - 1);

  const schemaTables = useMemo(() => {
    if (!openSchema) return [];
    const inSchema = tables.filter((table) => table.schema === openSchema);
    if (!schemaQ) return inSchema.sort((a, b) => a.name.localeCompare(b.name));
    return rankSearchResults(schemaQ, inSchema, (o) => o.name);
  }, [tables, openSchema, schemaQ]);
  const flyoutItems = schemaTables.slice(0, flyoutLimit);

  const pick = (item: ObjectSummary) => {
    onSelect(item);
    setQ("");
    closeAll();
  };

  const openSchemaFlyout = (schema: string, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setFlyoutPos({
      x: Math.min(rect.right + 8, window.innerWidth - FLYOUT_WIDTH - 8),
      y: Math.min(Math.max(rect.top - 4, 8), window.innerHeight - FLYOUT_HEIGHT - 8),
    });
    setOpenSchema((cur) => (cur === schema ? null : schema));
    setSchemaQ("");
    setFlyoutLimit(PAGE_SIZE);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    if (e.key === "Escape") {
      closeAll();
      return;
    }
    if (results.length === 0) return; // 스키마 아코디언은 마우스 조작 / accordion is pointer-driven
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(Math.min(activeIdx + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(Math.max(activeIdx - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[activeIdx];
      if (item) pick(item);
    }
  };

  const moreHint = (shown: number, total: number) =>
    t("verify.scrollForMore").replace("{shown}", String(shown)).replace("{total}", String(total));

  return (
    <section className="card p-3" data-testid={`TablePickerPanel-root-${side}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: "var(--muted)" }}>
          {t(side === "src" ? "verify.srcTitle" : "verify.tgtTitle")}
        </span>
      </div>

      <div ref={rootRef} className="relative">
        <div className="flex items-center gap-1">
          <input
            className="w-full rounded border px-3 py-2 text-sm outline-none focus:border-[var(--focus-blue)]"
            style={{ borderColor: "var(--border-light)" }}
            placeholder={t("verify.searchPlaceholder")}
            value={selected ? getLabel(selected) : q}
            readOnly={!!selected}
            onFocus={() => {
              if (selected) return;
              setActiveIndex(0);
              setOpen(true);
            }}
            onChange={(e) => {
              setQ(e.target.value);
              setActiveIndex(0);
              setSearchLimit(PAGE_SIZE);
              setOpenSchema(null);
              setOpen(true);
            }}
            onKeyDown={handleKeyDown}
            data-testid={`TablePickerPanel-searchInput-${side}`}
          />
          {selected && (
            <button
              className="icon-button"
              onClick={() => onSelect(null)}
              title={t("verify.clearSelection")}
              data-testid={`TablePickerPanel-clearButton-${side}`}
            >
              <CloseIcon />
            </button>
          )}
        </div>

        {open && !selected && (
          <div className="absolute inset-x-0 top-full z-50 mt-1">
            {tables.length === 0 && !error ? (
              <div className="rounded-lg border px-2 py-1.5 text-xs"
                   style={{ borderColor: "var(--hairline)", background: "var(--surface-card)",
                            color: "var(--muted)" }}>
                {t("common.loading")}
              </div>
            ) : q ? (
              /* 검색어가 있으면 스키마를 가로지르는 평면 결과 / flat cross-schema results */
              <ul className="scroll-area max-h-64 overflow-y-auto rounded-lg border py-1"
                  style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
                  onScroll={(e) => handleScrollEnd(e, () => setSearchLimit((n) => n + PAGE_SIZE))}
                  data-testid={`TablePickerPanel-resultList-${side}`}>
                {results.length === 0 ? (
                  <li className="px-2 py-1.5 text-xs" style={{ color: "var(--muted)" }}
                      data-testid={`TablePickerPanel-emptyState-${side}`}>
                    {t("erd.noResults")}
                  </li>
                ) : (
                  <>
                    {results.map((item, idx) => (
                      <li key={item.id}>
                        <button
                          className="w-full px-2 py-1.5 text-left font-mono text-xs hover:bg-[var(--soft-stone)]"
                          style={idx === activeIdx ? { background: "var(--soft-stone)" } : undefined}
                          onMouseEnter={() => setActiveIndex(idx)}
                          onClick={() => pick(item)}
                          // 두 패널이 같은 테이블을 동시에 띄울 수 있어 side까지 넣어야 유일해진다
                          data-testid={`TablePickerPanel-item-${side}-${item.id}`}
                        >
                          {getLabel(item)}
                          <span className="float-right" style={{ color: "var(--muted)" }}>
                            {item.column_count}c
                          </span>
                        </button>
                      </li>
                    ))}
                    {results.length < searchHits.length && (
                      <li className="px-2 py-1.5 text-center text-[11px]"
                          style={{ color: "var(--muted)" }}
                          data-testid={`TablePickerPanel-moreHint-${side}`}>
                        {moreHint(results.length, searchHits.length)}
                      </li>
                    )}
                  </>
                )}
              </ul>
            ) : (
              /* 기본 진입 — 스키마 아코디언 / schema-first accordion */
              <ul className="scroll-area max-h-64 overflow-y-auto rounded-lg border py-1"
                  style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
                  data-testid={`TablePickerPanel-schemaList-${side}`}>
                <li className="px-2 pb-1 text-[11px] uppercase tracking-widest"
                    style={{ color: "var(--muted)" }}>
                  {t("verify.pickSchema")}
                </li>
                {schemas.map(({ schema, count }) => (
                  <li key={schema}>
                    <button
                      className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left font-mono text-xs hover:bg-[var(--soft-stone)]"
                      style={openSchema === schema ? { background: "var(--soft-stone)" } : undefined}
                      onClick={(e) => openSchemaFlyout(schema, e.currentTarget)}
                      data-testid={`TablePickerPanel-schema-${side}-${schema}`}
                    >
                      <DatabaseIcon size={11} className="shrink-0"
                                    style={{ color: "var(--muted)" }} />
                      <span className="truncate">{schema}</span>
                      {schema === peerSchema && (
                        <span className="badge badge--muted shrink-0 !py-0 text-[10px]">
                          {t("verify.samePeerSchema")}
                        </span>
                      )}
                      <span className="ml-auto shrink-0" style={{ color: "var(--muted)" }}>
                        {t("verify.schemaTableCount").replace("{n}", String(count))}
                      </span>
                      <CaretRightIcon size={10} className="shrink-0"
                                      style={{ color: "var(--muted)" }} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* 하위 플라이아웃 — 좁은 좌측 열을 넘어 오른쪽으로 펼친다(목록이 길어 여백이 필요하다)
                / the table list flies out to the right, where there is room */}
            {openSchema && !q && (
              <div className="fixed z-50 w-72 rounded-lg border p-2 shadow-lg"
                   style={{ left: flyoutPos.x, top: flyoutPos.y,
                            borderColor: "var(--hairline-strong)",
                            background: "var(--surface-card)" }}
                   data-testid={`TablePickerPanel-flyout-${side}`}>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="truncate font-mono text-xs font-semibold"
                        style={{ color: "var(--ink)" }}>
                    {openSchema}
                  </span>
                  <button className="icon-button ml-auto !px-1.5 !py-0.5"
                          onClick={() => setOpenSchema(null)}
                          data-testid={`TablePickerPanel-flyoutClose-${side}`}>
                    <CloseIcon size={11} />
                  </button>
                </div>
                <input
                  className="mb-1 w-full rounded border px-2 py-1 text-xs outline-none focus:border-[var(--focus-blue)]"
                  style={{ borderColor: "var(--border-light)" }}
                  placeholder={t("verify.tableFilterPlaceholder")}
                  value={schemaQ}
                  onChange={(e) => {
                    setSchemaQ(e.target.value);
                    setFlyoutLimit(PAGE_SIZE);
                  }}
                  data-testid={`TablePickerPanel-flyoutFilter-${side}`}
                />
                <ul className="scroll-area max-h-60 overflow-y-auto"
                    onScroll={(e) => handleScrollEnd(e, () => setFlyoutLimit((n) => n + PAGE_SIZE))}
                    data-testid={`TablePickerPanel-flyoutList-${side}`}>
                  {flyoutItems.length === 0 ? (
                    <li className="px-2 py-1.5 text-xs" style={{ color: "var(--muted)" }}>
                      {t("erd.noResults")}
                    </li>
                  ) : (
                    <>
                      {flyoutItems.map((item) => (
                        <li key={item.id}>
                          <button
                            className="w-full px-2 py-1.5 text-left font-mono text-xs hover:bg-[var(--soft-stone)]"
                            onClick={() => pick(item)}
                            data-testid={`TablePickerPanel-item-${side}-${item.id}`}
                          >
                            {item.name}
                            <span className="float-right" style={{ color: "var(--muted)" }}>
                              {item.column_count}c
                            </span>
                          </button>
                        </li>
                      ))}
                      {flyoutItems.length < schemaTables.length && (
                        <li className="px-2 py-1.5 text-center text-[11px]"
                            style={{ color: "var(--muted)" }}
                            data-testid={`TablePickerPanel-flyoutMoreHint-${side}`}>
                          {moreHint(flyoutItems.length, schemaTables.length)}
                        </li>
                      )}
                    </>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="mt-1 text-xs" style={{ color: "var(--error)" }}
           data-testid={`TablePickerPanel-errorText-${side}`}>
          {error}
        </p>
      )}
    </section>
  );
}
