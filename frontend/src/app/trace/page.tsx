"use client";

/** 값 추적 화면 — 값 하나 → 스키마 범위 → 객체당 쿼리 1개 → 찾은 것부터 표시.
 *  Value probe: one value, a schema scope, one query per object, hits shown as they arrive. */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { useI18n } from "@/components/i18n";
import { SourceSelector } from "@/components/SourceSelector";
import { ProbeForm } from "@/components/trace/ProbeForm";
import { ProbeHeavyList } from "@/components/trace/ProbeHeavyList";
import { ProbeHits } from "@/components/trace/ProbeHits";
import { ProbeProgress } from "@/components/trace/ProbeProgress";
import { ProbeStepNav } from "@/components/trace/ProbeStepNav";
import {
  cancelValueProbe, fetchSchemaCategories, fetchValueProbeJob, runValueProbeHeavy,
  startValueProbe, type SchemaCategoryItem, type ValueProbeJob, type ValueProbeStart,
} from "@/lib/api";
import { readSourceId } from "@/lib/source-param";
import { useDataSources } from "@/lib/use-data-sources";
import { useHiddenSchemas } from "@/lib/use-hidden-schemas";
import { usePreviewAllowlist } from "@/lib/use-preview-allowlist";
import {
  remainingSchemas, selectableSchemas, shouldKeepPolling, validateProbeRequest,
  type ProbeForm as ProbeFormState,
} from "@/lib/value-probe";

// 진행 폴링 간격(ms) — 실행 중일 때만 돈다 (CollectPanel과 동일) / poll only while running
const POLL_MS = 1500;

// catch 변수는 unknown이다 — Error가 아닌 값이 와도 화면에 "undefined"를 찍지 않게 한다
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function TracePage() {
  return (
    <Suspense fallback={null}>
      <TracePageInner />
    </Suspense>
  );
}

