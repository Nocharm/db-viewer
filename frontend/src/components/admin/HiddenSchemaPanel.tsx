"use client";

/** 컬럼 비공개 스키마 — 목록 노출 토글. 대상 스키마는 환경변수가 쥐고 있어 여기선 못 바꾼다.
 * 비밀번호는 관리 콘솔 잠금 바가 쥔다.
 * Hidden-schema rail toggle; which schemas are hidden stays in HIDDEN_SCHEMAS. */

import { useCallback, useEffect, useState } from "react";

import { fetchHiddenSchemaRender, setHiddenSchemaRender } from "@/lib/api";
import { CheckIcon, EyeOffIcon, WarningIcon } from "@/components/icons";

interface HiddenSchemaPanelProps {
  /** 관리 비밀번호(X-Preview-Password) — 관리 콘솔 잠금 바가 쥔 값 */
  password: string;
  passwordConfigured: boolean;
}

export function HiddenSchemaPanel({ password, passwordConfigured }: HiddenSchemaPanelProps) {
  const [render, setRender] = useState(false);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() =>
    fetchHiddenSchemaRender()
      .then((res) => {
        setRender(res.render);
        setSchemas(res.schemas);
      })
      .catch((e) => setError(e.message)), []);

  useEffect(() => { void reload(); }, [reload]);

  const canEdit = passwordConfigured && password.length > 0 && !saving;

  const toggle = (next: boolean) => {
    setMessage(null);
    setError(null);
    setSaving(true);
    setHiddenSchemaRender(next, password)
      .then((res) => {
        setRender(res.render);
        setMessage(res.render
          ? "목록에 표시합니다 — 컬럼과 진입은 여전히 막혀 있습니다."
          : "목록에서 숨깁니다.");
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <section className="mb-6" data-testid="AdminPage-hiddenSchemaSection">
      <div className="sec-head">
        <span className="sec-head__tile"><EyeOffIcon size={14} /></span>
        <h2 className="sec-head__title">컬럼 비공개 스키마</h2>
        <span className="cnt-pill" data-testid="AdminPage-hiddenSchemaCount">
          {schemas.length.toLocaleString()}
        </span>
        <div className="sec-head__right">
          <span className={`badge badge--plain ${render ? "badge--view" : "badge--muted"}`}
                data-testid="AdminPage-hiddenSchemaState">
            <span className="badge__dot" />{render ? "목록에 표시" : "목록에서 숨김"}
          </span>
          <input
            type="checkbox"
            role="switch"
            className="ctl-switch"
            aria-label="컬럼 비공개 스키마 이름을 목록에 표시"
            checked={render}
            disabled={!canEdit || schemas.length === 0}
            title={canEdit ? undefined : "잠금 바에 관리 비밀번호를 입력하세요"}
            onChange={(e) => toggle(e.target.checked)}
            data-testid="AdminPage-hiddenSchemaToggle"
          />
        </div>
      </div>
      <p className="sec-desc">
        어떤 스키마를 감출지는 서버 <code>HIDDEN_SCHEMAS</code>(.env)가 정합니다 — 이 화면에서는
        바꿀 수 없습니다. 감춘 스키마는 컬럼·조인 검증·미리보기·ERD 노드가 모두 빠지고 해당
        테이블로 이동할 수 없으며, 위 스위치는 <b>좌측 스키마·카테고리 목록과 테이블 목록에
        이름을 노출할지</b>만 정합니다. 켜도 컬럼은 열리지 않습니다.
      </p>

      {/* 숨김 상태에선 어떤 스키마가 감춰졌는지도 밝히지 않는다 — 목록에서 뺀 이유가 존재를
          안 드러내는 것인데 관리 화면에 이름이 남으면 앞뒤가 안 맞는다. 개수만 보여준다.
          / while hidden, the names stay withheld here too: listing them in the console would
            undo the point of removing them from the rails. Only the count shows. */}
      <div className="ml-9 text-xs" data-testid="AdminPage-hiddenSchemaList">
        {schemas.length === 0 ? (
          <span style={{ color: "var(--muted)" }}>설정된 스키마가 없습니다 (HIDDEN_SCHEMAS 비어 있음)</span>
        ) : render ? (
          <div className="flex flex-wrap gap-1.5">
            {schemas.map((schema) => (
              <span key={schema} className="schema-chip"><EyeOffIcon size={11} />{schema}</span>
            ))}
          </div>
        ) : (
          <span style={{ color: "var(--muted)" }}>
            {schemas.length}건 숨김 중 — 이름은 스위치를 켠 뒤에 보입니다
          </span>
        )}
      </div>

      {message && (
        <div className="banner banner--ok mt-3" data-testid="AdminPage-hiddenSchemaMessage">
          <CheckIcon size={15} /><span>{message}</span>
        </div>
      )}
      {error && (
        <div className="banner banner--err mt-3" data-testid="AdminPage-hiddenSchemaError">
          <WarningIcon size={15} /><span>{error}</span>
        </div>
      )}
    </section>
  );
}
