"use client";

/** 우측 테이블 정보 패널 — 사용 뷰·유사 테이블·관계·조인 검증. / table detail panel. */

import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/components/i18n";
import { InfoTip } from "@/components/InfoTip";
import {
  explainViewAi,
  generateAiSummary,
  runJoinCheck,
  type JoinCheckItem,
  type ObjectDetail,
} from "@/lib/api";
import { useElapsedSeconds } from "@/lib/use-elapsed";
import { isQnameHidden, useHiddenSchemas } from "@/lib/use-hidden-schemas";

interface Props {
  detail: ObjectDetail | null;
  loading: boolean;
  previewLoading: boolean;
  /** 이 테이블의 스키마가 허용 목록에 있는지 — 아니면 버튼을 잠근다 (실제 차단은 서버). */
  previewAllowed: boolean;
  onPreview: () => void;
  onOpenErd: () => void;
  /** 상세 안의 테이블명 클릭 → 해당 테이블 선택 / click-through to another table */
  onSelectTable: (qname: string) => void;
  /** 컬럼 칩 클릭 → ERD 조인 검증 패널로 이동. target이 있으면(조인 검증 결과 행) 하이라이트
   * 대신 그 스텝을 빌더에 바로 얹는다 / opens the ERD join panel; when target is given (a
   * join-check result row) the ERD seeds that step in the builder instead of just highlighting */
  onOpenColumn: (
    columnId: number, columnName: string,
    target?: { qname: string; columnId: number; column: string },
  ) => void;
}

/** 접힌 컬럼 영역 높이 = 칩 2줄. 칩 26px(12px 글자 + py-1 + 테두리) × 2 + gap-2 8px */
const COLLAPSED_COLUMNS_HEIGHT = 60;

/** 클릭 가능한 테이블명 / clickable table reference. */
function TableRef({ name, onSelect }: { name: string; onSelect: (qname: string) => void }) {
  const { t } = useI18n();
  const hidden = useHiddenSchemas();

  // 감춘 스키마는 이름만 남긴다 — 관계가 어디로 이어지는지는 보이되 타고 넘어갈 수 없다.
  // 모든 관계 목록(FK·lineage·유사·관계·조인체크)이 이 컴포넌트를 지나므로 여기 한 곳에서
  // 막으면 진입점이 갈라지지 않는다.
  // / a hidden schema keeps its name but loses the link: every relation list on this panel
  //   renders through TableRef, so blocking here covers all of them at once.
  if (isQnameHidden(name, hidden)) {
    return (
      <span
        className="-mx-1 truncate px-1 text-left font-mono"
        style={{ color: "var(--muted)" }}
        title={t("hidden.notNavigable")}
        data-testid={`TableDetail-refHidden-${name}`}
      >
        {name} <span className="badge badge--muted">{t("hidden.badge")}</span>
      </span>
    );
  }

  return (
    <button
      className="pressable -mx-1 truncate rounded px-1 text-left font-mono underline-offset-2 hover:underline"
      style={{ color: "var(--action-blue)" }}
      onClick={() => onSelect(name)}
      data-testid={`TableDetail-ref-${name}`}
    >
      {name}
    </button>
  );
}

/** 조인 검증 결과 행 / one join-check result row. */
function JoinCheckRow({ item, onSelectTable, onOpenColumn }: {
  item: JoinCheckItem;
  onSelectTable: (qname: string) => void;
  onOpenColumn: Props["onOpenColumn"];
}) {
  const { t } = useI18n();
  return (
    <li className="flex items-center gap-3 text-sm">
      <span className="w-52 truncate text-xs">
        <TableRef name={item.target_object} onSelect={onSelectTable} />
      </span>
      <span className="truncate font-mono text-[11px]" style={{ color: "var(--slate)" }}>
        {item.src_column} → {item.tgt_column}
      </span>
      {item.status === "checked" ? (
        <>
          <span className="ml-auto text-xs font-semibold tabular-nums"
                style={{ color: "var(--stat-ink)" }}>
            {((item.containment ?? 0) * 100).toFixed(1)}%
          </span>
          <span className="badge badge--muted">{item.cardinality}</span>
        </>
      ) : (
        <span className="ml-auto badge badge--muted">{t("joincheck.noData")}</span>
      )}
      <button
        className="btn-secondary !py-0.5 text-xs"
        onClick={() => onOpenColumn(item.src_column_id, item.src_column, {
          qname: item.target_object, columnId: item.tgt_column_id, column: item.tgt_column,
        })}
        data-testid={`TableDetail-addToBuilder-${item.target_object}`}
      >
        {t("joincheck.addToBuilder")}
      </button>
    </li>
  );
}

