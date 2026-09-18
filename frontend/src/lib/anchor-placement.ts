/** 포인터 기준 카드 배치 — 가장자리에서는 밀어 넣지 않고 **반전**한다.
 * 밀어 넣으면 카드가 포인터에서 떨어져 "내가 누른 것"이라는 연결이 끊긴다(bpm 서브메뉴 규칙).
 * / flip across the pointer at the viewport edge instead of clamping, so the card stays attached. */

export interface Placement {
  left: number;
  top: number;
  /** 반전 여부 — 팝 애니메이션의 transform-origin이 포인터 쪽을 향하게 한다 */
  flippedX: boolean;
  flippedY: boolean;
}

export interface PlacementOptions {
  /** 포인터에서 띄우는 거리(px) — 카드 모서리가 포인터 바로 옆에 선다 */
  offset?: number;
  /** 뷰포트 가장자리 여백(px) */
  margin?: number;
}

export function placeAtPointer(
  pointerX: number, pointerY: number,
  width: number, height: number,
  viewportWidth: number, viewportHeight: number,
  options: PlacementOptions = {},
): Placement {
  const offset = options.offset ?? 12;
  const margin = options.margin ?? 8;
  let left = pointerX + offset;
  let top = pointerY + offset;
  let flippedX = false;
  let flippedY = false;
  if (left + width > viewportWidth - margin) {
    left = pointerX - offset - width;
    flippedX = true;
  }
  if (top + height > viewportHeight - margin) {
    top = pointerY - offset - height;
    flippedY = true;
  }
  // 반전해도 안 들어가는 작은 뷰포트 — 마지막 수단으로만 여백 안쪽에 붙인다
  return {
    left: Math.max(margin, left),
    top: Math.max(margin, top),
    flippedX,
    flippedY,
  };
}
