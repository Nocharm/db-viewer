"use client";

/** 노드 정보 팝오버 — 호버로 뜨고 핀으로 고정된다.
 *
 * 호버만으로 띄우고 버튼을 달면 마우스를 버튼까지 옮기는 사이 사라진다. 그래서 팝오버 자신도
 * 호버를 받아 유지된다(`onMouseEnter`). 고정은 팝오버의 핀 버튼이 맡는다 — 카드 클릭은
 * 미사용 컬럼 펼침에 이미 쓰고 있다.
 * / hover opens it, the popover keeps itself alive, its pin button makes it stay. */

import { useEffect, useRef, useState } from "react";

import { CloseIcon, PinIcon, SparklesIcon } from "@/components/icons";
import type { LineageNodeData } from "@/lib/api";
import { generateAiSummary } from "@/lib/api";

/** 팝오버 추정 크기(px) — 렌더 전 뷰포트 클램프용(ErdViewer의 우클릭 메뉴와 같은 관용구) */
const POPOVER_WIDTH = 288;
const POPOVER_HEIGHT = 220;
const EDGE_MARGIN = 12;

export interface PopoverAnchor {
  node: LineageNodeData;
  /** 화면(fixed) 좌표 */
  x: number;
  y: number;
  pinned: boolean;
}

interface Props {
  anchor: PopoverAnchor;
  /** 이 노드를 맵의 기준으로 다시 그린다 — null이면 이미 기준이라 버튼을 숨긴다 */
  onFocusNode: ((node: LineageNodeData) => void) | null;
  /** 이 객체를 상세 패널에서 연다 — 숨김 스키마·카탈로그 밖이면 null */
  onOpenObject: ((node: LineageNodeData) => void) | null;
  /** 마우스를 떼도 남게 고정 — 카드 클릭은 컬럼 펼침이라 여기서 고정한다 */
  onPin: () => void;
  onClose: () => void;
  onKeepAlive: () => void;
  onRelease: () => void;
}

export function NodePopover({
  anchor, onFocusNode, onOpenObject, onPin, onClose, onKeepAlive, onRelease,
}: Props) {
  const { node } = anchor;
  const [summary, setSummary] = useState<string | null>(node.ai_summary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 노드가 바뀌면 이전 노드의 요약을 즉시 버린다 — 남으면 남의 설명이 잠깐 붙는다
  useEffect(() => {
    setSummary(node.ai_summary);
    setError(null);
  }, [node.qname, node.ai_summary]);

  // 고정된 팝오버는 Esc로 닫는다 / pinned popovers close on Escape
  useEffect(() => {
    if (!anchor.pinned) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anchor.pinned, onClose]);

  const left = Math.min(anchor.x, window.innerWidth - POPOVER_WIDTH - EDGE_MARGIN);
  const top = Math.min(anchor.y, window.innerHeight - POPOVER_HEIGHT - EDGE_MARGIN);

  return (
    <div
      ref={boxRef}
      className="lineage-popover"
      style={{ left: Math.max(EDGE_MARGIN, left), top: Math.max(EDGE_MARGIN, top) }}
      onMouseEnter={onKeepAlive}
      onMouseLeave={onRelease}
      role="dialog"
      aria-label={`${node.qname} 정보`}
      data-testid="NodePopover-root"
    >
      <div className="lineage-popover__head">
        <span className={`badge ${node.type === "view" ? "badge--view" : "badge--muted"}`}>
          {node.type === "unresolved" ? "EXTERNAL" : node.type.toUpperCase()}
        </span>
        <code className="lineage-popover__name" title={node.qname}>{node.qname}</code>
        {anchor.pinned ? (
          <button className="icon-button !p-1 ml-auto" onClick={onClose} title="닫기"
                  data-testid="NodePopover-closeButton">
            <CloseIcon size={11} />
          </button>
        ) : (
          <button className="icon-button !p-1 ml-auto" onClick={onPin} title="고정"
                  data-testid="NodePopover-pinButton">
            <PinIcon size={11} />
          </button>
        )}
      </div>

      <dl className="lineage-popover__stats">
        <div>
          <dt>행</dt>
          <dd>{node.row_count === null ? "—" : node.row_count.toLocaleString()}</dd>
        </div>
        <div>
          <dt>컬럼</dt>
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
            <span className="badge badge--ai mr-1.5">AI</span>{summary}
          </p>
        ) : node.id === null ? (
          <p style={{ color: "var(--muted)" }}>카탈로그 밖 객체라 요약할 수 없다.</p>
        ) : (
          <button
            className="icon-button inline-flex items-center gap-1.5"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              generateAiSummary(node.id as number)
                .then((res) => setSummary(res.summary))
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
            data-testid="NodePopover-generateSummaryButton"
          >
            <SparklesIcon size={11} />
            {busy ? "생성 중…" : "AI 요약 생성"}
          </button>
        )}
        {error !== null && (
          <p style={{ color: "var(--error)" }} data-testid="NodePopover-error">{error}</p>
        )}
      </div>

      {(onFocusNode || onOpenObject) && (
        <div className="lineage-popover__actions">
          {onFocusNode && (
            <button className="btn-secondary !py-1 text-xs"
                    onClick={() => onFocusNode(node)}
                    data-testid="NodePopover-focusButton">
              이 노드 중심으로 보기
            </button>
          )}
          {onOpenObject && (
            <button className="btn-secondary !py-1 text-xs"
                    onClick={() => onOpenObject(node)}
                    data-testid="NodePopover-openButton">
              상세 열기 →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
