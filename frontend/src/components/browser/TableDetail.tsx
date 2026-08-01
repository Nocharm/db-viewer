"use client";

/** 우측 테이블 정보 패널 — 사용 뷰·유사 테이블·관계 + 미리보기/ERD 액션. / table detail panel. */

import type { ObjectDetail, TablePreview } from "@/lib/api";

interface Props {
  detail: ObjectDetail | null;
  loading: boolean;
  preview: TablePreview | null;
  previewLoading: boolean;
  onPreview: () => void;
  onOpenErd: () => void;
}

export function TableDetail({
  detail, loading, preview, previewLoading, onPreview, onOpenErd,
}: Props) {
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center"
           data-testid="TableDetail-emptyState">
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {loading ? "불러오는 중…" : "왼쪽에서 테이블을 선택하세요"}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="TableDetail-root">
      <div className="scroll-area min-h-0 flex-1 p-4">
        {/* 헤더 */}
        <div className="mb-1 flex items-center gap-3">
          <h2 className="erd-node__header !border-0 !p-0">{detail.name}</h2>
          <span className="badge badge--muted">{detail.type === "view" ? "VIEW" : "TABLE"}</span>
          {detail.ai_summary && <span className="badge badge--ai">AI</span>}
        </div>
        <p className="mb-3 text-sm" style={{ color: "var(--slate)" }}>
          {detail.row_count !== null && `${detail.row_count.toLocaleString()} rows · `}
          {detail.column_count} columns
          {detail.ai_summary && <> — {detail.ai_summary}</>}
        </p>

        <div className="mb-4 flex gap-2">
          <button
            className="pressable rounded-full px-5 py-1.5 text-sm text-white"
            style={{ background: "var(--primary)" }}
            onClick={onPreview}
            disabled={previewLoading}
            data-testid="TableDetail-previewButton"
          >
            {previewLoading ? "조회 중…" : "미리보기 TOP 20"}
          </button>
          <button
            className="pressable rounded-full border px-5 py-1.5 text-sm"
            style={{ borderColor: "var(--primary)", color: "var(--primary)" }}
            onClick={onOpenErd}
            data-testid="TableDetail-erdButton"
          >
            ERD 보기 →
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <section className="panel-section col-span-2">
            <div className="panel-section__title">컬럼 ({detail.column_count})</div>
            <div className="flex flex-wrap gap-1.5">
              {detail.columns.map((column) => (
                <span
                  key={column.id}
                  className="rounded border px-2 py-0.5 font-mono text-xs"
                  style={{
                    borderColor: column.is_join_key ? "var(--rel-confirmed)" : "var(--border-light)",
                    color: column.is_join_key ? "var(--rel-confirmed)" : "var(--ink)",
                  }}
                  title={column.data_type}
                >
                  {column.is_pk ? "🔑 " : ""}{column.name}
                </span>
              ))}
            </div>
          </section>

          <section className="panel-section" data-testid="TableDetail-usingViews">
            <div className="panel-section__title">이 테이블을 사용하는 뷰 ({detail.using_views.length})</div>
            {detail.using_views.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>없음</p>
            )}
            <ul className="space-y-0.5">
              {detail.using_views.map((view) => (
                <li key={view.id} className="flex items-center gap-2 text-sm">
                  <span className="truncate font-mono text-xs">{view.name}</span>
                  <span className="badge badge--muted">depth {view.min_depth}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel-section" data-testid="TableDetail-similarTables">
            <div className="panel-section__title">유사 테이블 (컬럼명 일치율)</div>
            {detail.similar_tables.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>일치율 30% 이상 없음</p>
            )}
            <ul className="space-y-1.5">
              {detail.similar_tables.map((similar) => (
                <li key={similar.id} className="flex items-center gap-2 text-sm">
                  <span className="w-40 truncate font-mono text-xs">{similar.name}</span>
                  <div className="rate-bar">
                    <div className="rate-bar__fill"
                         style={{ width: `${Math.round(similar.match_rate * 100)}%` }} />
                  </div>
                  <span className="w-10 text-right text-xs" style={{ color: "var(--slate)" }}>
                    {Math.round(similar.match_rate * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel-section">
            <div className="panel-section__title">
              FK 관계 (참조 {detail.fk_out.length} · 피참조 {detail.fk_in.length})
            </div>
            {detail.fk_out.length + detail.fk_in.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>FK 없음</p>
            )}
            <ul className="space-y-0.5 text-xs">
              {detail.fk_out.map((name) => (
                <li key={`out-${name}`} className="font-mono">→ {name}</li>
              ))}
              {detail.fk_in.map((name) => (
                <li key={`in-${name}`} className="font-mono" style={{ color: "var(--slate)" }}>
                  ← {name}
                </li>
              ))}
            </ul>
          </section>

          <section className="panel-section" data-testid="TableDetail-relations">
            <div className="panel-section__title">추론·확정 관계 ({detail.relations.length})</div>
            {detail.relations.length === 0 && (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                검증된 관계 없음 — ERD에서 T2 검증으로 발견
              </p>
            )}
            <ul className="space-y-1 text-xs">
              {detail.relations.map((relation, index) => (
                <li key={index} className="flex items-center gap-1.5">
                  <span className={`badge ${relation.status === "confirmed" ? "badge--confirmed" : "badge--muted"}`}>
                    {relation.status === "confirmed" ? "✓" : "추정"}
                  </span>
                  <span className="truncate font-mono">{relation.other}</span>
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

      {preview && (
        <div
          className="shrink-0 border-t"
          style={{ borderColor: "var(--hairline)", maxHeight: "40%" }}
          data-testid="TableDetail-previewPane"
        >
          <div className="flex items-center gap-2 px-4 py-2">
            <span className="panel-section__title !mb-0">
              미리보기 — {preview.object} (TOP {preview.limit})
            </span>
            {preview.masked_columns.length > 0 && (
              <span className="badge badge--muted">마스킹 {preview.masked_columns.length}컬럼</span>
            )}
          </div>
          <div className="scroll-area h-full px-4 pb-10">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--hairline)" }}>
                  {preview.columns.map((column) => (
                    <th key={column} className="whitespace-nowrap py-1 pr-4 font-mono font-medium">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, index) => (
                  <tr key={index} className="border-b"
                      style={{ borderColor: "var(--card-border, #f2f2f2)" }}>
                    {preview.columns.map((column) => (
                      <td key={column} className="whitespace-nowrap py-1 pr-4">
                        {String(row[column] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
