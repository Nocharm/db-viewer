"use client";

/** 관리 비밀번호 잠금 바 — 탭마다 흩어져 있던 "수정 비밀번호" 입력을 한 곳으로. 상태 pill이
 * 잠김/열림을, 설명이 "무엇이 풀리는지"를 말한다. 값은 부모(관리 콘솔)가 쥔다.
 * One lock bar per tab: state pill + what it unlocks; the password lives in the page. */

import { LockIcon, LockOpenIcon } from "@/components/icons";

interface AdminLockBarProps {
  value: string;
  onChange: (value: string) => void;
  /** PREVIEW_ADMIN_PASSWORD가 서버에 설정돼 있는가 — 없으면 입력 대신 안내만 */
  configured: boolean;
  /** 이 탭에서 풀리는 조작 한 줄 */
  hint: string;
}

export function AdminLockBar({ value, onChange, configured, hint }: AdminLockBarProps) {
  // 입력만으로 "열림"이라 부른다 — 진짜 검증은 각 요청이 403으로 돌려준다
  const open = configured && value.length > 0;
  return (
    <div className="lock-bar" data-testid="AdminLockBar-root">
      {open ? <LockOpenIcon size={16} /> : <LockIcon size={16} />}
      <span className={`badge badge--plain ${open ? "badge--ok" : "badge--err"}`}
            data-testid="AdminLockBar-state">
        <span className="badge__dot" />{open ? "열림" : "잠김"}
      </span>
      <span className="lock-bar__desc">
        {configured
          ? hint
          : "PREVIEW_ADMIN_PASSWORD가 설정되지 않아 수정 기능이 잠겨 있습니다 — 서버 .env에 값을 넣고 백엔드를 재기동하세요."}
      </span>
      {configured && (
        <input
          className="ctl-field lock-bar__input"
          type="password"
          autoComplete="off"
          placeholder="관리 비밀번호 (.env PREVIEW_ADMIN_PASSWORD)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid="AdminLockBar-passwordInput"
        />
      )}
    </div>
  );
}
