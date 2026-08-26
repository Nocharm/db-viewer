/** 인증 기능 플래그 한 곳 정의 / the single definition of the auth feature flags.
 *  프로바이더 마운트 조건과 useAuth() 호출부의 조건이 어긋나면 그 배포는 통째로 크래시한다 —
 *  두 파일이 각자 선언하면 한쪽만 바뀌는 드리프트를 막을 방법이 없다. */

export const AUTH_ENABLED = process.env.NEXT_PUBLIC_AUTH_ENABLED === "true";
// 개발 스택은 이 값을 비운다 — Keycloak 없이 LDAP 폼만 켤 수 있다.
// AuthProvider(및 그 아래 useAuth() 호출부)는 AUTH_ENABLED와 함께 이 조건에서만 마운트된다
export const KEYCLOAK_ENABLED = (process.env.NEXT_PUBLIC_KEYCLOAK_ISSUER ?? "") !== "";
// 로그인 화면의 사번·비밀번호 폼을 켠다 — Keycloak과 독립적으로 켜고 끈다
export const LDAP_ENABLED = process.env.NEXT_PUBLIC_LDAP_LOGIN_ENABLED === "true";
