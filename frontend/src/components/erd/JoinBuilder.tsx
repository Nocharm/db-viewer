"use client";

/** 조인 빌더 도크 — 스텝 목록 + 증상/처방 + 미리보기 진입.
 * The join draft dock: steps, verdicts and the preview entry point. */

import { useState } from "react";

import { CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import {
  getWorstVerdictIndex, PATTERN_LABELS,
  type JoinVerdict, type VerdictLevel,
} from "@/lib/join-verdict";
import type { JoinDraft, JoinStep, JoinType } from "@/lib/join-draft";
import type { MessageKey } from "@/lib/i18n";

interface Props {
  draft: JoinDraft;
  onRemoveStep: (index: number) => void;
  onSetJoinType: (index: number, joinType: JoinType) => void;
  onClear: () => void;
  onPreview: () => void;
  previewBusy: boolean;
}

const LEVEL_LABEL: Record<VerdictLevel, MessageKey> = {
  safe: "join.levelSafe",
  caution: "join.levelCaution",
  danger: "join.levelDanger",
  unknown: "join.levelUnknown",
};

const LEVEL_COLOR: Record<VerdictLevel, string> = {
  safe: "var(--rel-confirmed)",
  caution: "var(--stat-ink)",
  danger: "var(--error)",
  unknown: "var(--muted)",
};

function StepRow({
  step, index, onRemoveStep, onSetJoinType,
}: {
  step: JoinStep;
  index: number;
  onRemoveStep: (index: number) => void;
  onSetJoinType: (index: number, joinType: JoinType) => void;
}) {
  const { t } = useI18n();
  const [showNumbers, setShowNumbers] = useState(false);
  const level = step.verdict?.level ?? "unknown";

  return (
    <li className="py-1.5" data-testid={`JoinBuilder-step-${index}`}>
      <div className="flex items-center gap-2 font-mono text-xs">
        <span className="truncate">
          {step.left.qname}.{step.left.column}
        </span>
        <span style={{ color: "var(--muted)" }}>=</span>
        <span className="truncate">
          {step.right.qname}.{step.right.column}
        </span>
        <span className="badge badge--muted">{step.joinType.toUpperCase()}</span>
        <button
          className="icon-button ml-auto"
          title={t("join.removeStep")}
          onClick={() => onRemoveStep(index)}
          data-testid={`JoinBuilder-removeStep-${index}`}
        >
          <CloseIcon />
        </button>
      </div>

      {step.status === "verifying" && (
        <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}
           data-testid={`JoinBuilder-stepVerifying-${index}`}>
          {t("join.verifying")}
        </p>
      )}

      {step.verdict && (
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold" style={{ color: LEVEL_COLOR[level] }}
                data-testid={`JoinBuilder-stepLevel-${index}`}>
            {t(LEVEL_LABEL[level])}
          </span>
          <span style={{ color: "var(--body-text)" }}>{step.verdict.symptom}</span>
          {step.verdict.remedy && (
            <span style={{ color: "var(--slate)" }}>→ {step.verdict.remedy}</span>
          )}
          {/* 처방을 한 번에 적용 / apply the prescription in one click */}
          {step.verdict.remedy?.includes("LEFT JOIN") && step.joinType !== "left" && (
            <button
              className="btn-secondary !py-0.5 text-xs"
              onClick={() => onSetJoinType(index, "left")}
              data-testid={`JoinBuilder-applyLeftJoin-${index}`}
            >
              {t("join.applyLeftJoin")}
            </button>
          )}
          {step.result && (
            <button
              className="icon-button"
              onClick={() => setShowNumbers((current) => !current)}
              data-testid={`JoinBuilder-toggleNumbers-${index}`}
            >
              {showNumbers ? t("join.hideNumbers") : t("join.showNumbers")}
            </button>
          )}
        </div>
      )}

      {showNumbers && step.result && (
        <div className="mt-1 text-xs" style={{ color: "var(--slate)" }}
             data-testid={`JoinBuilder-numbers-${index}`}>
          <div>
            containment <b>{(step.result.containment * 100).toFixed(2)}%</b>
            {" · "}{step.result.cardinality}
            {" · "}고아 {step.result.orphan_count.toLocaleString()}
            {" · "}distinct {step.result.src_distinct.toLocaleString()}
          </div>
          <div>
            confidence {step.result.confidence ?? "—"} · 관측 {step.result.observations}회 ·{" "}
            {PATTERN_LABELS[step.result.pattern] ?? step.result.pattern}
          </div>
          <div style={{ color: "var(--muted)" }}>
            last verified {new Date(step.result.observed_at).toLocaleString()}
          </div>
        </div>
      )}
    </li>
  );
}

export function JoinBuilder({
  draft, onRemoveStep, onSetJoinType, onClear, onPreview, previewBusy,
}: Props) {
  const { t } = useI18n();
  // 타입 가드 없이 filter하면 (JoinVerdict|null)[]로 남는다 / narrow with a type predicate
  const verdicts = draft.steps
    .map((s) => s.verdict)
    .filter((v): v is JoinVerdict => v !== null);
  const worst = getWorstVerdictIndex(verdicts);
  const overall = worst >= 0 ? verdicts[worst] : null;

  return (
    <div
      className="scroll-area absolute bottom-3 left-1/2 z-20 max-h-[38%] w-[46rem] max-w-[92vw]
                 -translate-x-1/2 overflow-y-auto rounded-xl border p-3"
      style={{ borderColor: "var(--hairline-strong)", background: "var(--surface-card)" }}
      data-testid="JoinBuilder-root"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
          {t("join.title")}
        </span>
        {draft.steps.length > 0 && (
          <button className="icon-button ml-auto" onClick={onClear}
                  data-testid="JoinBuilder-clearButton">
            {t("join.clear")}
          </button>
        )}
      </div>

      {draft.steps.length === 0 && (
        <p className="text-xs" style={{ color: "var(--muted)" }}
           data-testid="JoinBuilder-emptyHint">
          {t("join.empty")}
        </p>
      )}

      {draft.steps.length > 0 && (
        <>
          <ul data-testid="JoinBuilder-stepList">
            {draft.steps.map((step, index) => (
              <StepRow
                key={`${step.left.columnId}-${step.right.columnId}`}
                step={step}
                index={index}
                onRemoveStep={onRemoveStep}
                onSetJoinType={onSetJoinType}
              />
            ))}
          </ul>

          <div className="mt-2 flex items-center gap-2 border-t pt-2"
               style={{ borderColor: "var(--hairline)" }}>
            {overall && (
              <span className="text-xs" data-testid="JoinBuilder-overallVerdict">
                <span className="font-semibold" style={{ color: LEVEL_COLOR[overall.level] }}>
                  {t("join.overall")} {t(LEVEL_LABEL[overall.level])}
                </span>
                {draft.steps.length > 1 && overall.level !== "safe" && (
                  <span style={{ color: "var(--slate)" }}>
                    {" · "}{t("join.weakestLink").replace("{n}", String(worst + 1))}
                  </span>
                )}
              </span>
            )}
            <button
              className="btn-primary ml-auto"
              disabled={previewBusy}
              onClick={onPreview}
              data-testid="JoinBuilder-previewButton"
            >
              {t("join.preview")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
