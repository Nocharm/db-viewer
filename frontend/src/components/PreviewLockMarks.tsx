"use client";

/** 미리보기 잠금 상태 아이콘 — 허용은 풀린 자물쇠(그린), 미허용은 잠긴 자물쇠(무채색).
 * 카테고리처럼 여러 DB가 혼재하면 둘 다 켜서 나란히 띄운다.
 * / preview-lock markers: open lock for allowed, closed for locked, both when a
 *   category mixes allowed and locked schemas. */

import { LockIcon, LockOpenIcon } from "@/components/icons";

interface PreviewLockMarksProps {
  hasAllowed: boolean;
  hasLocked: boolean;
  allowedTitle: string;
  lockedTitle: string;
  /** `${prefix}-openLock` / `${prefix}-lock` 로 식별 / testid prefix per row */
  testidPrefix: string;
}

export function PreviewLockMarks({
  hasAllowed, hasLocked, allowedTitle, lockedTitle, testidPrefix,
}: PreviewLockMarksProps) {
  return (
    <>
      {hasAllowed && (
        // 색은 보조 인코딩 — 1차 구분은 고리가 열린 형태 / color is secondary to the shape
        <span title={allowedTitle} style={{ color: "var(--rel-confirmed)" }}
              data-testid={`${testidPrefix}-openLock`}>
          <LockOpenIcon size={12} />
        </span>
      )}
      {hasLocked && (
        <span title={lockedTitle} style={{ color: "var(--muted)" }}
              data-testid={`${testidPrefix}-lock`}>
          <LockIcon size={12} />
        </span>
      )}
    </>
  );
}
