"use client";

/** ERD 하단 미리보기 서랍 — 테이블 화면과 **같은** 미리보기 컴포넌트를 얹는다.
 *
 * 서랍용으로 표만 따로 감싸면 필터·조회·컬럼 편집·정렬·CSV·SQL 보기가 한쪽에만 붙는다.
 * 그래서 PreviewSection을 그대로 마운트하고 탭 상태만 공용 훅(usePreviewTabs)에서 받는다 —
 * 두 화면의 기능 격차가 구조적으로 생기지 않는다.
 * The drawer mounts the table screen's PreviewSection as-is, so both screens always have
 * the same tools; only the tab state comes from the shared hook.
 */

import { useEffect, useRef } from "react";

import { PreviewSection } from "@/components/browser/PreviewSection";
import { useI18n } from "@/components/i18n";
import { ArrowRightIcon, CloseIcon } from "@/components/icons";
import type { PreviewTabsController } from "@/lib/use-preview-tabs";

interface ErdPreviewDrawerProps {
  preview: PreviewTabsController;
  /** 「테이블 화면에서 열기」 — 활성 탭을 테이블 화면에서 이어 본다 */
  onOpenFull: (objectId: number) => void;
  onClose: () => void;
}

export function ErdPreviewDrawer({ preview, onOpenFull, onClose }: ErdPreviewDrawerProps) {
  const { t } = useI18n();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 탭이 모두 닫히면 서랍도 닫는다 — 빈 껍데기가 캔버스를 가리지 않게
  useEffect(() => {
    if (preview.tabs.length === 0) onClose();
  }, [preview.tabs.length, onClose]);

  const activeId = preview.activeId ?? preview.tabs[0]?.id ?? null;

  return (
    <section
      className="card absolute inset-x-3 bottom-3 z-40 flex max-h-[60vh] flex-col overflow-hidden shadow-lg"
      data-testid="ErdPreviewDrawer-root"
    >
      {/* 얇은 서랍 바 — 제목은 PreviewSection이 이미 달고 있어 여기선 반복하지 않는다 */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5"
           style={{ borderColor: "var(--hairline)" }}>
        {preview.error && (
          <span className="truncate text-xs" style={{ color: "var(--error)" }}
                data-testid="ErdPreviewDrawer-errorText">
            {preview.error}
          </span>
        )}
        <button
          className="icon-button ml-auto"
          disabled={activeId === null}
          onClick={() => activeId !== null && onOpenFull(activeId)}
          data-testid="ErdPreviewDrawer-openFullButton"
        >
          {t("erd.previewOpenFull")}
          <ArrowRightIcon size={11} className="ml-1 inline-block align-middle" />
        </button>
        <button className="icon-button" onClick={onClose} title={t("common.close")}
                data-testid="ErdPreviewDrawer-closeButton">
          <CloseIcon />
        </button>
      </div>

      <div ref={bodyRef} className="scroll-area min-h-0 flex-1 overflow-y-auto p-3">
        <PreviewSection
          tabs={preview.tabs}
          activeId={preview.activeId}
          splitId={preview.splitId}
          onActivate={preview.setActiveId}
          onClose={preview.close}
          onSplitPick={preview.setSplitId}
          onRefetch={preview.refetch}
          onPatch={preview.patch}
          // 서랍 안에서는 「위로」가 서랍 본문을 되감는다 / scrolls the drawer body
          onJumpToTop={() => bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
        />
      </div>
    </section>
  );
}
