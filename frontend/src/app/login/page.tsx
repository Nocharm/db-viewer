"use client";

/** 로그인 — silent 자동 시도 1회 → 실패 시 카드 (bpm 패턴 단순화). */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

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

  return (
    <div className="flex h-screen items-center justify-center">
      {showCard ? (
        <div className="rounded-2xl border p-8 text-center"
             style={{ borderColor: "var(--hairline)" }}>
          <p className="erd-node__header mb-4 !border-0 !p-0">db-viewer</p>
          <button
            className="rounded-full px-6 py-2 text-sm text-white"
            style={{ background: "var(--primary)" }}
            onClick={() => {
              clearAutoLoginTried();
              void signinRedirectFromLogin();
            }}
            data-testid="LoginPage-loginButton"
          >
            Keycloak으로 로그인
          </button>
        </div>
      ) : (
        <p style={{ color: "var(--muted)" }}>로그인 확인 중…</p>
      )}
    </div>
  );
}
