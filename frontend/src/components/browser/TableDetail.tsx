"use client";

/** 우측 테이블 정보 패널 — 사용 뷰·유사 테이블·관계·조인 검증. / table detail panel. */

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import { runJoinCheck, type JoinCheckItem, type ObjectDetail } from "@/lib/api";

interface Props {
  detail: ObjectDetail | null;
  loading: boolean;
  previewLoading: boolean;
  onPreview: () => void;
  onOpenErd: () => void;
  /** 상세 안의 테이블명 클릭 → 해당 테이블 선택 / click-through to another table */
  onSelectTable: (qname: string) => void;
  /** 컬럼 칩 클릭 → ERD 조인 검증 패널로 이동 / open the join-validation panel in the ERD */
  onOpenColumn: (columnId: number, columnName: string) => void;
}

/** 클릭 가능한 테이블명 / clickable table reference. */
function TableRef({ name, onSelect }: { name: string; onSelect: (qname: string) => void }) {
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
function JoinCheckRow({ item, onSelectTable }: {
  item: JoinCheckItem;
  onSelectTable: (qname: string) => void;
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
    </li>
  );
}

export function TableDetail({
  detail, loading, previewLoading, onPreview, onOpenErd, onSelectTable, onOpenColumn,
}: Props) {
  const { t } = useI18n();
  const [checkResults, setCheckResults] = useState<JoinCheckItem[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  // 테이블 전환 시 검증 결과 초기화 / reset results when the table changes
  useEffect(() => {
    setCheckResults(null);
    setChecking(false);
    setCheckError(null);
  }, [detail?.id]);

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
      <div className="mb-2 flex items-baseline gap-3">
        <h2 className="font-mono text-2xl font-bold tracking-tight"
            style={{ color: "var(--ink)" }}>
          {detail.name}
        </h2>
        <span className="badge badge--muted">{detail.type === "view" ? "VIEW" : "TABLE"}</span>
        {detail.ai_summary && <span className="badge badge--ai">AI</span>}
      </div>
      <p className="mb-2 text-sm" style={{ color: "var(--slate)" }}>
        {detail.row_count !== null && `${detail.row_count.toLocaleString()} rows · `}
        {detail.column_count} columns
      </p>
      {detail.ai_summary && (
        <p className="mb-5 max-w-2xl text-sm leading-relaxed"
           style={{ color: "var(--slate)" }}>
          {detail.ai_summary}
        </p>
      )}

      <div className="mb-7 flex gap-3">
        <button
          className="btn-primary"
          onClick={onPreview}
          disabled={previewLoading}
          data-testid="TableDetail-previewButton"
        >
          {previewLoading ? t("detail.loading") : t("detail.preview")}
        </button>
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
          <div className="panel-section__title">
            {t("detail.columns")} ({detail.column_count}) — {t("detail.columnsHint")}
          </div>
          <div className="flex flex-wrap gap-2">
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
                {column.is_pk ? "🔑 " : ""}{column.name}
              </button>
            ))}
          </div>
        </section>

        {/* 조인 가능성 검증 — 타깃별 최고 페어 T2 일괄 실행 / table-level join check */}
        {detail.type === "table" && (
          <section className="panel-section" data-testid="TableDetail-joinCheck">
            <div className="mb-1 flex items-center gap-3">
              <div className="panel-section__title !mb-0">{t("joincheck.title")}</div>
              <button
                className="btn-secondary !py-1 text-xs"
                disabled={checking}
                onClick={() => runCheck()}
                data-testid="TableDetail-joinCheckAllButton"
              >
                {checking ? t("joincheck.running") : t("joincheck.checkAll")}
              </button>
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
                                onSelectTable={onSelectTable} />
                ))}
              </ul>
            )}
          </section>
        )}

        <div className="grid grid-cols-2 gap-5">
          <section className="panel-section" data-testid="TableDetail-usingViews">
            <div className="panel-section__title">
              {t("detail.usingViews")} ({detail.using_views.length})
            </div>
            {detail.using_views.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>{t("detail.none")}</p>
            )}
            <ul className="space-y-1.5">
              {detail.using_views.map((view) => (
                <li key={view.id} className="flex items-center gap-2 text-sm">
                  <span className="truncate font-mono text-xs">{view.name}</span>
                  <span className="badge badge--muted">depth {view.min_depth}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel-section" data-testid="TableDetail-similarTables">
            <div className="panel-section__title">{t("detail.similar")}</div>
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

          <section className="panel-section">
            <div className="panel-section__title">
              {t("detail.fk")} ({t("detail.fkOut")} {detail.fk_out.length} · {t("detail.fkIn")} {detail.fk_in.length})
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

          <section className="panel-section" data-testid="TableDetail-relations">
            <div className="panel-section__title">{t("detail.relations")} ({detail.relations.length})</div>
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
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
