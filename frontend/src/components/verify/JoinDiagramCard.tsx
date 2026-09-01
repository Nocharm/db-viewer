"use client";

/** 지금 확인 중인 연결 — 출발/대상 컬럼 상자, 컬럼 교체, 값 미리보기 진입.
 *
 * 중앙 열 맨 위에서 "무엇을 검증 중인가"를 보여주고, 그 자리에서 컬럼을 바로 바꾼다
 * (좌측 후보 목록까지 내려가지 않아도 된다). 우상단 「값 미리보기」는 아래 미리보기
 * 섹션을 열어 양쪽 테이블을 분할로 띄우고 현재 컬럼을 강조한다.
 * The pair under test, with inline column swapping and an entry point to the preview.
 */

import { useI18n } from "@/components/i18n";
import { ArrowRightIcon, SampleIcon } from "@/components/icons";
import type { ObjectDetail, PairCandidate } from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";
import type { VerifyState } from "@/lib/verify-flow";

type DetailColumn = ObjectDetail["columns"][number];

interface JoinDiagramCardProps {
  src: ObjectSummary | null;
  tgt: ObjectSummary | null;
  pair: PairCandidate | null;
  state: VerifyState;
  /** 컬럼 교체용 목록 — 후보 목록이 받아온 것을 그대로 쓴다(중복 조회 없음) */
  srcColumns: DetailColumn[];
  tgtColumns: DetailColumn[];
  onChangeColumn: (side: "src" | "tgt", columnId: number | null) => void;
  /** 미리보기 허용 스키마인가 — 아니면 버튼을 잠그고 이유를 툴팁으로 */
  previewAllowed: boolean;
  onPreview: () => void;
}

export function JoinDiagramCard({
  src, tgt, pair, state, srcColumns, tgtColumns, onChangeColumn,
  previewAllowed, onPreview,
}: JoinDiagramCardProps) {
  const { t } = useI18n();
  const containment = state.containment;
  const edgeColor = containment
    ? (containment.containment >= 0.99 ? "var(--rel-confirmed)" : "var(--stat-ink)")
    : "var(--hairline-strong)";
  const ready = src !== null && tgt !== null && pair !== null;

  const box = (
    obj: ObjectSummary | null,
    columns: DetailColumn[],
    selectedId: number | null,
    side: "src" | "tgt",
  ) => (
    <div className="min-w-0 flex-1 rounded-lg border px-3 py-2"
         style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-elevated)" }}
         data-testid={`JoinDiagramCard-${side}Box`}>
      <div className="truncate font-mono text-xs" style={{ color: "var(--muted)" }}>
        {obj ? `${obj.schema}.${obj.name}` : "—"}
      </div>
      {/* 컬럼은 셀렉트 — 여기서 바로 바꾸면 페어가 갈리고 미리보기 강조도 따라간다 */}
      <select
        className="mt-0.5 w-full rounded border bg-transparent px-1.5 py-1 font-mono text-sm font-semibold outline-none focus:border-[var(--focus-blue)] disabled:opacity-45"
        style={{ borderColor: "var(--hairline)", color: "var(--ink)" }}
        value={selectedId ?? ""}
        disabled={obj === null || columns.length === 0}
        onChange={(e) => onChangeColumn(side, e.target.value ? Number(e.target.value) : null)}
        data-testid={`JoinDiagramCard-${side}ColumnSelect`}
      >
        <option value="">{t("verify.diagram.pickPair")}</option>
        {columns.map((column) => (
          <option key={column.id} value={column.id}>
            {column.name} · {column.data_type}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <section className="card p-4" data-testid="JoinDiagramCard-root">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest"
              style={{ color: "var(--muted)" }}>
          {t("verify.diagram.title")}
        </span>
        {/* 우상단 — 테이블·컬럼이 다 정해졌을 때만 연다 */}
        <button
          className="icon-button ml-auto"
          disabled={!ready || !previewAllowed}
          title={previewAllowed ? undefined : t("verify.preview.notAllowed")}
          onClick={onPreview}
          data-testid="JoinDiagramCard-previewButton"
        >
          <SampleIcon size={11} className="mr-1 inline-block align-middle" />
          {t("verify.diagram.previewValues")}
        </button>
      </div>

      <div className="flex items-center gap-2">
        {box(src, srcColumns, pair?.src_column_id ?? null, "src")}
        <div className="flex shrink-0 flex-col items-center" style={{ color: edgeColor }}>
          <ArrowRightIcon size={18} />
          <span className="mt-0.5 font-mono text-[10px] tabular-nums">
            {containment
              ? `${(containment.containment * 100).toFixed(0)}% · ${containment.cardinality}`
              : "?"}
          </span>
        </div>
        {box(tgt, tgtColumns, pair?.tgt_column_id ?? null, "tgt")}
      </div>
    </section>
  );
}
