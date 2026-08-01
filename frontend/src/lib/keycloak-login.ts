/** Keycloak redirect helpers — /login 화면 전용 (bpm 패턴). / manual UserManager for the login page. */

import { UserManager } from "oidc-client-ts";

function makeManager(): UserManager {
  return new UserManager({
    authority: process.env.NEXT_PUBLIC_KEYCLOAK_ISSUER ?? "",
    client_id: process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID ?? "",
    redirect_uri: window.location.origin,
    // secure context면 PKCE 자동 활성 — providers.tsx와 동일 판정 유지 필수
    disablePKCE: !window.isSecureContext,
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
