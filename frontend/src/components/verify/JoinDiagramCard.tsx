"use client";

/** 지금 확인 중인 연결 — 출발/대상 컬럼 상자와 그 사이의 판정.
 *
 * 중앙 열의 맨 위에서 "지금 무엇을 검증하는 중인가"만 한 눈에 보여준다. 단계 목록은
 * 좌측 「진행 순서」 카드가 맡는다 — 둘 다 그리면 같은 정보가 시선을 나눠 먹는다.
 * The pair under test; the step list lives in the left-hand flow card, not here.
 */

import { useI18n } from "@/components/i18n";
import { ArrowRightIcon } from "@/components/icons";
import type { PairCandidate } from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";
import type { VerifyState } from "@/lib/verify-flow";

interface JoinDiagramCardProps {
  src: ObjectSummary | null;
  tgt: ObjectSummary | null;
  pair: PairCandidate | null;
  state: VerifyState;
}

export function JoinDiagramCard({ src, tgt, pair, state }: JoinDiagramCardProps) {
  const { t } = useI18n();
  const containment = state.containment;
  const edgeColor = containment
    ? (containment.containment >= 0.99 ? "var(--rel-confirmed)" : "var(--stat-ink)")
    : "var(--hairline-strong)";

  const box = (obj: ObjectSummary | null, column: string | null, testid: string) => (
    <div className="min-w-0 flex-1 rounded-lg border px-3 py-2"
         style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-elevated)" }}
         data-testid={testid}>
      <div className="truncate font-mono text-xs" style={{ color: "var(--muted)" }}>
        {obj ? `${obj.schema}.${obj.name}` : "—"}
      </div>
      <div className="truncate font-mono text-sm font-semibold" style={{ color: "var(--ink)" }}>
        {column ?? t("verify.diagram.pickPair")}
      </div>
    </div>
  );

  return (
    <section className="card p-4" data-testid="JoinDiagramCard-root">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest"
           style={{ color: "var(--muted)" }}>
        {t("verify.diagram.title")}
      </div>
      <div className="flex items-center gap-2">
        {box(src, pair?.src_column ?? null, "JoinDiagramCard-srcBox")}
        <div className="flex shrink-0 flex-col items-center" style={{ color: edgeColor }}>
          <ArrowRightIcon size={18} />
          <span className="mt-0.5 font-mono text-[10px] tabular-nums">
            {containment
              ? `${(containment.containment * 100).toFixed(0)}% · ${containment.cardinality}`
              : "?"}
          </span>
        </div>
        {box(tgt, pair?.tgt_column ?? null, "JoinDiagramCard-tgtBox")}
      </div>
    </section>
  );
}
