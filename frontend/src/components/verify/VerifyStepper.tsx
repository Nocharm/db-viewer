"use client";

/** 검증 흐름 다이어그램 — 지금 검증 중인 관계 + 1~4단계의 상태·설명.
 *
 * 처음 보는 사람이 "무엇을, 왜, 어떤 순서로" 누르는지 화면만 보고 알 수 있게 한다:
 * 위쪽은 지금 검증 중인 페어를 그림으로, 아래쪽은 네 단계를 아이콘·한 줄 설명과 함께
 * 완료/진행/잠김으로 칠한다. 잠긴 단계는 이유를 같이 적는다.
 * A flow diagram: the pair under test on top, then the four steps with icons,
 * one-line descriptions and done/current/locked states (locks say why).
 */

import { useI18n } from "@/components/i18n";
import type { MessageKey } from "@/lib/i18n";
import {
  ArrowRightIcon, CheckIcon, ContainmentIcon, GateIcon, LockIcon, SampleIcon,
} from "@/components/icons";
import type { PairCandidate } from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";
import { canConfirm, canRunContainment, type VerifyState } from "@/lib/verify-flow";

type StepState = "done" | "current" | "locked" | "blocked";

interface StepView {
  no: number;
  icon: React.ReactNode;
  title: string;
  desc: string;
  state: StepState;
  /** 잠김·차단 사유 — 왜 아직 못 누르는지 / why this step is not actionable yet */
  note: string | null;
  optional?: boolean;
}

interface VerifyStepperProps {
  src: ObjectSummary | null;
  tgt: ObjectSummary | null;
  pair: PairCandidate | null;
  state: VerifyState;
  /** 3단계 샘플을 실제로 불러왔는지 — 선택 단계라 흐름을 막지는 않는다 */
  sampleSeen: boolean;
}

const STATE_LABEL: Record<StepState, MessageKey> = {
  done: "verify.flow.done",
  current: "verify.flow.current",
  locked: "verify.flow.locked",
  blocked: "verify.flow.blocked",
};

const STATE_COLOR: Record<StepState, string> = {
  done: "var(--rel-confirmed)",
  current: "var(--primary)",
  locked: "var(--muted)",
  blocked: "var(--rel-unresolved)",
};

function StepBadge({ state, no, icon }: { state: StepState; no: number; icon: React.ReactNode }) {
  const color = STATE_COLOR[state];
  return (
    <span
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border"
      style={{
        borderColor: color,
        color,
        background: state === "locked"
          ? "transparent"
          : `color-mix(in srgb, ${color} 14%, var(--surface-card))`,
      }}
    >
      {state === "done" ? <CheckIcon size={16} /> : state === "locked" ? <LockIcon size={14} /> : icon}
      <span
        className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold"
        style={{ background: color, color: "var(--surface-card)" }}
      >
        {no}
      </span>
    </span>
  );
}

/** 지금 검증 중인 관계 — 출발/대상 상자와 그 사이의 판정 / the pair under test. */
function JoinDiagram({ src, tgt, pair, state }: Omit<VerifyStepperProps, "sampleSeen">) {
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
    <div className="mb-3" data-testid="VerifyStepper-diagram">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest"
           style={{ color: "var(--muted)" }}>
        {t("verify.diagram.title")}
      </div>
      <div className="flex items-center gap-2">
        {box(src, pair?.src_column ?? null, "VerifyStepper-srcBox")}
        <div className="flex shrink-0 flex-col items-center" style={{ color: edgeColor }}>
          <ArrowRightIcon size={18} />
          <span className="mt-0.5 font-mono text-[10px] tabular-nums">
            {containment
              ? `${(containment.containment * 100).toFixed(0)}% · ${containment.cardinality}`
              : "?"}
          </span>
        </div>
        {box(tgt, pair?.tgt_column ?? null, "VerifyStepper-tgtBox")}
      </div>
    </div>
  );
}

export function VerifyStepper({ src, tgt, pair, state, sampleSeen }: VerifyStepperProps) {
  const { t } = useI18n();
  const hasPair = pair !== null && src !== null && tgt !== null;
  const gate = state.gate;

  const gateState: StepState = !hasPair
    ? "locked"
    : gate?.verdict === "pass" ? "done" : gate ? "blocked" : "current";
  const containmentState: StepState = !canRunContainment(state)
    ? "locked"
    : state.containment ? "done" : "current";
  const sampleState: StepState = !state.containment
    ? "locked"
    : sampleSeen ? "done" : "current";
  const confirmState: StepState = state.step === "confirmed"
    ? "done"
    : canConfirm(state) ? "current" : "locked";

  const steps: StepView[] = [
    {
      no: 1, icon: <GateIcon size={16} />, title: t("verify.gate.title"),
      desc: t("verify.step1.desc"), state: gateState,
      note: gateState === "locked" ? t("verify.lock.needPair") : null,
    },
    {
      no: 2, icon: <ContainmentIcon size={16} />, title: t("verify.containment.title"),
      desc: t("verify.step2.desc"), state: containmentState,
      note: containmentState === "locked" ? t("verify.lock.needGate") : null,
    },
    {
      no: 3, icon: <SampleIcon size={16} />, title: t("verify.preview.title"),
      desc: t("verify.step3.desc"), state: sampleState, optional: true,
      note: null,
    },
    {
      no: 4, icon: <CheckIcon size={16} />, title: t("verify.confirm.title"),
      desc: t("verify.step4.desc"), state: confirmState,
      note: confirmState === "locked" ? t("verify.lock.needContainment") : null,
    },
  ];

  return (
    <section className="card p-4" data-testid="VerifyStepper-root">
      <JoinDiagram src={src} tgt={tgt} pair={pair} state={state} />

      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: "var(--muted)" }}>
          {t("verify.flow.title")}
        </span>
        {!hasPair && (
          <span className="text-xs" style={{ color: "var(--muted)" }}
                data-testid="VerifyStepper-needTables">
            {t("verify.flow.needTables")}
          </span>
        )}
      </div>

      {/* 2×2 그리드 — 중앙 열 폭(≈900px)에서 4열은 한국어 설명이 서너 글자마다 끊긴다
          / two columns: at the center column's width four would shred the sentences */}
      <ol className="grid gap-2 sm:grid-cols-2">
        {steps.map((step) => (
          <li
            key={step.no}
            className="flex gap-2.5 rounded-lg border p-2.5"
            style={{
              borderColor: step.state === "current"
                ? "var(--primary)" : "var(--hairline)",
              background: step.state === "current"
                ? "color-mix(in srgb, var(--primary) 7%, var(--surface-card))"
                : "var(--surface-card)",
              opacity: step.state === "locked" ? 0.6 : 1,
            }}
            data-testid={`VerifyStepper-step-${step.no}`}
          >
            <StepBadge state={step.state} no={step.no} icon={step.icon} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                  {step.title}
                </span>
                {step.optional && (
                  <span className="badge badge--muted !py-0 text-[10px]">
                    {t("verify.flow.optional")}
                  </span>
                )}
                <span className="text-[10px] font-semibold uppercase tracking-wider"
                      style={{ color: STATE_COLOR[step.state] }}
                      data-testid={`VerifyStepper-state-${step.no}`}>
                  {t(STATE_LABEL[step.state])}
                </span>
              </div>
              <p className="mt-1 text-xs leading-snug" style={{ color: "var(--slate)" }}>
                {step.desc}
              </p>
              {step.note && (
                <p className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}
                   data-testid={`VerifyStepper-note-${step.no}`}>
                  {step.note}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
