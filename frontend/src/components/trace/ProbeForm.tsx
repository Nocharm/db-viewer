"use client";

/** 값 추적 조건 카드 — 스키마 다중 선택·값·라벨 힌트·일치 모드·연관 뷰·찾기/중단.
 *  The value-probe form: schema scope, value, label hint, match mode, related views, find/stop. */

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import { SearchIcon, SpinnerIcon, StopIcon } from "@/components/icons";
import { StepCardHeader } from "@/components/verify/StepCardHeader";
import type { SchemaCategoryItem, ValueProbeMode } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import {
  findButtonLabel, VALUE_MAX_LEN,
  type FindButtonMode, type ProbeForm as ProbeFormState,
} from "@/lib/value-probe";

interface ProbeFormProps {
  form: ProbeFormState;
  /** 허용 목록 ∩ 숨김 아님 — 페이지가 걸러서 준다 / already filtered by the page */
  schemas: SchemaCategoryItem[];
  running: boolean;
  /** 실행 중에만 채워진다 — 버튼 안의 진척 바 / null unless a job is polling */
  progress: { done: number; total: number } | null;
  onChange: (next: ProbeFormState) => void;
  onSubmit: () => void;
  onStop: () => void;
}

const MODES: { mode: ValueProbeMode; label: MessageKey; desc: MessageKey }[] = [
  { mode: "normalized", label: "trace.mode.normalized", desc: "trace.mode.normalizedDesc" },
  { mode: "exact", label: "trace.mode.exact", desc: "trace.mode.exactDesc" },
  { mode: "contains", label: "trace.mode.contains", desc: "trace.mode.containsDesc" },
];

const INPUT_STYLE = {
  borderColor: "var(--hairline-strong)", background: "var(--surface-card)", color: "var(--ink)",
};

const BUTTON_CLASS: Record<FindButtonMode, string> = {
  find: "btn-primary",
  progress: "btn-primary btn-progress",
  stop: "btn-secondary btn-stop",
};

export function ProbeForm({
  form, schemas, running, progress, onChange, onSubmit, onStop,
}: ProbeFormProps) {
  const { t } = useI18n();
  const [pointerOver, setPointerOver] = useState(false);
  const [keyFocus, setKeyFocus] = useState(false);
  // 실행 상태가 바뀌면 두 신호를 모두 지운다 — 커서가 버튼 위에 남아 있거나 Enter로 막
  // 제출한 포커스가 남아 있어도 「찾기」를 누른 직후 바로 「중단」으로 뒤집혀
  // 그 클릭/Enter가 자기 자신을 취소하는 사고를 막는다
  useEffect(() => {
    setPointerOver(false);
    setKeyFocus(false);
  }, [running]);

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

  // 한 버튼이 세 얼굴 — 자리를 옮기지 않아야 눈이 따라간다. 같은 <button>을 유지해
  // 호버·포커스가 끊기지 않게 하고 class/type/testid만 바꾼다
  const { done, total } = progress ?? { done: 0, total: 0 };
  // 마우스는 움직임으로, 키보드는 키를 뗀 순간으로 "의도된 두 번째 조작"을 구분한다
  const hovering = pointerOver || keyFocus;
  const mode = findButtonLabel({ running, hovering });
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

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
                <input type="checkbox" className="ctl-switch" checked={allSelected}
                       onChange={toggleAll} disabled={running}
                       data-testid="ProbeForm-allSchemas" />
                {t("trace.form.allSchemas")}
              </label>
              {[...groups].map(([category, items]) => (
                <div key={category} className="flex flex-col gap-1">
                  <div className="text-xs" style={{ color: "var(--muted)" }}>{category}</div>
                  <div className="flex flex-wrap gap-2">
                    {items.map((item) => (
                      <label key={item.schema} className="choice-pill">
                        <input type="checkbox" className="ctl-check"
                               checked={form.schemas.includes(item.schema)}
                               onChange={() => toggleSchema(item.schema)} disabled={running}
                               data-testid={`ProbeForm-schema-${item.schema}`} />
                        <span className="font-mono">{item.schema}</span>
                        <span className="text-xs" style={{ color: "var(--muted)" }}>{item.object_count}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <label className="choice-pill">
                  <input type="checkbox" className="ctl-switch" checked={form.includeRelatedViews}
                         onChange={(event) => onChange({
                           ...form, includeRelatedViews: event.target.checked,
                         })}
                         disabled={running} data-testid="ProbeForm-relatedSwitch" />
                  {t("trace.form.related")}
                  <span className="hint-pill">{t("trace.form.relatedHint")}</span>
                </label>
              </div>
            </>
          )}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            {t("trace.form.value")}
            <input className="rounded border px-2 py-1.5 font-mono text-sm" style={INPUT_STYLE}
                   maxLength={VALUE_MAX_LEN} value={form.value} disabled={running}
                   placeholder={t("trace.form.valuePlaceholder")}
                   onChange={(event) => onChange({ ...form, value: event.target.value })}
                   data-testid="ProbeForm-valueInput" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("trace.form.hint")}
            <input className="rounded border px-2 py-1.5 text-sm" style={INPUT_STYLE}
                   maxLength={128} value={form.hint} disabled={running}
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
          <div className="flex flex-wrap gap-2">
            {MODES.map(({ mode: option, label, desc }) => (
              <label key={option} className="choice-pill">
                <input type="radio" className="ctl-radio" name="probe-mode" value={option}
                       checked={form.mode === option} disabled={running}
                       onChange={() => onChange({ ...form, mode: option })}
                       data-testid={`ProbeForm-mode-${option}`} />
                {t(label)}
                <span className="hint-pill">{t(desc)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <button type={mode === "find" ? "submit" : "button"} className={BUTTON_CLASS[mode]}
                  onClick={mode === "stop" ? onStop : undefined}
                  onMouseEnter={() => setPointerOver(true)}
                  // 실행 시작 직후의 초기화 때문에 mouseenter가 다시 오지 않는다 —
                  // 커서를 조금만 움직여도 「중단」이 드러나게 mousemove도 함께 본다
                  onMouseMove={() => setPointerOver(true)}
                  onMouseLeave={() => setPointerOver(false)}
                  onBlur={() => setKeyFocus(false)}
                  // Enter로 「찾기」를 제출한 그 키의 keyup이 실행 중에 도착해 재무장한다 —
                  // 여기서 다시 Enter를 누르면(=키업) 그때는 「중단」이 뜬 뒤이므로 취소로 이어진다
                  onKeyUp={() => { if (running) setKeyFocus(true); }}
                  data-testid={mode === "stop" ? "ProbeForm-stopButton" : "ProbeForm-findButton"}>
            {mode === "find" && t("trace.form.find")}
            {mode === "progress" && (
              <>
                <SpinnerIcon size={14} className="spin" />
                {/* 한 덩어리로 둔다 — flex gap이 "찾는 중"과 숫자 사이를 또 벌리지 않게 */}
                <span>{t("trace.form.progress")}{total > 0 ? ` ${done} / ${total}` : ""}</span>
                <span className="btn-progress__fill" style={{ width: `${percent}%` }} />
              </>
            )}
            {mode === "stop" && (
              <>
                <StopIcon size={12} />
                {t("trace.form.stop")}
              </>
            )}
          </button>
        </div>
      </form>
    </section>
  );
}
