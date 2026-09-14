"use client";

/** 컬럼 비공개 스키마 — 목록 노출 토글. 대상 스키마는 환경변수가 쥐고 있어 여기선 못 바꾼다.
 * 비밀번호는 관리 콘솔 잠금 바가 쥔다.
 * Hidden-schema rail toggle; which schemas are hidden stays in HIDDEN_SCHEMAS. */

import { useCallback, useEffect, useState } from "react";

import { fetchHiddenSchemaRender, setHiddenSchemaRender } from "@/lib/api";
import { useI18n } from "@/components/i18n";
import { CheckIcon, EyeOffIcon, WarningIcon } from "@/components/icons";

interface HiddenSchemaPanelProps {
  /** 관리 비밀번호(X-Preview-Password) — 관리 콘솔 잠금 바가 쥔 값 */
  password: string;
  passwordConfigured: boolean;
}

export function HiddenSchemaPanel({ password, passwordConfigured }: HiddenSchemaPanelProps) {
  const { t } = useI18n();
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
        setMessage(t(res.render ? "hidden.setDone" : "hidden.unsetDone"));
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <section className="mb-6" data-testid="AdminPage-hiddenSchemaSection">
      <div className="sec-head">
        <span className="sec-head__tile"><EyeOffIcon size={14} /></span>
        <h2 className="sec-head__title">{t("hidden.title")}</h2>
        <span className="cnt-pill" data-testid="AdminPage-hiddenSchemaCount">
          {schemas.length.toLocaleString()}
        </span>
        <div className="sec-head__right">
          <span className={`badge badge--plain ${render ? "badge--view" : "badge--muted"}`}
                data-testid="AdminPage-hiddenSchemaState">
            <span className="badge__dot" />{t(render ? "hidden.shown" : "hidden.notShown")}
          </span>
          <input
            type="checkbox"
            role="switch"
            className="ctl-switch"
            aria-label={t("hidden.switchLabel")}
            checked={render}
            disabled={!canEdit || schemas.length === 0}
            title={canEdit ? undefined : t("admin.lockedTitle")}
            onChange={(e) => toggle(e.target.checked)}
            data-testid="AdminPage-hiddenSchemaToggle"
          />
        </div>
      </div>
      <p className="sec-desc">
        {t("hidden.desc1")} <code>HIDDEN_SCHEMAS</code>{t("hidden.desc2")}
        <b>{t("hidden.descEmphasis")}</b>{t("hidden.desc3")}
      </p>

      {/* 숨김 상태에선 어떤 스키마가 감춰졌는지도 밝히지 않는다 — 목록에서 뺀 이유가 존재를
          안 드러내는 것인데 관리 화면에 이름이 남으면 앞뒤가 안 맞는다. 개수만 보여준다.
          / while hidden, the names stay withheld here too: listing them in the console would
            undo the point of removing them from the rails. Only the count shows. */}
      <div className="ml-9 text-xs" data-testid="AdminPage-hiddenSchemaList">
        {schemas.length === 0 ? (
          <span style={{ color: "var(--muted)" }}>{t("hidden.none")}</span>
        ) : render ? (
          <div className="flex flex-wrap gap-1.5">
            {schemas.map((schema) => (
              <span key={schema} className="schema-chip"><EyeOffIcon size={11} />{schema}</span>
            ))}
          </div>
        ) : (
          <span style={{ color: "var(--muted)" }}>
            {t("hidden.countHidden").replace("{n}", String(schemas.length))}
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
