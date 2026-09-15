"use client";

/** 노드 정보 카드 — 노드를 **클릭**하면 열린다.
 *
 * 호버로 열던 것을 클릭으로 바꾼 이유: 맵을 훑기만 해도 카드가 따라 떠서 시야를 가렸다.
 * 위치는 클릭한 노드의 **오른쪽 바깥**이라 정작 보려던 노드를 덮지 않고, 세로는 마우스
 * 높이에 맞춰 시선이 멀리 가지 않는다.
 * / click-opened, anchored to the node's right edge so it never covers the node itself.
 */

import { useEffect, useState } from "react";

import { CloseIcon, ResetIcon, SparklesIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import type { LineageNodeData } from "@/lib/api";
import { generateAiSummary } from "@/lib/api";

/** 팝오버 크기(px) — 렌더 전 뷰포트 클램프용 상한(ErdViewer 우클릭 메뉴와 같은 관용구) */
const POPOVER_WIDTH = 330;
const POPOVER_HEIGHT = 230;
const EDGE_MARGIN = 12;
/** 노드 모서리에서 띄우는 간격(px) */
const NODE_OFFSET = 12;

export interface PopoverAnchor {
  node: LineageNodeData;
  /** 클릭한 노드의 화면 좌표 — 오른쪽 바깥에 붙인다 */
  nodeRight: number;
  nodeLeft: number;
  /** 마우스 높이 — 세로 기준 */
  pointerY: number;
}

interface Props {
  anchor: PopoverAnchor;
  /** 이 노드가 지금 맵의 기준인가 — 「상세 열기」 자리에 「현재 맵」 배지를 세운다 */
  isCurrentRoot: boolean;
  /** 이미 만들어 둔 요약 — 같은 섹션 안에서는 다시 만들지 않는다 */
  knownSummary: string | null;
  /** 이 요약이 목업 산출물인가 — 목업은 DB에 저장되지 않는다(`api/ai.py`) */
  isMock: boolean;
  onSummary: (qname: string, summary: string, mock: boolean) => void;
  onFocusNode: ((node: LineageNodeData) => void) | null;
  onOpenObject: ((node: LineageNodeData) => void) | null;
  onClose: () => void;
}

export function NodePopover({
  anchor, isCurrentRoot, knownSummary, isMock, onSummary,
  onFocusNode, onOpenObject, onClose,
}: Props) {
  const { t } = useI18n();
  const { node } = anchor;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = knownSummary ?? node.ai_summary;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => { setError(null); }, [node.qname]);

  const runSummary = () => {
    if (node.id === null) return;
    setBusy(true);
    setError(null);
    generateAiSummary(node.id)
      .then((res) => onSummary(node.qname, res.summary, res.mock))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // 오른쪽에 자리가 없으면 왼쪽 바깥으로 넘긴다 — 어느 쪽이든 노드를 덮지 않는 것이 규칙
  const fitsRight = anchor.nodeRight + NODE_OFFSET + POPOVER_WIDTH
    <= window.innerWidth - EDGE_MARGIN;
  const left = fitsRight
    ? anchor.nodeRight + NODE_OFFSET
    : Math.max(EDGE_MARGIN, anchor.nodeLeft - NODE_OFFSET - POPOVER_WIDTH);
  const top = Math.min(
    Math.max(EDGE_MARGIN, anchor.pointerY - 40),
    window.innerHeight - POPOVER_HEIGHT - EDGE_MARGIN,
  );

  return (
    <div
      className="lineage-popover"
      style={{ left, top: Math.max(EDGE_MARGIN, top) }}
      role="dialog"
      aria-label={`${node.qname} ${t("lineage.nodeInfo")}`}
      data-testid="NodePopover-root"
    >
      <div className="lineage-popover__head">
        <span className={`badge ${node.type === "view" ? "badge--view" : "badge--muted"}`}>
          {node.type === "unresolved" ? "EXTERNAL" : node.type.toUpperCase()}
        </span>
        <code className="lineage-popover__name" title={node.qname}>{node.qname}</code>
        <button className="icon-button !p-1 ml-auto" onClick={onClose} title={t("tree.close")}
                data-testid="NodePopover-closeButton">
          <CloseIcon size={11} />
        </button>
      </div>

      <dl className="lineage-popover__stats">
        <div>
          <dt>{t("lineage.statRows")}</dt>
          <dd>{node.row_count === null ? "—" : node.row_count.toLocaleString()}</dd>
        </div>
        <div>
          <dt>{t("lineage.statColumns")}</dt>
          <dd>{node.column_count === null ? "—" : node.column_count.toLocaleString()}</dd>
        </div>
        <div>
          <dt>depth</dt>
          <dd>{node.depth}</dd>
        </div>
      </dl>

      <div className="lineage-popover__summary">
        {summary !== null ? (
          <p data-testid="NodePopover-summary">
            <span className="badge badge--ai mr-1.5">AI</span>
            {isMock && (
              <span className="badge badge--muted mr-1.5"
                    title={t("lineage.aiMockHint")}
                    data-testid="NodePopover-mockBadge">
                {t("ai.mockBadge")}
              </span>
            )}
            {summary}
            {node.id !== null && (
              <button
                className="icon-button !ml-1.5 !px-1 !py-0 align-middle"
                disabled={busy}
                onClick={runSummary}
                title={t("lineage.aiRetry")}
                data-testid="NodePopover-retrySummaryButton"
              >
                <ResetIcon size={10} />
              </button>
            )}
          </p>
        ) : node.id === null ? (
          <p style={{ color: "var(--muted)" }}>{t("lineage.noSummaryExternal")}</p>
        ) : (
          <button
            className="icon-button inline-flex items-center gap-1.5"
            disabled={busy}
            onClick={runSummary}
            data-testid="NodePopover-generateSummaryButton"
          >
            <SparklesIcon size={11} />
            {busy ? t("ai.working") : t("ai.generateSummary")}
          </button>
        )}
        {error !== null && (
          <p style={{ color: "var(--error)" }} data-testid="NodePopover-error">{error}</p>
        )}
      </div>

      {/* 두 버튼은 한 줄 — 「상세 열기」가 오른쪽 끝(화면을 떠나는 동작이라 떼어 둔다) */}
      <div className="lineage-popover__actions">
        {onFocusNode && (
          <button className="btn-secondary !py-1 text-xs"
                  onClick={() => onFocusNode(node)}
                  data-testid="NodePopover-focusButton">
            {t("lineage.focusNode")}
          </button>
        )}
        {isCurrentRoot ? (
          <span className="badge badge--muted ml-auto" data-testid="NodePopover-currentRoot">
            {t("lineage.currentMap")}
          </span>
        ) : (
          <button
            className="btn-secondary !py-1 ml-auto text-xs"
            disabled={onOpenObject === null}
            title={onOpenObject === null ? t("lineage.openBlocked") : undefined}
            onClick={() => onOpenObject?.(node)}
            data-testid="NodePopover-openButton"
          >
            {t("lineage.openDetail")}
          </button>
        )}
      </div>
    </div>
  );
}
