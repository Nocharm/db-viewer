"use client";

/** 다이어그램 로딩 고스트 — 가짜 그래프(카드 + 흐르는 점선 + 시머)로 "그래프가 오고 있다"를 보인다.
 * 단색 펄스는 다크 표면에서 빈 화면과 구분되지 않았다(실측). 계보 맵·ERD 공용.
 * / a placeholder graph instead of a flat pulse, which was invisible on the dark surface. */

interface Props {
  caption: string;
  testId: string;
}

/** 카드 좌표(%·px) — 3레인 6장, 뷰포트 폭에 따라 레인 x만 늘어난다 */
const CARDS: { lane: number; top: number }[] = [
  { lane: 0, top: 40 }, { lane: 0, top: 120 },
  { lane: 1, top: 80 },
  { lane: 2, top: 30 }, { lane: 2, top: 100 }, { lane: 2, top: 170 },
];
const LANE_LEFT = ["8%", "40%", "72%"];
const CARD_W = 150;
const CARD_H = 44;

export function GhostGraph({ caption, testId }: Props) {
  return (
    <div className="ghost-graph" role="status" aria-label={caption} data-testid={testId}>
      <svg className="ghost-graph__lines" aria-hidden="true">
        {/* 레인 0·2의 카드에서 레인 1의 카드로 — 좌표는 CSS 퍼센트와 같은 비율 */}
        {CARDS.filter((card) => card.lane !== 1).map((card, index) => {
          const from = card.lane === 0;
          const x1 = from ? `calc(${LANE_LEFT[0]} + ${CARD_W}px)` : LANE_LEFT[1];
          const x2 = from ? LANE_LEFT[1] : LANE_LEFT[2];
          const y1 = (from ? card.top : CARDS[2].top) + CARD_H / 2;
          const y2 = (from ? CARDS[2].top : card.top) + CARD_H / 2;
          return (
            <line key={index} x1={x1} y1={y1} x2={from ? x2 : `calc(${x1} + ${CARD_W}px)`} y2={y2}
                  x1-lane={card.lane} />
          );
        })}
      </svg>
      {CARDS.map((card, index) => (
        <div key={index} className="ghost-graph__card"
             style={{ left: LANE_LEFT[card.lane], top: card.top, width: CARD_W, height: CARD_H }} />
      ))}
      <div className="ghost-graph__caption"><i />{caption}</div>
    </div>
  );
}