export function TableDetail({
  detail, loading, previewLoading, previewAllowed, onPreview, onOpenErd, onSelectTable,
  onOpenColumn,
}: Props) {
  const { t } = useI18n();
  const [checkResults, setCheckResults] = useState<JoinCheckItem[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  // AI 산출물은 상세 응답을 덮지 않고 로컬로 겹친다 / AI outputs overlay locally
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  // LLM 미연결 휴리스틱 산출물 표시 — 실 판단으로 오독되면 검증이 오염된다
  const [aiMock, setAiMock] = useState(false);
  // 장시간 검증의 살아있음 표시 / liveness indicator for long-running checks
  const checkElapsed = useElapsedSeconds(checking);
  // 컬럼 칩은 기본 2줄만 — 컬럼 수십 개짜리 테이블이 나머지 섹션을 화면 밖으로 밀어낸다
  const [columnsExpanded, setColumnsExpanded] = useState(false);
  const [columnsHeight, setColumnsHeight] = useState(0);
  const columnsRef = useRef<HTMLDivElement>(null);

  // 테이블 전환 시 검증·AI 상태 초기화 / reset per-table state on switch
  useEffect(() => {
    setCheckResults(null);
    setChecking(false);
    setCheckError(null);
    setAiSummary(null);
    setAiExplanation(null);
    setAiBusy(false);
    setColumnsExpanded(false);
  }, [detail?.id]);

  // 칩 줄바꿈은 패널 폭에 따라 달라진다 — 실측해야 「더보기」 노출과 펼침 높이가 맞는다
  useEffect(() => {
    const box = columnsRef.current;
    if (!box) return;
    setColumnsHeight(box.scrollHeight);
    const observer = new ResizeObserver(() => setColumnsHeight(box.scrollHeight));
    observer.observe(box);
    return () => observer.disconnect();
  }, [detail?.id]);

  const runAi = (task: () => Promise<void>) => {
    if (aiBusy) return;
    setAiBusy(true);
    task().catch((e) => setCheckError(e.message)).finally(() => setAiBusy(false));
  };

  const runCheck = (targetId?: number) => {
    if (!detail || checking) return;
    setChecking(true);
    setCheckError(null);
    runJoinCheck(detail.id, targetId)
      .then((res) => {
        const merged = [...res.checked, ...res.no_data];
        setCheckResults((cur) => {
          if (targetId === undefined || cur === null) return merged;
          // 단건 검증은 기존 결과에 갈아끼움 / single-target result replaces its row
          const rest = cur.filter(
            (item) => !merged.some((m) => m.target_object === item.target_object),
          );
          return [...merged, ...rest];
        });
      })
      .catch((e) => setCheckError(e.message))
      .finally(() => setChecking(false));
  };

  if (!detail) {
    if (loading) {
      // 텍스트 대신 스켈레톤 — 로딩을 형태로 전달 / skeleton instead of loading text
      return (
        <div className="h-full p-7" data-testid="TableDetail-emptyState">
          <div className="skeleton mb-3 h-8 w-64" />
          <div className="skeleton mb-7 h-4 w-40" />
          <div className="mb-7 flex gap-3">
            <div className="skeleton h-10 w-36" />
            <div className="skeleton h-10 w-28" />
          </div>
          <div className="skeleton mb-5 h-32 w-full max-w-4xl" />
          <div className="grid max-w-4xl grid-cols-2 gap-5">
            <div className="skeleton h-40" />
            <div className="skeleton h-40" />
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2"
           data-testid="TableDetail-emptyState">
        <span className="text-2xl" aria-hidden style={{ color: "var(--muted-soft)" }}>⌗</span>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {t("detail.empty")}
        </p>
      </div>
    );
  }

  return (
    <div className="scroll-area h-full min-h-0 p-7" data-testid="TableDetail-root">
      {/* 헤더 — 시선 앵커: title-lg 24px/700 / eye anchor per ClickHouse title-lg */}
      <div className="mb-2 flex flex-wrap items-baseline gap-3">
        <h2 className="font-mono text-2xl font-bold tracking-tight"
            style={{ color: "var(--ink)" }}>
          {detail.name}
        </h2>
        <span className="badge badge--muted"
              style={detail.type === "view" ? { color: "var(--obj-view)" } : undefined}>
          {detail.type === "view" ? "VIEW" : "TABLE"}
        </span>
        {(aiSummary ?? detail.ai_summary) && <span className="badge badge--ai">AI</span>}
        {aiMock && (
          <span className="badge badge--muted" data-testid="TableDetail-aiMockBadge">
            {t("ai.mockBadge")}
          </span>
        )}
      </div>
      <p className="mb-2 text-sm" style={{ color: "var(--slate)" }}>
        {detail.row_count !== null && `${detail.row_count.toLocaleString()} rows · `}
        {detail.column_count} columns
      </p>
      {(aiSummary ?? detail.ai_summary) && (
        <p className="mb-2 max-w-2xl text-sm leading-relaxed"
           style={{ color: "var(--slate)" }}>
          {aiSummary ?? detail.ai_summary}
        </p>
      )}
      {aiExplanation && (
        <p className="mb-2 max-w-2xl text-sm leading-relaxed"
           style={{ color: "var(--slate)" }}
           data-testid="TableDetail-aiExplanation">
          <span className="badge badge--ai mr-1.5">AI</span>
          {aiExplanation}
        </p>
      )}
      <div className="mb-5 flex gap-2">
        <button
          className="icon-button"
          disabled={aiBusy}
          onClick={() => runAi(async () => {
            const res = await generateAiSummary(detail.id);
            setAiSummary(res.summary);
            setAiMock(res.mock);
          })}
          data-testid="TableDetail-aiSummaryButton"
        >
          {aiBusy ? t("ai.working") : t("ai.generateSummary")}
        </button>
        {detail.type === "view" && (
          <button
            className="icon-button"
            disabled={aiBusy}
            onClick={() => runAi(async () => {
              const res = await explainViewAi(detail.id);
              setAiExplanation(res.explanation);
              setAiMock(res.mock);
            })}
            data-testid="TableDetail-aiExplainButton"
          >
            {aiBusy ? t("ai.working") : t("ai.explainView")}
          </button>
        )}
      </div>

      <div className="mb-7 flex flex-wrap gap-3">
        <button
          className="btn-primary"
          onClick={onPreview}
          disabled={previewLoading || !previewAllowed}
          title={previewAllowed ? undefined : t("preview.notAllowedHint")}
          data-testid="TableDetail-previewButton"
        >
          {previewLoading ? t("detail.loading") : t("detail.preview")}
        </button>
        {!previewAllowed && (
          <span className="self-center text-xs" style={{ color: "var(--muted)" }}
                data-testid="TableDetail-previewNotAllowed">
            {t("preview.notAllowed")}
          </span>
        )}
        <button
          className="btn-secondary"
          onClick={onOpenErd}
          data-testid="TableDetail-erdButton"
        >
          {t("detail.openErd")}
        </button>
      </div>

      <div className="flex max-w-4xl flex-col gap-5">
        <section className="panel-section">
          <div className="panel-section__title flex items-center gap-1.5">
            {t("detail.columns")} ({detail.column_count})
            <InfoTip text={t("tip.columns")} />
          </div>
          {/* 감춘 스키마는 columns가 빈 배열로 온다 — 빈 상자만 두면 로딩 실패처럼 보인다 */}
          {detail.hidden && (
            <p className="text-xs" style={{ color: "var(--muted)" }}
               data-testid="TableDetail-columnsHidden">
              {t("hidden.columns")}
            </p>
          )}
          <div
            className="collapsible"
            style={{
              maxHeight: columnsExpanded ? columnsHeight : COLLAPSED_COLUMNS_HEIGHT,
            }}
            data-testid="TableDetail-columnsBox"
          >
            <div ref={columnsRef} className="flex flex-wrap gap-2">
              {detail.columns.map((column) => (
                <button
                  key={column.id}
                  className="pressable rounded-md border px-2.5 py-1 font-mono text-xs"
                  style={{
                    borderColor: column.is_join_key ? "var(--rel-confirmed)" : "var(--hairline-strong)",
                    color: column.is_join_key ? "var(--rel-confirmed)" : "var(--body-text)",
                  }}
                  title={`${column.data_type} — ${t("panel.verify")}`}
                  onClick={() => onOpenColumn(column.id, column.name)}
                  data-testid={`TableDetail-column-${column.id}`}
                >
                  {column.is_pk && <span className="pk-mark">PK</span>}{column.name}
                </button>
              ))}
            </div>
          </div>
          {columnsHeight > COLLAPSED_COLUMNS_HEIGHT && (
            <button
              className="pressable mt-2 rounded px-1 text-xs underline-offset-2 hover:underline"
              style={{ color: "var(--action-blue)" }}
              aria-expanded={columnsExpanded}
              onClick={() => setColumnsExpanded((current) => !current)}
              data-testid="TableDetail-columnsToggle"
            >
              {columnsExpanded ? t("detail.columnsFold") : t("detail.columnsMore")}
            </button>
          )}
        </section>

        {/* 조인 가능성 검증 — 타깃별 최고 페어 T2 일괄 실행 / table-level join check */}
        {detail.type === "table" && (
          <section className="panel-section" data-testid="TableDetail-joinCheck">
            <div className="mb-1 flex flex-wrap items-center gap-3">
              <div className="panel-section__title !mb-0 flex items-center gap-1.5">
                {t("joincheck.title")}
                <InfoTip text={t("tip.joinCheck")} />
              </div>
              <button
                className="btn-secondary !py-1 text-xs"
                disabled={checking}
                onClick={() => runCheck()}
                data-testid="TableDetail-joinCheckAllButton"
              >
                {checking
                  ? `${t("joincheck.running")} ${t("common.seconds").replace("{n}", String(checkElapsed))}`
                  : t("joincheck.checkAll")}
              </button>
              {checking && <div className="skeleton h-4 w-24" />}
            </div>
            <p className="mb-2 text-xs" style={{ color: "var(--muted)" }}>
              {t("joincheck.hint")}
            </p>
            {checkError && (
              <p className="text-sm" style={{ color: "var(--error)" }}
                 data-testid="TableDetail-joinCheckError">
                {checkError}
              </p>
            )}
            {checkResults !== null && checkResults.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                {t("joincheck.noTargets")}
              </p>
            )}
            {checkResults !== null && checkResults.length > 0 && (
              <ul className="space-y-1.5" data-testid="TableDetail-joinCheckResults">
                {checkResults.map((item) => (
                  <JoinCheckRow key={item.target_object} item={item}
                                onSelectTable={onSelectTable} onOpenColumn={onOpenColumn} />
                ))}
              </ul>
            )}
          </section>
        )}

        {/* 좁은 폭에선 1열로 — 깨짐 방지 / single column when narrow */}
        <div className="grid gap-5 md:grid-cols-2">
          {/* 뷰의 구성 테이블 — lineage 역추적 / base tables a view resolves to */}
          {detail.type === "view" && (
            <section className="panel-section" data-testid="TableDetail-baseTables">
              <div className="panel-section__title flex items-center gap-1.5">
                {t("detail.baseTables")} ({detail.base_tables.length})
                <InfoTip text={t("tip.baseTables")} />
              </div>
              {detail.base_tables.length === 0 && (
                <p className="text-sm" style={{ color: "var(--muted)" }}>{t("detail.none")}</p>
              )}
              <ul className="space-y-1.5">
                {detail.base_tables.map((base) => (
                  <li key={base.id} className="flex items-center gap-2 text-sm">
                    <span className="truncate text-xs">
                      <TableRef name={base.name} onSelect={onSelectTable} />
                    </span>
                    <span className="badge badge--muted">depth {base.min_depth}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel-section" data-testid="TableDetail-usingViews">
            <div className="panel-section__title flex items-center gap-1.5">
              {t("detail.usingViews")} ({detail.using_views.length})
              <InfoTip text={t("tip.usingViews")} />
            </div>
            {detail.using_views.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>{t("detail.none")}</p>
            )}
            <ul className="space-y-1.5">
              {detail.using_views.map((view) => (
                <li key={view.id} className="flex items-center gap-2 text-sm">
                  <span className="truncate text-xs">
                    <TableRef name={view.name} onSelect={onSelectTable} />
                  </span>
                  <span className="badge badge--muted">depth {view.min_depth}</span>
                </li>
              ))}
            </ul>
          </section>

          {detail.type === "table" && (
          <section className="panel-section" data-testid="TableDetail-similarTables">
            <div className="panel-section__title flex items-center gap-1.5">
              {t("detail.similar")}
              <InfoTip text={t("tip.similar")} align="left" />
            </div>
            {detail.similar_tables.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                {t("detail.noSimilar")}
              </p>
            )}
            <ul className="space-y-2.5">
              {detail.similar_tables.map((similar) => (
                <li key={similar.id} className="flex items-center gap-3 text-sm">
                  <span className="w-44 truncate text-xs">
                    <TableRef name={similar.name} onSelect={onSelectTable} />
                  </span>
                  <div className="rate-bar">
                    <div className="rate-bar__fill"
                         style={{ width: `${Math.round(similar.match_rate * 100)}%` }} />
                  </div>
                  <span className="w-10 text-right text-xs" style={{ color: "var(--slate)" }}>
                    {Math.round(similar.match_rate * 100)}%
                  </span>
                  {detail.type === "table" && (
                    <button
                      className="pressable rounded border px-1.5 py-0.5 text-[11px]"
                      style={{ borderColor: "var(--hairline-strong)", color: "var(--slate)" }}
                      disabled={checking}
                      title={t("joincheck.hint")}
                      onClick={() => runCheck(similar.id)}
                      data-testid={`TableDetail-joinCheckButton-${similar.id}`}
                    >
                      {t("joincheck.check")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
          )}

          {detail.type === "table" && (
          <section className="panel-section">
            <div className="panel-section__title flex items-center gap-1.5">
              {t("detail.fk")} ({t("detail.fkOut")} {detail.fk_out.length} · {t("detail.fkIn")} {detail.fk_in.length})
              <InfoTip text={t("tip.fk")} />
            </div>
            {detail.fk_out.length + detail.fk_in.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>{t("detail.noFk")}</p>
            )}
            <ul className="space-y-1 text-xs">
              {detail.fk_out.map((name) => (
                <li key={`out-${name}`} className="font-mono">
                  → <TableRef name={name} onSelect={onSelectTable} />
                </li>
              ))}
              {detail.fk_in.map((name) => (
                <li key={`in-${name}`} className="font-mono" style={{ color: "var(--slate)" }}>
                  ← <TableRef name={name} onSelect={onSelectTable} />
                </li>
              ))}
            </ul>
          </section>
          )}

          <section className="panel-section" data-testid="TableDetail-relations">
            <div className="panel-section__title flex items-center gap-1.5">
              {t("detail.relations")} ({detail.relations.length})
              <InfoTip text={t("tip.relations")} align="left" />
            </div>
            {detail.relations.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                {t("detail.noRelations")}
              </p>
            )}
            <ul className="space-y-1.5 text-xs">
              {detail.relations.map((relation, index) => (
                <li key={index} className="flex items-center gap-2">
                  <span className={`badge ${relation.status === "confirmed" ? "badge--confirmed" : "badge--muted"}`}>
                    {relation.status === "confirmed" ? "✓" : t("detail.inferred")}
                  </span>
                  <TableRef name={relation.other} onSelect={onSelectTable} />
                  {relation.cardinality === "N:M" && (
                    <span className="badge badge--muted">N:M</span>
                  )}
                  {relation.confidence !== null && (
                    <span style={{ color: "var(--muted)" }}>{relation.confidence}</span>
                  )}
                  {relation.reason && (
                    <span className="block truncate text-xs" style={{ color: "var(--muted)" }}
                          title={relation.reason}
                          data-testid={`TableDetail-relationReason-${index}`}>
                      {relation.reason}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
