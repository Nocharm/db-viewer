"use client";

/** 토큰 색을 입힌 SQL 블록 — 히트 컬럼 토큰은 배경으로 표시 / tokenized SQL with an optional hit mark. */

import type { CSSProperties } from "react";

import { tokenizeSql, type SqlToken } from "@/lib/preview-utils";
import { markHitTokens } from "@/lib/view-definition";

// PreviewSqlButton과 같은 색 규칙 — 소비자가 둘이라 작은 표를 나눠 갖는다 / same palette as the preview SQL
const TOKEN_STYLES: Record<SqlToken["type"], CSSProperties> = {
  keyword: { color: "var(--obj-view)", fontWeight: 600 },
  function: { color: "var(--code-fn)", fontWeight: 500 },
  identifier: { color: "var(--ink)" },
  string: { color: "var(--rel-confirmed)" },
  number: { color: "var(--rel-ai)" },
  comment: { color: "var(--muted)", fontStyle: "italic" },
  plain: { color: "var(--slate)" },
};

const HIT_STYLE: CSSProperties = {
  background: "color-mix(in srgb, var(--primary) 35%, transparent)",
  borderRadius: 3,
};

interface SqlCodeProps {
  sql: string;
  highlightColumn?: string | null;
}

export function SqlCode({ sql, highlightColumn = null }: SqlCodeProps) {
  const tokens = markHitTokens(tokenizeSql(sql), highlightColumn);
  return (
    <pre
      className="scroll-area m-0 max-h-[50vh] overflow-auto whitespace-pre-wrap rounded p-3 font-mono text-xs leading-relaxed"
      style={{ background: "var(--surface-elevated)" }}
      data-testid="SqlCode-root"
    >
      {tokens.map((token, index) => (
        <span
          key={index}
          style={token.hit ? { ...TOKEN_STYLES[token.type], ...HIT_STYLE } : TOKEN_STYLES[token.type]}
          data-testid={token.hit ? "SqlCode-hit" : undefined}
        >
          {token.text}
        </span>
      ))}
    </pre>
  );
}
