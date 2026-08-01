"use client";

/** 인증 프로바이더 체인 — OIDC → 화이트리스트 게이트 (bpm 패턴 + 화이트리스트 확장). */

import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { AuthProvider, useAuth } from "react-oidc-context";

import { fetchMe, setAuthToken, type Me } from "@/lib/api";
import { markAutoLoginTried, saveReturnTo } from "@/lib/auth-return";

const AUTH_ENABLED = process.env.NEXT_PUBLIC_AUTH_ENABLED === "true";

const MeContext = createContext<Me | null>(null);
export function useMe(): Me | null {
  return useContext(MeContext);
}

/** SSR/하이드레이션 가드 / hydration guard (bpm useMounted). */
function useMounted(): boolean {
  return useSyncExternalStore(() => () => {}, () => true, () => false);
}

function buildOidcConfig() {
  return {
    authority: process.env.NEXT_PUBLIC_KEYCLOAK_ISSUER ?? "",
    client_id: process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID ?? "",
    redirect_uri: window.location.origin,
    // 평문 HTTP(insecure context)에선 crypto.subtle이 없어 PKCE 자체가 불가.
    // secure context면 자동으로 PKCE 활성 — HTTPS 전환 시 코드 수정 불필요.
    // keycloak-login.ts와 반드시 동일 판정이어야 토큰 교환이 깨지지 않는다.
    disablePKCE: !window.isSecureContext,
    onSigninCallback: () => {
      window.history.replaceState({}, document.title, window.location.pathname);
    },
  };
}

function MeGate({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    fetchMe().then(setMe).catch((e) => setError(e.message));
  }, []);

  if (pathname === "/login") return children;
  if (error) {
    return (
      <p className="p-6" style={{ color: "var(--error)" }} data-testid="MeGate-errorText">
        사용자 정보를 불러오지 못했습니다: {error}
      </p>
    );
  }
  if (!me) return null;
  if (!me.whitelisted) {
    // 화이트리스트 미등록 — 전 API가 403이므로 안내 화면으로 차단
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="rounded-xl border p-8 text-center"
             style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
             data-testid="MeGate-notWhitelisted">
          <p className="mb-2 text-lg font-semibold" style={{ color: "var(--ink)" }}>
            접근 권한이 없습니다
          </p>
          <p className="text-sm" style={{ color: "var(--slate)" }}>
            <span className="font-mono">{me.login_id}</span> 계정은 화이트리스트에 없습니다.
            <br />관리자에게 등록을 요청하세요.
          </p>
        </div>
      </div>
    );
  }
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // 렌더 단계 동기 반영 — 자식 fetch가 effect보다 먼저 나가는 401 레이스 방지 (bpm)
  setAuthToken(auth.user?.access_token ?? null);

  useEffect(() => {
    if (!auth.isLoading && !auth.isAuthenticated && pathname !== "/login") {
      saveReturnTo(pathname);
      router.replace("/login");
    }
  }, [auth.isLoading, auth.isAuthenticated, pathname, router]);

  if (pathname === "/login") return children;
  if (auth.isLoading || !auth.isAuthenticated) return null;
  return <MeGate>{children}</MeGate>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const mounted = useMounted();
  if (!mounted) return null;
  if (!AUTH_ENABLED) return <MeGate>{children}</MeGate>;
  return (
    <AuthProvider {...buildOidcConfig()}>
      <AuthGate>{children}</AuthGate>
    </AuthProvider>
  );
}

/** 로컬 로그아웃 — Keycloak SSO 세션은 유지 (bpm 패턴) / local logout, SSO stays. */
export function useLogout(): () => void {
  const auth = useAuth();
  const router = useRouter();
  return () => {
    markAutoLoginTried(); // /login 재진입 시 자동 로그인 루프 방지
    void auth.removeUser().then(() => router.replace("/login"));
  };
}
