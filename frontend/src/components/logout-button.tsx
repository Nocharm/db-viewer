"use client";

/** 로그아웃 버튼 — AuthProvider 아래에서만 렌더 / render only when auth is enabled. */

import { useLogout } from "@/components/providers";

export function LogoutButton() {
  const logout = useLogout();
  return (
    <button className="icon-button" onClick={logout} data-testid="Home-logoutButton">
      로그아웃
    </button>
  );
}