function TracePageInner() {
  const { t } = useI18n();
  const params = useSearchParams();
  const [sourceId, setSourceId] = useState<number | null>(
    () => readSourceId(`?${params.toString()}`),
  );
  const sources = useDataSources();
  const sourceEngine = sourceId === null ? null
    : (sources.find((source) => source.id === sourceId)?.engine ?? null);
  // 소스가 하나뿐이면 선택기가 숨겨진다 — 요청에는 그래도 실제 소스 id가 필요하다
  const effectiveSourceId = sourceId ?? sources[0]?.id ?? 1;

  const allowed = usePreviewAllowlist(sourceId);
  const hidden = useHiddenSchemas();
  const [categories, setCategories] = useState<SchemaCategoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchSchemaCategories(sourceId)
      .then((res) => setCategories(res.items))
      .catch((e: unknown) => setError(toErrorMessage(e)));
  }, [sourceId]);
  const schemaOptions = selectableSchemas(categories, allowed, hidden);
  const allowedNames = schemaOptions.map((item) => item.schema);

  const [form, setForm] = useState<ProbeFormState>({
    sourceId, schemas: [], value: "", hint: "", mode: "normalized", includeRelatedViews: false,
  });
  const [starting, setStarting] = useState(false);
  const [plan, setPlan] = useState<ValueProbeStart["plan"] | null>(null);
  const [job, setJob] = useState<ValueProbeJob | null>(null);

  const changeSource = useCallback((next: number | null) => {
    setSourceId(next);
    setForm((cur) => ({ ...cur, sourceId: next, schemas: [] }));
    setJob(null);
    setPlan(null);
    // 브라우저 화면과 같은 규칙 — 소스는 URL에 실려 새로고침을 견딘다
    const url = new URL(window.location.href);
    if (next === null) url.searchParams.delete("source");
    else url.searchParams.set("source", String(next));
    window.history.replaceState(null, "", url.toString());
  }, []);

  const start = useCallback(async (schemas: string[]) => {
    const request = { ...form, schemas };
    const problem = validateProbeRequest(request);
    if (problem) {
      setError(t(problem));
      return;
    }
    setError(null);
    setStarting(true);
    try {
      const started = await startValueProbe({
        source_id: effectiveSourceId, schemas, value: request.value.trim(),
        mode: request.mode, hint: request.hint.trim() || undefined,
        include_related_views: request.includeRelatedViews,
      });
      setPlan(started.plan);
      setJob(await fetchValueProbeJob(started.job_id));
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setStarting(false);
    }
  }, [form, effectiveSourceId, t]);

  const jobId = job?.job_id ?? null;
  const polling = job !== null && shouldKeepPolling(job.status);
  useEffect(() => {
    if (!polling || jobId === null) return;
    const timer = setInterval(() => {
      fetchValueProbeJob(jobId).then(setJob).catch((e: unknown) => setError(toErrorMessage(e)));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, jobId]);

  const refresh = useCallback(async (id: number) => {
    setJob(await fetchValueProbeJob(id));
  }, []);

  const handleCancel = useCallback(async () => {
    if (jobId === null) return;
    try {
      await cancelValueProbe(jobId);
      await refresh(jobId);
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }, [jobId, refresh]);

  const handleRunHeavy = useCallback(async (targetIds: number[]) => {
    if (jobId === null) return;
    try {
      await runValueProbeHeavy(jobId, targetIds);
      await refresh(jobId);
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }, [jobId, refresh]);

  // useMemo로 감싸 handleContinue의 deps가 매 렌더 새 배열로 흔들리지 않게 한다
  const rest = useMemo(
    () => (job ? remainingSchemas(allowedNames, job.schemas) : []),
    [job, allowedNames],
  );
  const handleContinue = useCallback(() => {
    if (rest.length > 0) void start(rest);
  }, [rest, start]);

  /** 좌측 진행 순서 → 해당 카드로 스크롤 + 테두리 한 번 깜빡 (/verify와 같은 동작).
   * 잡이 없어 카드가 아직 없으면 조용히 무시한다 / jump and flash; no-op without a card. */
  const navigateToStep = (no: number) => {
    const el = document.getElementById(`trace-step-${no}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.remove("flash-attention");
    void el.offsetWidth; // 같은 카드를 연속으로 눌러도 다시 돌게 리플로를 강제한다
    el.classList.add("flash-attention");
    window.setTimeout(() => el.classList.remove("flash-attention"), 2600);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden" data-testid="ValueProbePage-root">
      <AppHeader sourceEngine={sourceEngine}>
        <SourceSelector value={sourceId} onChange={changeSource} />
      </AppHeader>
      {/* 조인 검증과 같은 2열 — 왼쪽은 제목·진행 순서(스크롤해도 붙어 있다), 오른쪽은 단계 카드
          / two columns like /verify: sticky title + navigator on the left, step cards on the right */}
      <main className="scroll-area scroll-area--y flex-1 p-3">
        <div className="grid items-start gap-3" style={{ gridTemplateColumns: "20rem minmax(0, 1fr)" }}>
          <div className="sticky top-0 flex flex-col gap-3">
            <div>
              <h1 className="text-lg font-semibold" style={{ color: "var(--ink)" }}>{t("trace.title")}</h1>
              <p className="text-sm" style={{ color: "var(--slate)" }}>{t("trace.subtitle")}</p>
            </div>
            <ProbeStepNav job={job} onNavigate={navigateToStep} />
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {error && (
              <div className="text-sm" style={{ color: "var(--error)" }} data-testid="ValueProbePage-errorText">
                {error}
              </div>
            )}
            {/* 시작 요청(starting) 동안에도 실행 상태다 — 응답 전 두 번 눌러 잡이 겹치지 않게 */}
            <ProbeForm id="trace-step-1" form={form} schemas={schemaOptions} running={starting || polling}
                       progress={job && polling ? job.progress : null}
                       onChange={setForm} onSubmit={() => void start(form.schemas)}
                       onStop={() => void handleCancel()} />
            {job && <ProbeProgress id="trace-step-2" job={job} plan={plan} />}
            {job && (
              <ProbeHits id="trace-step-3" job={job} sourceId={sourceId} canContinue={rest.length > 0}
                         onContinue={handleContinue} />
            )}
            {job && job.heavy.length > 0 && (
              <ProbeHeavyList id="trace-step-4" job={job} busy={polling}
                              onRun={(ids) => void handleRunHeavy(ids)} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
