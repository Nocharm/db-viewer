/** Keycloak redirect helpers — /login 화면 전용 (bpm 패턴). / manual UserManager for the login page. */

import { UserManager } from "oidc-client-ts";

function makeManager(): UserManager {
  return new UserManager({
    authority: process.env.NEXT_PUBLIC_KEYCLOAK_ISSUER ?? "",
    client_id: process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID ?? "",
    redirect_uri: window.location.origin,
    // 평문 HTTP(insecure context)에선 crypto.subtle 불가 — providers.tsx와 반드시 동일해야
    // 토큰 교환이 깨지지 않는다. HTTPS 전환 시 양쪽 모두 제거해 PKCE 복원할 것.
    disablePKCE: true,
  });
}

export async function signinRedirectFromLogin(options?: { promptNone?: boolean }): Promise<void> {
  await makeManager().signinRedirect(
    options?.promptNone ? { prompt: "none" } : undefined,
  );
}

export async function signoutAllSessions(idTokenHint?: string): Promise<void> {
  await makeManager().signoutRedirect({
    id_token_hint: idTokenHint,
    post_logout_redirect_uri: `${window.location.origin}/login`,
  });
}
