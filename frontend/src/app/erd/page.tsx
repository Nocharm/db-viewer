"use client";

/** 읽기 전용 ERD 화면 — 확정된 관계 전체 그래프 / the read-only whole-graph ERD page. */

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { AppHeader } from "@/components/AppHeader";
import { ErdViewer } from "@/components/erd/ErdViewer";

export default function ErdPage() {
  return (
    <Suspense fallback={null}>
      <ErdPageInner />
    </Suspense>
  );
}

function ErdPageInner() {
  const params = useSearchParams();
  const focusParam = params.get("focus");
  // 빈 문자열("")은 truthy 가드로 걸러진다 — Number("")===0이라 정수 검사만으론 안 잡힌다
  const parsedFocus = focusParam ? Number(focusParam) : Number.NaN;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <AppHeader />
      <main className="relative min-h-0 flex-1">
        <ErdViewer
          focusId={Number.isInteger(parsedFocus) ? parsedFocus : null}
          focusLabel={params.get("label")}
        />
      </main>
    </div>
  );
}
