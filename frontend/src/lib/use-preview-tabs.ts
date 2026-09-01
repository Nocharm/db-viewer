"use client";

/** 미리보기 탭 상태 — 테이블 화면과 ERD 서랍이 같은 미리보기를 쓰기 위한 공용 훅.
 *
 * PreviewSection(필터 스테이징·조회·컬럼 편집·정렬·CSV·SQL 보기·분할)은 탭 배열과 네 개의
 * 콜백만 요구한다. 그 상태 기계를 화면마다 따로 들고 있으면 한쪽에만 기능이 붙는다 —
 * 여기 한 곳에 두고 두 화면이 같은 것을 쓴다.
 * Shared tab state so both the table screen and the ERD drawer mount the same
 * PreviewSection with all of its tools.
 */

import { useCallback, useState } from "react";

import type { PreviewTabState, RefetchOptions } from "@/components/browser/PreviewSection";
import { fetchObjectPreview } from "@/lib/api";

export interface PreviewTabsController {
  tabs: PreviewTabState[];
  activeId: number | null;
  splitId: number | null;
  setActiveId: (id: number) => void;
  setSplitId: (id: number | null) => void;
  /** 이미 열린 테이블이면 활성화만 — 중복 탭을 만들지 않는다.
   * highlight를 주면 그 컬럼을 계속 강조한다(조인 검증의 "지금 보는 컬럼") */
  open: (objectId: number, qname: string, highlight?: string | null) => void;
  /** 강조 컬럼만 교체 — 페어를 바꿔도 이미 받아온 행은 다시 조회하지 않는다 */
  setHighlight: (id: number, column: string | null) => void;
  close: (id: number) => void;
  /** 재조회 = 원본 소스에 새 질의 (필터·행수는 서버 WHERE/TOP으로 내려간다) */
  refetch: (id: number, opts: RefetchOptions) => void;
  patch: (
    id: number, patch: Partial<Pick<PreviewTabState, "hidden" | "sort" | "order">>,
  ) => void;
  /** 마지막 조회 실패 메시지 — 화면이 원하는 자리에 띄운다 */
  error: string | null;
}

export function usePreviewTabs(): PreviewTabsController {
  const [tabs, setTabs] = useState<PreviewTabState[]>([]);
  const [activeId, setActiveIdState] = useState<number | null>(null);
  const [splitId, setSplitId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback((id: number, opts: RefetchOptions) => {
    setTabs((cur) => cur.map((tab) => (tab.id === id ? { ...tab, loading: true } : tab)));
    fetchObjectPreview(id, opts.filters, opts.limit)
      .then((res) => setTabs((cur) => cur.map((tab) =>
        (tab.id === id ? { ...tab, data: res, loading: false } : tab))))
      .catch((e: Error) => {
        setError(e.message);
        setTabs((cur) => cur.map((tab) =>
          (tab.id === id ? { ...tab, loading: false } : tab)));
      });
  }, []);

  const setHighlight = useCallback((id: number, column: string | null) => {
    setTabs((cur) => cur.map((tab) => (tab.id === id ? { ...tab, highlight: column } : tab)));
  }, []);

  const open = useCallback((
    objectId: number, qname: string, highlight: string | null = null,
  ) => {
    setError(null);
    // 이미 열린 탭이면 활성화만 — 재조회하지 않는다(사용자가 걸어둔 필터·정렬이 날아간다).
    // 강조 컬럼은 최신 요청을 따른다 — 페어가 바뀌어 다시 열면 그 컬럼을 비춰야 한다
    if (tabs.some((tab) => tab.id === objectId)) {
      setHighlight(objectId, highlight);
    } else {
      setTabs((cur) => [...cur, {
        id: objectId, qname, data: null, loading: true,
        hidden: [], sort: null, order: [], highlight,
      }]);
      refetch(objectId, {});
    }
    setActiveIdState(objectId);
  }, [tabs, refetch, setHighlight]);

  const close = useCallback((id: number) => {
    setTabs((cur) => {
      const next = cur.filter((tab) => tab.id !== id);
      setActiveIdState((act) => (act === id ? next[next.length - 1]?.id ?? null : act));
      setSplitId((split) => (split === id ? null : split));
      return next;
    });
  }, []);

  const patch = useCallback((
    id: number, next: Partial<Pick<PreviewTabState, "hidden" | "sort" | "order">>,
  ) => {
    setTabs((cur) => cur.map((tab) => (tab.id === id ? { ...tab, ...next } : tab)));
  }, []);

  return {
    tabs, activeId, splitId,
    setActiveId: setActiveIdState, setSplitId,
    open, close, refetch, patch, setHighlight, error,
  };
}
