"use client";

/** ERD 하단 미리보기 서랍 — 캔버스를 떠나지 않고 값을 훑는다.
 *
 * 우클릭 「미리보기」가 테이블 화면으로 튕겨 보내면 방금 보던 그래프의 위치·확대가 사라진다.
 * 여기서는 TOP N만 빠르게 보고, 필터·CSV·SQL 같은 전체 도구가 필요하면 헤더의 링크로
 * 테이블 화면으로 건너간다. 표는 미리보기와 같은 컴포넌트를 그대로 쓴다.
 * A bottom drawer for a quick look at rows without leaving the canvas; the header links
 * out to the table screen when the full toolset is needed.
 */

import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n";
import {
  ArrowRightIcon, CloseIcon, EllipsisTextIcon, WrapTextIcon,
} from "@/components/icons";
import { PreviewTable } from "@/components/PreviewTable";
import { fetchObjectPreview, type TablePreview } from "@/lib/api";
import type { SortSpec } from "@/lib/preview-utils";

interface ErdPreviewDrawerProps {
  objectId: number;
  qname: string;
  /** 「테이블 화면에서 열기」 — 필터·CSV·SQL이 필요할 때의 탈출구 */
  onOpenFull: () => void;
  onClose: () => void;
}

// 서랍은 훑어보기용이라 행수를 고정한다 — 조건 검색·전량 확인은 테이블 화면 몫
const DRAWER_LIMIT = 50;

export function ErdPreviewDrawer({
  objectId, qname, onOpenFull, onClose,
}: ErdPreviewDrawerProps) {
  const { t } = useI18n();
  const [data, setData] = useState<TablePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [wrapCells, setWrapCells] = useState(false);

  // 대상 테이블이 바뀌면 이전 표를 지우고 다시 받는다 — 남은 행이 다른 테이블의 값으로
  // 오귀속되면 안 된다 (미리보기는 원본 값이 나가는 경로다)
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setHidden([]);
    setSort(null);
    setOrder([]);
    setBusy(true);
    fetchObjectPreview(objectId, undefined, DRAWER_LIMIT)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [objectId]);

  return (
    <section
      className="card absolute inset-x-3 bottom-3 z-40 flex max-h-[42vh] flex-col overflow-hidden shadow-lg"
      data-testid="ErdPreviewDrawer-root"
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
           style={{ borderColor: "var(--hairline)" }}>
        <span className="font-mono text-sm font-semibold" style={{ color: "var(--ink)" }}>
          {qname}
        </span>
        <span className="badge badge--muted">
          {t("preview.title")} TOP {DRAWER_LIMIT}
        </span>
        {data && (
          <span className="text-xs" style={{ color: "var(--muted)" }}>
            {data.rows.length}{t("preview.rowsSuffix")}
          </span>
        )}

        <button
          className="icon-button ml-auto"
          title={t("preview.cellModeTitle")}
          aria-pressed={wrapCells}
          onClick={() => setWrapCells((cur) => !cur)}
          data-testid="ErdPreviewDrawer-cellModeButton"
        >
          {wrapCells
            ? <EllipsisTextIcon size={11} className="mr-1 inline-block align-middle" />
            : <WrapTextIcon size={11} className="mr-1 inline-block align-middle" />}
          {wrapCells ? t("preview.ellipsisCells") : t("preview.wrapCells")}
        </button>
        <button className="icon-button" onClick={onOpenFull}
                data-testid="ErdPreviewDrawer-openFullButton">
          {t("erd.previewOpenFull")}
          <ArrowRightIcon size={11} className="ml-1 inline-block align-middle" />
        </button>
        <button className="icon-button" onClick={onClose} title={t("common.close")}
                data-testid="ErdPreviewDrawer-closeButton">
          <CloseIcon />
        </button>
      </div>

      <div className="scroll-area min-h-0 flex-1 overflow-auto">
        {busy && (
          <p className="p-3 text-sm" style={{ color: "var(--muted)" }}
             data-testid="ErdPreviewDrawer-busy">
            {t("common.loading")}
          </p>
        )}
        {!busy && error && (
          <p className="p-3 text-sm" style={{ color: "var(--error)" }}
             data-testid="ErdPreviewDrawer-errorText">
            {error}
          </p>
        )}
        {!busy && !error && data && (
          <PreviewTable
            data={data}
            hidden={hidden}
            sort={sort}
            order={order}
            wrapCells={wrapCells}
            onToggleHidden={(column) =>
              setHidden((cur) => (cur.includes(column)
                ? cur.filter((c) => c !== column) : [...cur, column]))}
            onSort={setSort}
            onReorder={setOrder}
          />
        )}
      </div>
    </section>
  );
}
