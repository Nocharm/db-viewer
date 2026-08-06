"use client";

/** 미리보기 허용 qname 집합 — 버튼 활성 판단용 / the preview allowlist, for enabling buttons.
 *
 * 화면이 들고 있는 건 힌트다: 실제 차단은 서버가 한다(403). 그래서 조회에 실패하면
 * 비어 있는 집합, 즉 "전부 잠금"으로 둔다 — 열어두는 쪽으로 기울지 않게.
 */

import { useEffect, useState } from "react";

import { fetchPreviewAllowlist } from "@/lib/api";

export function usePreviewAllowlist(): Set<string> {
  const [allowed, setAllowed] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchPreviewAllowlist()
      .then((res) => setAllowed(new Set(res.items)))
      .catch((e: Error) => {
        // 화면 전체를 막을 일은 아니지만 조용히 넘기지도 않는다 — 콘솔에 남긴다
        console.error("preview allowlist fetch failed", e);
      });
  }, []);

  return allowed;
}
