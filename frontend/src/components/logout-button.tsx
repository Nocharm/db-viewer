"use client";

/** 로그아웃 버튼 — AuthProvider 아래에서만 렌더 / render only when auth is enabled. */

import { useLogout } from "@/components/providers";

export function LogoutButton({ label = "로그아웃" }: { label?: string }) {
  const logout = useLogout();
  return (
    <button
      className="pressable w-full rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--soft-stone)]"
      onClick={logout}
      data-testid="Home-logoutButton"
    >
      {label}
    </button>
  );
}
