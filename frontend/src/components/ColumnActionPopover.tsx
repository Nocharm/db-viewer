"use client";

/** 컬럼 클릭 → 조인 검증으로 갈지 묻는 확인 카드. 포인터 옆에 뜨고 가장자리에서 반전한다.
 * 바로 이동하지 않는 이유: 다이어그램의 컬럼 행은 "보는" 요소이기도 해서, 클릭 한 번에
 * 화면을 떠나면 맵 컨텍스트를 잃는다. ERD·계보 맵 공용.
 * / confirm before leaving for /verify; shared by the ERD and the lineage maps. */

import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";

import { useI18n } from "@/components/i18n";
import { placeAtPointer } from "@/lib/anchor-placement";

/** 렌더 전 뷰포트 판정용 상한(px) — 실측보다 조금 넉넉하게 */
const CARD_WIDTH = 264;
const CARD_HEIGHT = 150;

export interface ColumnPick {
  objectId: number;
  qname: string;
  column: string;
  /** 클릭 지점(화면 좌표) */
  pointerX: number;
  pointerY: number;
}

interface Props {
  pick: ColumnPick;
  /** /verify는 기본(MSSQL) 소스 전용 — 아니면 잠금 안내만 보인다 */
  isMssqlSource: boolean;
  onClose: () => void;
}

export function ColumnActionPopover({ pick, isMssqlSource, onClose }: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const placement = useMemo(() => placeAtPointer(
    pick.pointerX, pick.pointerY, CARD_WIDTH, CARD_HEIGHT,
    window.innerWidth, window.innerHeight,
  ), [pick.pointerX, pick.pointerY]);

  // Esc·바깥 mousedown(캡처 — React Flow가 노드 위 mousedown 전파를 끊는다)·스크롤로 닫는다
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const go = () => {
    onClose();
    router.push(
      `/verify?src=${pick.objectId}&srcLabel=${encodeURIComponent(pick.qname)}`
      + `&srcCol=${encodeURIComponent(pick.column)}`);
  };

  return (
    <div
      ref={rootRef}
      className="confirm-card"
      style={{
        left: placement.left,
        top: placement.top,
        "--origin-x": placement.flippedX ? "right" : "left",
        "--origin-y": placement.flippedY ? "bottom" : "top",
      } as React.CSSProperties}
      role="dialog"
      aria-label={t("columnpick.title")}
      data-testid="ColumnActionPopover-root"
      data-flipped-x={placement.flippedX || undefined}
      data-flipped-y={placement.flippedY || undefined}
    >
      <div className="confirm-card__title">
        {isMssqlSource ? t("columnpick.title") : t("columnpick.lockedTitle")}
      </div>
      <span className="confirm-card__chip" title={`${pick.qname}.${pick.column}`}>
        <small>{pick.qname}</small>.{pick.column}
      </span>
      <p className="confirm-card__hint">
        {isMssqlSource ? t("columnpick.hint") : t("nav.mssqlOnly")}
      </p>
      <div className="confirm-card__actions">
        <button className="btn-secondary !py-1 text-xs" onClick={onClose}
                data-testid="ColumnActionPopover-cancelButton">
          {t("columnpick.cancel")}
        </button>
        {isMssqlSource && (
          <button className="btn-primary !py-1 text-xs" onClick={go} autoFocus
                  data-testid="ColumnActionPopover-goButton">
            {t("columnpick.go")}
          </button>
        )}
      </div>
    </div>
  );
}
