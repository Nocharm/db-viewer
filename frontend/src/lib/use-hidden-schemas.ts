"use client";

/** 컬럼을 감춘 스키마 집합 — 진입 차단·컬럼 숨김 판단용 / the hidden-schema set.
 *
 * use-preview-allowlist와 기본값의 안전 방향이 반대다. 저쪽은 조회 실패 시 빈 집합이
 * "전부 잠금"이라 그 자체로 안전하지만, 여기서 빈 집합은 "전부 공개"다 — 그래서 실제
 * 차단은 백엔드가 한다(컬럼을 아예 안 내려주고 검증도 403). 이 훅은 링크를 죽이고
 * 배지를 붙이는 표시용이다.
 */

import { useEffect, useState } from "react";

import { fetchHiddenSchemas } from "@/lib/api";

// 런타임에 바뀌지 않는 설정값이라 모듈 단위로 캐시한다 — 관계 목록의 링크마다 훅을 부르므로
// (TableDetail.TableRef) 캐시가 없으면 같은 응답을 수십 번 받아온다.
// / a config value that never changes at runtime, cached per module: the relation lists call
//   this once per link, and without the cache that is dozens of identical requests.
let cached: Set<string> | null = null;
let inFlight: Promise<Set<string>> | null = null;

function loadHiddenSchemas(): Promise<Set<string>> {
  if (cached) return Promise.resolve(cached);
  inFlight ??= fetchHiddenSchemas()
    .then((res) => {
      cached = new Set(res.items);
      return cached;
    })
    .catch((e: Error) => {
      // 다음 마운트에서 다시 시도할 수 있게 실패는 캐시하지 않는다
      inFlight = null;
      throw e;
    });
  return inFlight;
}

export function useHiddenSchemas(): Set<string> {
  const [hidden, setHidden] = useState<Set<string>>(() => cached ?? new Set());

  useEffect(() => {
    if (cached) return;
    loadHiddenSchemas()
      .then(setHidden)
      .catch((e: Error) => {
        // 조용히 넘기면 왜 링크가 살아 있는지 알 수 없다 — 콘솔에 남긴다
        console.error("hidden schemas fetch failed", e);
      });
  }, []);

  return hidden;
}

/** qname("schema.table")의 스키마가 감춰졌는가 — 백엔드가 소문자로 내려주므로 맞춰 비교. */
export function isQnameHidden(qname: string, hidden: Set<string>): boolean {
  return hidden.has(qname.split(".", 1)[0].toLowerCase());
}
