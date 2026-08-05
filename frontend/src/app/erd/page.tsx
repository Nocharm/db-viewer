"use client";

/** ERD 캔버스 화면 — 검색 + 캔버스 / the ERD canvas page. */

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { useI18n } from "@/components/i18n";
import { ErdCanvas } from "@/components/erd/ErdCanvas";
import { SearchPanel } from "@/components/SearchPanel";
import { fetchAiJob, searchObjects, startAiSuggest } from "@/lib/api";
import type { ObjectSummary } from "@/lib/types";

export default function ErdPage() {
  return (
    <Suspense fallback={null}>
      <ErdPageInner />
    </Suspense>
  );
}

function anchorFromParams(id: string | null, label: string | null): ObjectSummary | null {
  if (!id || !label || !label.includes(".")) return null;
  const [schema, name] = label.split(".", 2);
  return {
    id: Number(id), schema, name, type: "table",
    row_count: null, column_count: 0, dmv_unresolved: false,
  };
}

function ErdPageInner() {
  const { t } = useI18n();
  const params = useSearchParams();
  const [anchor, setAnchor] = useState<ObjectSummary | null>(() =>
    anchorFromParams(params.get("anchor"), params.get("label")));
  // 같은 라우트 내 딥링크 갱신(챗 칩 등) — router.push는 리마운트하지 않아 params를 직접 구독
  // re-sync when the query string changes without a remount (e.g. a chat table chip push)
  useEffect(() => {
    const next = anchorFromParams(params.get("anchor"), params.get("label"));
    if (!next) return;
    setAnchor((cur) => (cur?.id === next.id ? cur : next));
  }, [params]);
  // 브라우저 컬럼 칩 딥링크 → 빌더의 추천 하이라이트 자동 점등
  const [initialColumnId] = useState<number | null>(() => {
    const columnId = params.get("col");
    return columnId ? Number(columnId) : null;
  });
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiJobId, setAiJobId] = useState<number | null>(null);

  // AI 제안 잡 폴링 — 완료·실패까지 1.5초 간격 (다른 비동기 작업과 동일한 폴링 관용)
  // poll until done or failed, the same 1.5s polling convention used elsewhere
  useEffect(() => {
    if (aiJobId === null) return;
    const timer = setInterval(() => {
      fetchAiJob(aiJobId)
        .then((job) => {
          if (job.status === "done" && job.result && "suggested" in job.result) {
            setAiNotice(t("erd.aiNotice")
              .replace("{s}", String(job.result.suggested))
              .replace("{n}", String(job.result.created)));
            setAiJobId(null);
            setAiBusy(false);
          } else if (job.status === "failed") {
            setAiNotice(job.error ?? t("ai.failed"));
            setAiJobId(null);
            setAiBusy(false);
          }
        })
        .catch((e) => {
          setAiNotice(e.message);
          setAiJobId(null);
          setAiBusy(false);
        });
    }, 1500);
    return () => clearInterval(timer);
  }, [aiJobId, t]);

  // 빈 캔버스 가이드 칩 → 검색 후 정확 일치 앵커 선택 / quick-start chip resolves an anchor
  const handleQuickStart = useCallback((name: string) => {
    void searchObjects(name).then((res) => {
      const hit = res.items.find((i) => i.name === name) ?? res.items[0];
      if (hit) setAnchor(hit);
    });
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader>
        <span className="text-sm" style={{ color: "var(--muted)" }}>
          {anchor ? `${anchor.schema}.${anchor.name}` : t("erd.startHint")}
        </span>
        <button
          className="icon-button"
          disabled={aiBusy}
          onClick={() => {
            setAiBusy(true);
            void startAiSuggest()
              .then((res) => setAiJobId(res.job_id))
              .catch((e) => {
                setAiNotice(e.message);
                setAiBusy(false);
              });
          }}
          data-testid="Home-aiSuggestButton"
        >
          {aiBusy ? t("ai.working") : t("erd.aiSuggest")}
        </button>
        {aiNotice && (
          <span className="text-sm" style={{ color: "var(--slate)" }}
                data-testid="Home-aiNotice">
            {aiNotice}
          </span>
        )}
      </AppHeader>
      {/* 캔버스 전체폭 — 검색·검증은 플로팅 오버레이 / full-bleed canvas, floating panels */}
      <main className="relative min-h-0 flex-1">
        <ErdCanvas
          anchorId={anchor?.id ?? null}
          initialColumnId={initialColumnId}
          onSelectColumn={() => undefined}
          onQuickStart={handleQuickStart}
        />
        <SearchPanel onSelect={setAnchor} selectedId={anchor?.id ?? null} />
      </main>
    </div>
  );
}
