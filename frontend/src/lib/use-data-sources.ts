"use client";

/** 등록된 소스 목록 — 선택기와 헤더의 엔진 판별이 함께 쓴다.
 *  The registered source list; shared by the picker and the header's engine check.
 *
 * sysadmin 전용 API라 일반 사용자는 403을 받는다 — 그 경우 빈 목록으로 두어 선택기가
 * 숨고 화면은 기본 소스로 계속 동작한다 / non-sysadmin users get a 403 here; treat that
 * as no sources so the picker hides and the page falls back to the default source.
 */

import { useEffect, useState } from "react";

import { fetchDataSources, type DataSourceItem } from "@/lib/api";

export function useDataSources(): DataSourceItem[] {
  const [sources, setSources] = useState<DataSourceItem[]>([]);

  useEffect(() => {
    fetchDataSources()
      .then((res) => setSources(res.items.filter((item) => item.is_enabled)))
      .catch(() => setSources([]));
  }, []);

  return sources;
}
