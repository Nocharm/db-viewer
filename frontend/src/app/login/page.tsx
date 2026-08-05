"use client";

/** 로그인 — silent 자동 시도 1회 → 실패 시 카드 (bpm 패턴 단순화). */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { LogoMark } from "@/components/icons";
import {
  clearAutoLoginTried,
  consumeReturnTo,
  markAutoLoginTried,
  wasAutoLoginTried,
} from "@/lib/auth-return";
import { signinRedirectFromLogin } from "@/lib/keycloak-login";

const AUTH_ENABLED = process.env.NEXT_PUBLIC_AUTH_ENABLED === "true";

export default function LoginPage() {
  // auth OFF면 즉시 홈으로 — KeycloakLogin은 AuthProvider 아래에서만 렌더된다
  return AUTH_ENABLED ? <KeycloakLogin /> : <DevRedirect />;
}

function DevRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return null;
}

function KeycloakLogin() {
  const auth = useAuth();
  const router = useRouter();
  const [showCard, setShowCard] = useState(false);

  useEffect(() => {
    if (auth.isLoading) return;
    if (auth.isAuthenticated) {
      clearAutoLoginTried();
      router.replace(consumeReturnTo());
      return;
    }
    if (auth.error || wasAutoLoginTried()) {
      setShowCard(true); // silent 실패 — 수동 로그인 카드 / fallback to manual card
      return;
    }
    markAutoLoginTried();
    void signinRedirectFromLogin({ promptNone: true }).catch(() => setShowCard(true));
  }, [auth.isLoading, auth.isAuthenticated, auth.error, router]);

  // 두 상태가 같은 카드 셸 공유 — silent 실패 → 버튼 전환 시 레이아웃 점프 없음
  return (
    <div className="flex h-screen items-center justify-center p-4">
      <div
        className="w-full max-w-sm rounded-2xl border p-10 text-center"
        style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
        data-testid="LoginPage-card"
      >
        <LogoMark size={40} className="mx-auto mb-5 block" />
        <p className="text-3xl font-bold tracking-tight" style={{ color: "var(--ink)" }}>
          DB-viewer
        </p>
        <p className="mt-1 text-sm" style={{ color: "var(--slate)" }}>
          DB 스키마 · 관계 탐색기
        </p>
        {showCard ? (
          <>
            <button
              className="btn-primary btn-primary--lg mt-8"
              onClick={() => {
                clearAutoLoginTried();
                void signinRedirectFromLogin();
              }}
              data-testid="LoginPage-loginButton"
            >
              Keycloak으로 로그인
            </button>
            <p className="mt-4 text-xs" style={{ color: "var(--muted)" }}>
              사내 Keycloak SSO 계정으로 로그인합니다
            </p>
          </>
        ) : (
          <p className="mt-8 text-sm" style={{ color: "var(--muted)" }}
             data-testid="LoginPage-checking">
            로그인 확인 중…
          </p>
        )}
      </div>
    </div>
  );
}
