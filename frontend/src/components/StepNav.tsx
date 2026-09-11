"use client";

/** 좌측 「진행 순서」 카드의 공용 렌더 — 번호·아이콘·상태·한 줄 설명·잠김 사유를 한 항목에
 * 모으고, 항목 자체가 그 단계 카드로 가는 버튼이 된다. 조인 검증(/verify)과 값 추적(/trace)이
 * 같은 문법을 쓴다 — 두 화면이 각자 그리면 색·간격이 어긋난다.
 * The shared side navigator: one card carries both explanation and navigation. */

import type { ReactNode } from "react";

import { useI18n } from "@/components/i18n";
import { CheckIcon, LockIcon } from "@/components/icons";
import type { MessageKey } from "@/lib/i18n";

export type StepState = "done" | "current" | "locked" | "blocked";

export interface StepNavItem {
  title: string;
  desc: string;
  icon: ReactNode;
  /** 건너뛰어도 되는 단계 — 제목 옆 「선택」 배지 / optional-step badge */
  optional?: boolean;
  /** 잠긴 동안에만 보이는 사유 / shown only while the step is locked */
  lockNote?: string | null;
}

interface StepNavProps {
  items: StepNavItem[];
  /** items와 같은 순서의 단계 상태 / one state per item, in order */
  states: StepState[];
  /** 머리말 옆 한 줄 — 이동 방법 또는 시작 조건 / the one-liner next to the heading */
  hint: string;
  /** 중앙에 이동할 카드가 있는가 — 아니면 버튼을 잠근다 / whether there is anywhere to jump */
  navigable: boolean;
  /** 단계 번호(1부터)로 이동 / jump to a step section */
  onNavigate: (no: number) => void;
  /** data-testid 접두 — 화면마다 다르게 두어 실측 스크립트가 구분한다 / per-screen test-id prefix */
  testIdPrefix: string;
}

// 진행 중 색은 --primary(옐로)가 아니라 --action-blue — 옐로는 라이트 테마에서
// 흰 배경에 묻힌다(토큰 주석의 "옐로 텍스트는 흰 바탕에서 실독"과 같은 이유).
// / the active accent follows the per-theme action color; yellow washes out on light
const STATE_COLOR: Record<StepState, string> = {
  done: "var(--rel-confirmed)",
  current: "var(--action-blue)",
  locked: "var(--muted)",
  blocked: "var(--rel-unresolved)",
};

const STATE_LABEL: Record<StepState, MessageKey> = {
  done: "verify.flow.done",
  current: "verify.flow.current",
  locked: "verify.flow.locked",
  blocked: "verify.flow.blocked",
};

export function StepNav({
  items, states, hint, navigable, onNavigate, testIdPrefix,
}: StepNavProps) {
  const { t } = useI18n();

  return (
    <section className="card p-3" data-testid={`${testIdPrefix}-root`}>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: "var(--muted)" }}>
          {t("verify.flow.title")}
        </span>
        <span className="text-[11px]" style={{ color: "var(--muted)" }}>{hint}</span>
      </div>

      <ol className="flex flex-col gap-2">
        {items.map((item, index) => {
          const no = index + 1;
          const state = states[index] ?? "locked";
          const color = STATE_COLOR[state];
          const lockNote = state === "locked" ? item.lockNote ?? null : null;
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
                data-testid={`${testIdPrefix}-item-${no}`}
              >
                <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border"
                      style={{
                        borderColor: color, color,
                        background: state === "locked"
                          ? "transparent"
                          : `color-mix(in srgb, ${color} 14%, var(--surface-card))`,
                      }}>
                  {state === "done" ? <CheckIcon size={15} />
                    : state === "locked" ? <LockIcon size={13} /> : item.icon}
                  <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold"
                        style={{ background: color, color: "var(--surface-card)" }}>
                    {no}
                  </span>
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      {item.title}
                    </span>
                    {item.optional && (
                      <span className="badge badge--muted !py-0 text-[10px]">
                        {t("verify.flow.optional")}
                      </span>
                    )}
                    <span className="text-[10px] font-semibold uppercase tracking-wider"
                          style={{ color }}
                          data-testid={`${testIdPrefix}-state-${no}`}>
                      {t(STATE_LABEL[state])}
                    </span>
                  </span>
                  <span className="mt-1 block text-xs leading-snug" style={{ color: "var(--slate)" }}>
                    {item.desc}
                  </span>
                  {lockNote && (
                    <span className="mt-1 block text-[11px]" style={{ color: "var(--muted)" }}
                          data-testid={`${testIdPrefix}-note-${no}`}>
                      {lockNote}
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
