"use client";

/** 등록된 소스 목록 — 선택기와 헤더의 엔진 판별이 함께 쓴다.
 *  The registered source list; shared by the picker and the header's engine check.
 *
 * 관리용 `GET /api/sources`가 아니라 최소 목록(`/api/sources/options`)을 읽는다 — 관리용은
 * sysadmin 전용이라 일반 사용자가 403을 받고, 그 403을 빈 목록으로 삼키면 선택기가 영영
 * 안 떠서 멀티 소스 기능 자체가 관리자에게만 보인다. 스펙 비목표: 소스별 사용자 권한
 * 분리는 하지 않는다 — 앱에 들어온 사람은 등록된 모든 소스를 본다.
 * / reads the minimal list, not the sysadmin-only admin list: swallowing that 403 hid the
 * whole feature from regular users, contradicting the spec's "everyone sees every source".
 */

import { useEffect, useState } from "react";

import { fetchSourceOptions, type SourceOption } from "@/lib/api";

export function useDataSources(): SourceOption[] {
  const [sources, setSources] = useState<SourceOption[]>([]);

  useEffect(() => {
    fetchSourceOptions()
      .then((res) => setSources(res.items.filter((item) => item.is_enabled)))
      .catch(() => setSources([]));
  }, []);

  return sources;
}
