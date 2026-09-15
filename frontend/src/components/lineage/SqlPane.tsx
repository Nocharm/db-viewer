"use client";

/** 정의 SQL 패널 — 맵과 양방향으로 이어진다 (제안 3).
 *
 * 맵 → 여기: 강조된 줄이 뷰포트의 살짝 위(`SQL_ANCHOR_RATIO`)로 부드럽게 올라온다.
 * 여기 → 맵: 줄에 마우스를 올리면 그 줄에 등장하는 객체 이름을 부모에 알린다.
 * 연결 근거는 **이름 매칭**이라 같은 이름이 여러 소스에 있으면 함께 물든다(패널 하단 고지).
 * / two-way link with the map; matching is by identifier name, not parser offsets.
 */

import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";

import type { SqlToken } from "@/lib/preview-utils";
import {
  findNamesInLine, getSqlBottomPadding, getSqlScrollTop, splitSqlLines,
} from "@/lib/lineage-sql";

const TOKEN_STYLES: Record<SqlToken["type"], CSSProperties> = {
  keyword: { color: "var(--obj-view)", fontWeight: 600 },
  function: { color: "var(--code-fn)", fontWeight: 500 },
  identifier: { color: "var(--ink)" },
  string: { color: "var(--rel-confirmed)" },
  number: { color: "var(--rel-ai)" },
  comment: { color: "var(--muted)", fontStyle: "italic" },
  plain: { color: "var(--slate)" },
};

interface Props {
  sql: string;
  /** 맵에서 온 강조 대상 이름들(객체 qname·컬럼명) — 이 이름이 나오는 줄이 물든다 */
  highlightNames: string[];
  /** 줄 안에서 찾아볼 이름 후보 — 맵에 있는 노드·컬럼 전부 */
  candidateNames: string[];
  onHoverNames: (names: string[]) => void;
  height: number;
}

export function SqlPane({ sql, highlightNames, candidateNames, onHoverNames, height }: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const lines = useMemo(() => splitSqlLines(sql), [sql]);

  const hitLines = useMemo(() => {
    if (highlightNames.length === 0) return new Set<number>();
    return new Set(
      lines.filter((line) => findNamesInLine(line, highlightNames).length > 0)
        .map((line) => line.no),
    );
  }, [lines, highlightNames]);

  // 강조가 바뀌면 첫 강조 줄을 앵커 위치로 데려온다. 부모가 이미 호버를 지연시켜 보내므로
  // 여기서 또 미루지 않는다 — 여기서 미루면 지연이 두 번 쌓여 굼떠진다.
  const firstHit = hitLines.size > 0 ? Math.min(...hitLines) : null;
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null || firstHit === null) return;
    const row = scroller.querySelector<HTMLElement>(`[data-line="${firstHit}"]`);
    if (row === null) return;
    scroller.scrollTo({
      top: getSqlScrollTop(row.offsetTop, scroller.clientHeight, row.offsetHeight),
      behavior: "smooth",
    });
  }, [firstHit]);

  return (
    <div className="lineage-sql" style={{ height }} data-testid="SqlPane-root">
      <div ref={scrollerRef} className="lineage-sql__scroll scroll-area">
        <div style={{ paddingBottom: getSqlBottomPadding(height) }}>
          {lines.map((line) => {
            const hit = hitLines.has(line.no);
            return (
              <div
                key={line.no}
                data-line={line.no}
                className="lineage-sql__line"
                data-hit={hit || undefined}
                onMouseEnter={() => onHoverNames(findNamesInLine(line, candidateNames))}
                onMouseLeave={() => onHoverNames([])}
                data-testid={`SqlPane-line-${line.no}`}
              >
                <span className="lineage-sql__no">{line.no}</span>
                <code className="lineage-sql__code">
                  {line.tokens.length === 0
                    ? " "
                    : line.tokens.map((token, index) => (
                      <span key={index} style={TOKEN_STYLES[token.type]}>{token.text}</span>
                    ))}
                </code>
              </div>
            );
          })}
        </div>
      </div>
      <p className="lineage-sql__note">
        강조는 <b>이름 일치</b>다 — 파서가 남긴 위치가 아니라서 같은 이름 컬럼이 여러 소스에
        있으면 함께 물든다.
      </p>
    </div>
  );
}
