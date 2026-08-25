"use client";

/** 읽기 전용 ERD 화면 — 확정된 관계 전체 그래프 / the read-only whole-graph ERD page. */

import { Suspense, useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { ErdViewer } from "@/components/erd/ErdViewer";
import { SourceSelector } from "@/components/SourceSelector";
import { readSourceId } from "@/lib/source-param";
import { useDataSources } from "@/lib/use-data-sources";

export default function ErdPage() {
  return (
    <Suspense fallback={null}>
      <ErdPageInner />
    </Suspense>
  );
}

function ErdPageInner() {
  const params = useSearchParams();
  const focusParam = params.get("focus");
  // 빈 문자열("")은 truthy 가드로 걸러진다 — Number("")===0이라 정수 검사만으론 안 잡힌다
  const parsedFocus = focusParam ? Number(focusParam) : Number.NaN;

  // useSearchParams()에서 초기값을 뽑는다 — window.location은 SSR(standalone 출력)에서
  // 없다. 이후 갱신은 history.replaceState가 맡는다(page.tsx와 동일 패턴).
  const [sourceId, setSourceId] = useState<number | null>(
    () => readSourceId(`?${params.toString()}`),
  );
  const sources = useDataSources();
  const selectedSource = sourceId !== null ? sources.find((s) => s.id === sourceId) : null;
  // 기본 소스(null)는 항상 MSSQL — 아직 목록이 안 실렸을 때도 헤더 링크를 숨기지 않는다
  const sourceEngine = sourceId === null ? null : (selectedSource?.engine ?? null);

  const changeSource = useCallback((nextSourceId: number | null) => {
    setSourceId(nextSourceId);
    const url = new URL(window.location.href);
    if (nextSourceId === null) url.searchParams.delete("source");
    else url.searchParams.set("source", String(nextSourceId));
    // focus/label은 이전 소스의 노드를 가리킬 수 있어 함께 지운다 — 없는 노드를 찾다
    // 배너만 뜨는 상태로 남지 않게 / focus/label may point at the old source's node;
    // clear them too instead of leaving the viewer hunting for a missing node.
    url.searchParams.delete("focus");
    url.searchParams.delete("label");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader sourceEngine={sourceEngine}>
        <SourceSelector value={sourceId} onChange={changeSource} />
      </AppHeader>
      <main className="relative min-h-0 flex-1">
        {/* key로 소스마다 새로 마운트 — 펼침·수동 배치·하이라이트 등 그래프 내부 상태가
            이전 소스의 노드를 참조한 채 남지 않는다 / remount per source so internal state
            (expanded nodes, manual layout, highlight) never lingers from the old graph. */}
        <ErdViewer
          key={sourceId ?? "default"}
          sourceId={sourceId}
          sourceEngine={sourceEngine}
          focusId={Number.isInteger(parsedFocus) ? parsedFocus : null}
          focusLabel={params.get("label")}
        />
      </main>
    </div>
  );
}
