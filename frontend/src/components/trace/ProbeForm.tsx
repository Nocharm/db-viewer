"use client";

/** 값 추적 조건 카드 — 스키마 다중 선택·값·라벨 힌트·일치 모드·찾기.
 *  The value-probe form: schema scope, value, label hint, match mode, submit. */

import { useI18n } from "@/components/i18n";
import { SearchIcon } from "@/components/icons";
import { StepCardHeader } from "@/components/verify/StepCardHeader";
import type { SchemaCategoryItem, ValueProbeMode } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import { VALUE_MAX_LEN, type ProbeForm as ProbeFormState } from "@/lib/value-probe";

interface ProbeFormProps {
  form: ProbeFormState;
  /** 허용 목록 ∩ 숨김 아님 — 페이지가 걸러서 준다 / already filtered by the page */
  schemas: SchemaCategoryItem[];
  busy: boolean;
  onChange: (next: ProbeFormState) => void;
  onSubmit: () => void;
}

const MODES: { mode: ValueProbeMode; label: MessageKey; desc: MessageKey }[] = [
  { mode: "normalized", label: "trace.mode.normalized", desc: "trace.mode.normalizedDesc" },
  { mode: "exact", label: "trace.mode.exact", desc: "trace.mode.exactDesc" },
  { mode: "contains", label: "trace.mode.contains", desc: "trace.mode.containsDesc" },
];

const INPUT_STYLE = {
  borderColor: "var(--hairline-strong)", background: "var(--surface-card)", color: "var(--ink)",
};

export function ProbeForm({ form, schemas, busy, onChange, onSubmit }: ProbeFormProps) {
  const { t } = useI18n();
  const allSelected = schemas.length > 0 && form.schemas.length === schemas.length;

  // 선택 순서가 아니라 목록 순서를 유지한다 — 감사 로그·"나머지 스키마" 계산이 안정적이다
  const setSchemas = (picked: Set<string>) => onChange({
    ...form, schemas: schemas.filter((s) => picked.has(s.schema)).map((s) => s.schema),
  });
  const toggleSchema = (schema: string) => {
    const picked = new Set(form.schemas);
    if (picked.has(schema)) picked.delete(schema);
    else picked.add(schema);
    setSchemas(picked);
  };
  const toggleAll = () => setSchemas(new Set(allSelected ? [] : schemas.map((s) => s.schema)));

  const groups = new Map<string, SchemaCategoryItem[]>();
  for (const item of schemas) {
    const list = groups.get(item.category) ?? [];
    list.push(item);
    groups.set(item.category, list);
  }

  return (
    <section className="card p-4" data-testid="ProbeForm-root">
      <StepCardHeader no={1} icon={<SearchIcon size={14} />}
                      title={t("trace.form.title")} desc={t("trace.form.desc")} />
      <form className="flex flex-col gap-3"
            onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-semibold uppercase tracking-wider"
                  style={{ color: "var(--muted)" }}>
            {t("trace.form.schemas")}
          </legend>
          {schemas.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--slate)" }} data-testid="ProbeForm-noSchemas">
              {t("trace.form.noSchemas")}
            </p>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={allSelected} onChange={toggleAll}
                       data-testid="ProbeForm-allSchemas" />
                {t("trace.form.allSchemas")}
              </label>
              {[...groups].map(([category, items]) => (
                <div key={category} className="flex flex-col gap-1">
                  <div className="text-xs" style={{ color: "var(--muted)" }}>{category}</div>
                  <div className="flex flex-wrap gap-2">
                    {items.map((item) => (
                      <label key={item.schema}
                             className="pressable flex items-center gap-1.5 rounded border px-2 py-1 text-sm"
                             style={{ borderColor: "var(--hairline)" }}>
                        <input type="checkbox" checked={form.schemas.includes(item.schema)}
                               onChange={() => toggleSchema(item.schema)}
                               data-testid={`ProbeForm-schema-${item.schema}`} />
                        <span className="font-mono">{item.schema}</span>
                        <span className="text-xs" style={{ color: "var(--muted)" }}>{item.object_count}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            {t("trace.form.value")}
            <input className="rounded border px-2 py-1.5 font-mono text-sm" style={INPUT_STYLE}
                   maxLength={VALUE_MAX_LEN} value={form.value}
                   placeholder={t("trace.form.valuePlaceholder")}
                   onChange={(event) => onChange({ ...form, value: event.target.value })}
                   data-testid="ProbeForm-valueInput" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("trace.form.hint")}
            <input className="rounded border px-2 py-1.5 text-sm" style={INPUT_STYLE}
                   maxLength={128} value={form.hint}
                   placeholder={t("trace.form.hintPlaceholder")}
                   onChange={(event) => onChange({ ...form, hint: event.target.value })}
                   data-testid="ProbeForm-hintInput" />
          </label>
        </div>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-xs font-semibold uppercase tracking-wider"
                  style={{ color: "var(--muted)" }}>
            {t("trace.form.mode")}
          </legend>
          <div className="flex flex-wrap gap-3">
            {MODES.map(({ mode, label, desc }) => (
              <label key={mode} className="flex items-center gap-1.5 text-sm">
                <input type="radio" name="probe-mode" value={mode} checked={form.mode === mode}
                       onChange={() => onChange({ ...form, mode })}
                       data-testid={`ProbeForm-mode-${mode}`} />
                {t(label)}
                <span className="hint-pill">{t(desc)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <button type="submit" className="btn-primary" disabled={busy}
                  data-testid="ProbeForm-findButton">
            {busy ? t("trace.form.finding") : t("trace.form.find")}
          </button>
        </div>
      </form>
    </section>
  );
}
