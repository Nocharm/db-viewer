"use client";

/** 예전 주소 호환 — 감사 로그는 관리 콘솔의 다섯 번째 탭이 됐다. 딥링크·안내서 링크가 깨지지
 * 않게 ?tab=audit로 보낸다. / legacy route: the audit log now lives in the admin console tab. */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AuditRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/admin?tab=audit");
  }, [router]);
  return null;
}
