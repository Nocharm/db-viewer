"use client";

/** 좌측 검증 카드 — 1~4단계로 바로 이동하는 네비게이터.
 *
 * 선택(테이블·페어)이 끝나면 좌측 열은 할 일이 없어진다. 그 자리를 단계 이동에 내주면
 * 긴 중앙 열을 휠로 훑지 않고 원하는 단계로 바로 간다. 카드를 누르면 그 섹션으로
 * 스크롤하고 테두리를 한 번 깜빡여 어디로 갔는지 눈에 남긴다.
 * A step navigator: clicking a card scrolls to that section and flashes its border.
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
  /** 단계 번호(1~4)로 이동 / jump to a step section */
  onNavigate: (no: number) => void;
}

const STATE_COLOR: Record<VerifyStepState, string> = {
  done: "var(--rel-confirmed)",
  current: "var(--primary)",
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

export function VerifyStepNav({ states, onNavigate }: VerifyStepNavProps) {
  const { t } = useI18n();
  const icons = [
    <GateIcon key="1" size={14} />, <ContainmentIcon key="2" size={14} />,
    <SampleIcon key="3" size={14} />, <CheckIcon key="4" size={14} />,
  ];

  return (
    <section className="card p-3" data-testid="VerifyStepNav-root">
      <div className="mb-2 text-xs font-semibold uppercase tracking-widest"
           style={{ color: "var(--muted)" }}>
        {t("verify.nav.title")}
      </div>
      <ul className="flex flex-col gap-1.5">
        {states.map((state, index) => {
          const no = index + 1;
          const color = STATE_COLOR[state];
          return (
            <li key={no}>
              <button
                className="pressable flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left"
                style={{
                  borderColor: state === "current" ? color : "var(--hairline)",
                  background: state === "current"
                    ? `color-mix(in srgb, ${color} 8%, var(--surface-card))`
                    : "transparent",
                }}
                onClick={() => onNavigate(no)}
                data-testid={`VerifyStepNav-item-${no}`}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border"
                      style={{ borderColor: color, color }}>
                  {state === "done" ? <CheckIcon size={12} />
                    : state === "locked" ? <LockIcon size={11} /> : icons[index]}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-semibold"
                      style={{ color: "var(--ink)" }}>
                  {t(TITLE_KEYS[index])}
                </span>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider"
                      style={{ color }}
                      data-testid={`VerifyStepNav-state-${no}`}>
                  {t(STATE_LABEL[state])}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px]" style={{ color: "var(--muted)" }}>
        {t("verify.nav.hint")}
      </p>
    </section>
  );
}
