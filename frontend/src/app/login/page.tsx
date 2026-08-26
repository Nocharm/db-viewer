"use client";

/** 로그인 — Keycloak(silent 자동 시도) + LDAP 사번·비밀번호 폼, 독립적으로 켜고 끈다. */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { LogoMark } from "@/components/icons";
import { loginWithLdap, setAuthToken } from "@/lib/api";
import {
  clearAutoLoginTried,
  consumeReturnTo,
  markAutoLoginTried,
  wasAutoLoginTried,
} from "@/lib/auth-return";
import { signinRedirectFromLogin } from "@/lib/keycloak-login";
import { storeSession } from "@/lib/session-token";

const AUTH_ENABLED = process.env.NEXT_PUBLIC_AUTH_ENABLED === "true";
const LDAP_ENABLED = process.env.NEXT_PUBLIC_LDAP_LOGIN_ENABLED === "true";
const KEYCLOAK_ENABLED = (process.env.NEXT_PUBLIC_KEYCLOAK_ISSUER ?? "") !== "";

export default function LoginPage() {
  // auth OFF면 즉시 홈으로 — KeycloakSection은 AuthProvider 아래에서만 렌더된다
  return AUTH_ENABLED ? <LoginCard /> : <DevRedirect />;
}

function DevRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return null;
}

function LoginCard() {
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
        {KEYCLOAK_ENABLED && <KeycloakSection />}
        {LDAP_ENABLED && <LdapSection />}
        {!KEYCLOAK_ENABLED && !LDAP_ENABLED && (
          <p
            className="mt-8 text-sm"
            style={{ color: "var(--error)" }}
            data-testid="LoginPage-noAuthMethod"
          >
            로그인 수단이 설정되지 않았습니다 — 관리자에게 문의하세요
          </p>
        )}
      </div>
    </div>
  );
}

/** silent 자동 시도 1회 → 실패 시 버튼 (bpm 패턴). useAuth()를 쓰므로 AuthProvider 아래에서만
 *  마운트된다 — KEYCLOAK_ENABLED일 때만 렌더되고, 그때만 Providers가 AuthProvider를 켠다. */
function KeycloakSection() {
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
      setShowCard(true); // silent 실패 — 수동 로그인 버튼으로 전환 / fallback to manual button
      return;
    }
    markAutoLoginTried();
    void signinRedirectFromLogin({ promptNone: true }).catch(() => setShowCard(true));
  }, [auth.isLoading, auth.isAuthenticated, auth.error, router]);

  if (!showCard) {
    return (
      <p
        className="mt-8 text-sm"
        style={{ color: "var(--muted)" }}
        data-testid="LoginPage-checking"
      >
        로그인 확인 중…
      </p>
    );
  }
  return (
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
  );
}

/** 사번·비밀번호 폼 — 성공 시 세션을 저장하고 토큰을 즉시 주입한다. */
function LdapSection() {
  const router = useRouter();
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleLdapSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await loginWithLdap(loginId, password);
      storeSession({
        token: res.access_token, expiresAt: res.expires_at,
        loginId: res.login_id, name: res.name,
      });
      setAuthToken(res.access_token);
      router.replace(consumeReturnTo());
    } catch (e) {
      setError(e instanceof Error ? e.message : "로그인에 실패했습니다");
    } finally {
      setPassword("");   // 실패해도 비밀번호를 상태에 남기지 않는다
      setPending(false);
    }
  }

  return (
    <form
      className="mt-8 space-y-3 text-left"
      onSubmit={(e) => void handleLdapSubmit(e)}
      data-testid="LoginPage-ldapForm"
    >
      <input
        className="w-full rounded border px-3 py-1.5 text-sm"
        style={{ borderColor: "var(--border-light)" }}
        placeholder="사번"
        value={loginId}
        onChange={(e) => setLoginId(e.target.value)}
        autoComplete="username"
        data-testid="LoginPage-loginIdInput"
      />
      <input
        className="w-full rounded border px-3 py-1.5 text-sm"
        style={{ borderColor: "var(--border-light)" }}
        type="password"
        placeholder="비밀번호"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        data-testid="LoginPage-passwordInput"
      />
      {error && (
        <p className="text-xs" style={{ color: "var(--error)" }} data-testid="LoginPage-ldapError">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="btn-primary btn-primary--lg"
        disabled={pending}
        data-testid="LoginPage-ldapSubmit"
      >
        로그인
      </button>
    </form>
  );
}
