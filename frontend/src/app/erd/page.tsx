"use client";

/** 읽기 전용 ERD 화면 — 캔버스 + (열렸을 때) 아래 미리보기 섹션.
 *
 * 레이아웃은 테이블 화면과 같은 문법이다: 캔버스가 뷰포트 한 화면을 차지하고, 미리보기는
 * **아래로 이어 붙는 섹션**이라 전체 스크롤로 오간다(겹치는 서랍이 아니다). 열면 자동으로
 * 그리로 내려가고, 섹션의 「위로」가 캔버스로 되돌린다.
 * The whole-graph ERD page; the preview is a section below the canvas, not an overlay.
 */

import { Suspense, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { PreviewSection } from "@/components/browser/PreviewSection";
import { ErdViewer } from "@/components/erd/ErdViewer";
import { usePreviewTabs } from "@/lib/use-preview-tabs";

export default function ErdPage() {
  return (
    <Suspense fallback={null}>
      <ErdPageInner />
    </Suspense>
  );
}

function ErdPageInner() {
  const params = useSearchParams();
  const preview = usePreviewTabs();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const focusParam = params.get("focus");
  // 빈 문자열("")은 truthy 가드로 걸러진다 — Number("")===0이라 정수 검사만으론 안 잡힌다
  const parsedFocus = focusParam ? Number(focusParam) : Number.NaN;

  // 미리보기를 열면 그 섹션으로 자동 이동 — 캔버스가 한 화면을 차지해 그냥 두면
  // 열린 줄도 모른다. 섹션이 붙은 다음 프레임에 스크롤해야 목표가 존재한다
  const openPreview = useCallback((objectId: number, qname: string) => {
    preview.open(objectId, qname);
    setTimeout(() => previewRef.current?.scrollIntoView(
      { behavior: "smooth", block: "start" }), 60);
  }, [preview]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader />
      <div ref={scrollRef} className="scroll-area min-h-0 flex-1">
        {/* 캔버스는 정확히 한 화면 — h-full이라 미리보기가 없을 땐 스크롤이 생기지 않는다
            (테이블 화면과 같은 구조) / the canvas is exactly one viewport tall */}
        <div className="flex h-full flex-col">
          <main className="relative min-h-0 flex-1">
            <ErdViewer
              focusId={Number.isInteger(parsedFocus) ? parsedFocus : null}
              focusLabel={params.get("label")}
              onPreview={openPreview}
            />
          </main>
        </div>

        {preview.tabs.length > 0 && (
          <div ref={previewRef} className="px-4 pb-4 pt-3" data-testid="ErdPage-previewSection">
            {preview.error && (
              <p className="mb-2 text-sm" style={{ color: "var(--error)" }}
                 data-testid="ErdPage-previewError">
                {preview.error}
              </p>
            )}
            <PreviewSection
              tabs={preview.tabs}
              activeId={preview.activeId}
              splitId={preview.splitId}
              onActivate={preview.setActiveId}
              onClose={preview.close}
              onSplitPick={preview.setSplitId}
              onRefetch={preview.refetch}
              onPatch={preview.patch}
              // 「위로」는 캔버스로 되돌린다 / back up to the canvas
              onJumpToTop={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
