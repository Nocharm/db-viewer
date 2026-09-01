"use client";

/** 좌측 「진행 순서」 카드 — 1~4단계 설명 + 그 단계로 바로 이동.
 *
 * 흐름 설명과 이동 목록을 따로 그리면 같은 네 항목이 화면 두 곳에서 시선을 나눠 먹는다.
 * 그래서 설명(아이콘·한 줄·상태·잠김 사유)을 여기 한 카드에 모으고, 카드 자체가 해당
 * 섹션으로 가는 버튼이 된다. 선택 전에도 잠긴 상태로 보여 이 화면이 무엇을 하는지 먼저
 * 읽히게 한다.
 * One card carries both the explanation and the navigation for the four steps.
 */

import { useI18n } from "@/components/i18n";
import {
  CheckIcon, ContainmentIcon, GateIcon, LockIcon, SampleIcon,
} from "@/components/icons";
import type { MessageKey } from "@/lib/i18n";
import type { VerifyStepState } from "@/lib/verify-steps";

interface VerifyStepNavProps {
  /** 1~4단계 상태 / the four step states, in order */
  states: VerifyStepState[];
  /** 중앙에 단계 카드가 떠 있는가 — 아니면 이동할 곳이 없어 버튼을 잠근다 */
  navigable: boolean;
  /** 단계 번호(1~4)로 이동 / jump to a step section */
  onNavigate: (no: number) => void;
}

// 진행 중 색은 --primary(옐로)가 아니라 --action-blue — 옐로는 라이트 테마에서
// 흰 배경에 묻힌다(토큰 주석의 "옐로 텍스트는 흰 바탕에서 실독"과 같은 이유).
// / the active accent follows the per-theme action color; yellow washes out on light
const STATE_COLOR: Record<VerifyStepState, string> = {
  done: "var(--rel-confirmed)",
  current: "var(--action-blue)",
  locked: "var(--muted)",
  blocked: "var(--rel-unresolved)",
};

const STATE_LABEL: Record<VerifyStepState, MessageKey> = {
  done: "verify.flow.done",
  current: "verify.flow.current",
  locked: "verify.flow.locked",
  blocked: "verify.flow.blocked",
};

const TITLE_KEYS: MessageKey[] = [
  "verify.gate.title", "verify.containment.title",
  "verify.preview.title", "verify.confirm.title",
];

const DESC_KEYS: MessageKey[] = [
  "verify.step1.desc", "verify.step2.desc", "verify.step3.desc", "verify.step4.desc",
];

/** 잠긴 단계에만 붙는 사유 — 왜 아직 못 누르는지 / why a locked step is not actionable */
const LOCK_KEYS: (MessageKey | null)[] = [
  "verify.lock.needPair", "verify.lock.needGate", null, "verify.lock.needContainment",
];

export function VerifyStepNav({ states, navigable, onNavigate }: VerifyStepNavProps) {
  const { t } = useI18n();
  const icons = [
    <GateIcon key="1" size={15} />, <ContainmentIcon key="2" size={15} />,
    <SampleIcon key="3" size={15} />, <CheckIcon key="4" size={15} />,
  ];

  return (
    <section className="card p-3" data-testid="VerifyStepNav-root">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: "var(--muted)" }}>
          {t("verify.flow.title")}
        </span>
        <span className="text-[11px]" style={{ color: "var(--muted)" }}>
          {navigable ? t("verify.nav.hint") : t("verify.flow.needTables")}
        </span>
      </div>

      <ol className="flex flex-col gap-2">
        {states.map((state, index) => {
          const no = index + 1;
          const color = STATE_COLOR[state];
          const lockKey = state === "locked" ? LOCK_KEYS[index] : null;
          return (
            <li key={no}>
              <button
                className="pressable flex w-full gap-2.5 rounded-lg border p-2.5 text-left disabled:cursor-default"
                style={{
                  borderColor: state === "current" ? color : "var(--hairline)",
                  background: state === "current"
                    ? `color-mix(in srgb, ${color} 8%, var(--surface-card))`
                    : "transparent",
                  opacity: state === "locked" ? 0.75 : 1,
                }}
                disabled={!navigable}
                onClick={() => onNavigate(no)}
                data-testid={`VerifyStepNav-item-${no}`}
              >
                <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border"
                      style={{
                        borderColor: color, color,
                        background: state === "locked"
                          ? "transparent"
                          : `color-mix(in srgb, ${color} 14%, var(--surface-card))`,
                      }}>
                  {state === "done" ? <CheckIcon size={15} />
                    : state === "locked" ? <LockIcon size={13} /> : icons[index]}
                  <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold"
                        style={{ background: color, color: "var(--surface-card)" }}>
                    {no}
                  </span>
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      {t(TITLE_KEYS[index])}
                    </span>
                    {index === 2 && (
                      <span className="badge badge--muted !py-0 text-[10px]">
                        {t("verify.flow.optional")}
                      </span>
                    )}
                    <span className="text-[10px] font-semibold uppercase tracking-wider"
                          style={{ color }}
                          data-testid={`VerifyStepNav-state-${no}`}>
                      {t(STATE_LABEL[state])}
                    </span>
                  </span>
                  <span className="mt-1 block text-xs leading-snug" style={{ color: "var(--slate)" }}>
                    {t(DESC_KEYS[index])}
                  </span>
                  {lockKey && (
                    <span className="mt-1 block text-[11px]" style={{ color: "var(--muted)" }}
                          data-testid={`VerifyStepNav-note-${no}`}>
                      {t(lockKey)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
