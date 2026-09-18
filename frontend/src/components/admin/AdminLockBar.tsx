"use client";

/** 관리 비밀번호 잠금 바 — 탭마다 흩어져 있던 "수정 비밀번호" 입력을 한 곳으로. 상태 pill이
 * 잠김/열림을, 설명이 "무엇이 풀리는지"를 말한다. 값(검증된 비밀번호)은 부모(관리 콘솔)가 쥔다.
 * 입력창은 자물쇠를 눌렀을 때만 나온다 — 평소엔 비밀번호 칸이 화면을 차지하지 않고,
 * 「열림」은 서버 검증을 통과한 뒤에만 뜬다(예전엔 글자만 있으면 열림이었다).
 * One lock bar per tab: the input appears on demand, "unlocked" only after a server check. */

import { useEffect, useRef, useState } from "react";

import { useI18n } from "@/components/i18n";
import { LockIcon, LockOpenIcon } from "@/components/icons";
import { verifyAdminPassword } from "@/lib/api";

interface AdminLockBarProps {
  /** 검증된 비밀번호 — 비어 있으면 잠김 / verified password, empty means locked */
  value: string;
  onChange: (value: string) => void;
  /** PREVIEW_ADMIN_PASSWORD가 서버에 설정돼 있는가 — 없으면 입력 대신 안내만 */
  configured: boolean;
  /** 이 탭에서 풀리는 조작 한 줄 */
  hint: string;
}

export function AdminLockBar({ value, onChange, configured, hint }: AdminLockBarProps) {
  const { t } = useI18n();
  const open = configured && value.length > 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const cancel = () => {
    setEditing(false);
    setDraft("");
    setError(null);
  };

  const submit = () => {
    if (!draft || checking) return;
    setChecking(true);
    setError(null);
    verifyAdminPassword(draft)
      .then((res) => {
        if (res.ok) {
          onChange(draft);
          cancel();
        } else {
          setError(t("lock.wrong"));
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setChecking(false));
  };

  return (
    <div className="lock-bar" data-testid="AdminLockBar-root">
      {open ? <LockOpenIcon size={16} /> : <LockIcon size={16} />}
      <span className={`badge badge--plain ${open ? "badge--ok" : "badge--err"}`}
            data-testid="AdminLockBar-state">
        <span className="badge__dot" />{open ? t("lock.open") : t("lock.closed")}
      </span>
      <span className="lock-bar__desc">
        {configured ? hint : t("lock.notConfigured")}
      </span>
      {configured && open && (
        <button className="icon-button inline-flex items-center gap-1.5" onClick={() => onChange("")}
                title={t("lock.relock")} data-testid="AdminLockBar-lockButton">
          <LockIcon size={13} />{t("lock.relock")}
        </button>
      )}
      {configured && !open && !editing && (
        <button className="icon-button inline-flex items-center gap-1.5" onClick={() => setEditing(true)}
                title={t("lock.unlock")} data-testid="AdminLockBar-unlockButton">
          <LockIcon size={13} />{t("lock.unlock")}
        </button>
      )}
      {configured && !open && editing && (
        <span className="lock-bar__entry">
          <input
            ref={inputRef}
            className="ctl-field lock-bar__input"
            type="password"
            autoComplete="off"
            placeholder={t("lock.placeholder")}
            value={draft}
            disabled={checking}
            aria-invalid={error !== null}
            onChange={(e) => { setDraft(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") cancel();
            }}
            data-testid="AdminLockBar-passwordInput"
          />
          {error && (
            <span className="lock-bar__error" role="alert" data-testid="AdminLockBar-error">
              {error}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
