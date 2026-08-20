"use client";

/** 단계 카드 공통 헤더 — 번호 뱃지 + 아이콘 + 제목 + 한 줄 설명 + 실행 버튼 자리.
 *
 * 네 카드가 같은 문법으로 보이게 한 곳에 모은다: 왼쪽 뱃지에서 몇 번째 단계인지,
 * 제목 옆에서 지금 눌러야 할 버튼이 무엇인지, 그 아래 한 줄에서 이 단계가 무엇을
 * 하는지가 한 번에 읽힌다. 잠긴 카드는 이유(lockNote)를 설명 대신 보여준다.
 * One header grammar for all four step cards: number, title, action, explanation.
 */

import { useI18n } from "@/components/i18n";
import { LockIcon } from "@/components/icons";

interface StepCardHeaderProps {
  no: number;
  icon: React.ReactNode;
  title: string;
  desc: string;
  /** 잠김 사유 — 있으면 잠금 아이콘과 함께 설명 자리를 대신한다 */
  lockNote?: string | null;
  done?: boolean;
  /** 실행 버튼 등 — 제목 옆에 붙는다 / action buttons sit next to the title */
  children?: React.ReactNode;
}

export function StepCardHeader({
  no, icon, title, desc, lockNote = null, done = false, children,
}: StepCardHeaderProps) {
  const { t } = useI18n();
  // 진행 중 색은 --action-blue — 옐로(--primary)는 라이트 테마의 흰 배경에서 묻힌다
  const color = lockNote ? "var(--muted)" : done ? "var(--rel-confirmed)" : "var(--action-blue)";

  return (
    <div className="mb-3 flex items-start gap-2.5" data-testid={`StepCardHeader-${no}`}>
      <span
        className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border"
        style={{
          borderColor: color, color,
          background: lockNote
            ? "transparent"
            : `color-mix(in srgb, ${color} 14%, var(--surface-card))`,
        }}
      >
        {icon}
        <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold"
              style={{ background: color, color: "var(--surface-card)" }}>
          {no}
        </span>
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
            {title}
          </span>
          {children}
          {done && (
            <span className="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: "var(--rel-confirmed)" }}>
              {t("verify.flow.done")}
            </span>
          )}
        </div>
        {lockNote ? (
          <p className="mt-1 flex items-center gap-1 text-xs" style={{ color: "var(--muted)" }}
             data-testid={`StepCardHeader-lockNote-${no}`}>
            <LockIcon size={11} />
            {lockNote}
          </p>
        ) : (
          <p className="mt-1 text-xs leading-snug" style={{ color: "var(--slate)" }}>
            {desc}
          </p>
        )}
      </div>
    </div>
  );
}
