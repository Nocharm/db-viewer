"use client";

/** 컬럼 비공개 스키마 — 목록 노출 토글. 대상 스키마는 환경변수가 쥐고 있어 여기선 못 바꾼다.
 * Hidden-schema rail toggle; which schemas are hidden stays in HIDDEN_SCHEMAS. */

import { useCallback, useEffect, useState } from "react";

import {
  fetchHiddenSchemaRender,
  fetchPreviewAllowlistAdmin,
  setHiddenSchemaRender,
} from "@/lib/api";

export function HiddenSchemaPanel() {
  const [password, setPassword] = useState("");
  const [render, setRender] = useState(false);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [passwordConfigured, setPasswordConfigured] = useState(true);
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

  // 게이트는 미리보기 허용 목록과 같은 비밀번호라 설정 여부도 같은 곳에서 읽는다
  useEffect(() => {
    fetchPreviewAllowlistAdmin()
      .then((res) => setPasswordConfigured(res.password_configured))
      .catch((e) => setError(e.message));
  }, []);

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
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium">컬럼 비공개 스키마</h2>
        <span className="badge badge--muted" data-testid="AdminPage-hiddenSchemaCount">
          {schemas.length.toLocaleString()}
        </span>
      </div>
      <p className="mb-3 text-xs" style={{ color: "var(--muted)" }}>
        어떤 스키마를 감출지는 서버 <code>HIDDEN_SCHEMAS</code>(.env)가 정합니다 — 이 화면에서는
        바꿀 수 없습니다. 감춘 스키마는 컬럼·조인 검증·미리보기·ERD 노드가 모두 빠지고 해당
        테이블로 이동할 수 없으며, 아래 토글은 <b>좌측 스키마·카테고리 목록과 테이블 목록에
        이름을 노출할지</b>만 정합니다. 켜도 컬럼은 열리지 않습니다.
      </p>

      {/* 숨김 상태에선 어떤 스키마가 감춰졌는지도 밝히지 않는다 — 목록에서 뺀 이유가 존재를
          안 드러내는 것인데 관리 화면에 이름이 남으면 앞뒤가 안 맞는다. 개수만 보여준다.
          / while hidden, the names stay withheld here too: listing them in the console would
            undo the point of removing them from the rails. Only the count shows. */}
      <p className="mb-3 font-mono text-xs" data-testid="AdminPage-hiddenSchemaList">
        {schemas.length === 0 ? (
          <span style={{ color: "var(--muted)" }}>설정된 스키마가 없습니다 (HIDDEN_SCHEMAS 비어 있음)</span>
        ) : render ? (
          schemas.join(", ")
        ) : (
          <span style={{ color: "var(--muted)" }}>
            {schemas.length}건 숨김 중 — 이름은 「목록에 표시하기」를 켠 뒤에 보입니다
          </span>
        )}
      </p>

      {!passwordConfigured ? (
        <p className="mb-3 text-sm" style={{ color: "var(--error)" }}
           data-testid="AdminPage-hiddenSchemaNoPassword">
          {/* 같은 원인의 상세 안내(.env 설정)는 위 미리보기 섹션 경고가 담당 — 반복하지 않는다 */}
          PREVIEW_ADMIN_PASSWORD가 설정되지 않아 토글이 잠겨 있습니다 (설정 안내는 위
          미리보기 허용 섹션 참고).
        </p>
      ) : (
        <div className="mb-3 flex items-center gap-2">
          <input
            className="w-56 rounded border px-3 py-1.5 text-sm"
            style={{ borderColor: "var(--border-light)" }}
            type="password"
            placeholder="수정 비밀번호"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="AdminPage-hiddenSchemaPasswordInput"
          />
          <button
            className="btn-secondary"
            disabled={!canEdit || schemas.length === 0}
            onClick={() => toggle(!render)}
            data-testid="AdminPage-hiddenSchemaToggle"
          >
            {render ? "목록에서 숨기기" : "목록에 표시하기"}
          </button>
          <span className="text-xs" style={{ color: "var(--muted)" }}
                data-testid="AdminPage-hiddenSchemaState">
            현재: {render ? "표시" : "숨김"}
          </span>
        </div>
      )}

      {message && (
        <p className="text-xs" style={{ color: "var(--rel-confirmed)" }}
           data-testid="AdminPage-hiddenSchemaMessage">{message}</p>
      )}
      {error && (
        <p className="text-xs" style={{ color: "var(--error)" }}
           data-testid="AdminPage-hiddenSchemaError">{error}</p>
      )}
    </section>
  );
}
