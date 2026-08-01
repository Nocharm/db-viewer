"use client";

/** 공용 헤더 — 내비게이션 + 테마 토글 + 사용자 / shared header with nav, theme toggle, user. */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { LogoutButton } from "@/components/logout-button";
import { useMe } from "@/components/providers";

function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (current === "light") setTheme("light");
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("dbv.theme", next);
    } catch {
      // localStorage 차단 환경 — 세션 한정 토글 / session-only toggle
    }
  };

  return (
    <button className="icon-button" onClick={toggle} title="다크/라이트 전환"
            data-testid="AppHeader-themeToggle">
      {theme === "dark" ? "☀︎" : "☾"}
    </button>
  );
}

const LINKS = [
  { href: "/", label: "테이블" },
  { href: "/erd", label: "ERD" },
  { href: "/parsing", label: "파싱 지표" },
];

export function AppHeader({ children }: { children?: React.ReactNode }) {
  const me = useMe();
  const pathname = usePathname();

  return (
    <header
      className="flex shrink-0 items-center gap-4 border-b px-4 py-2"
      style={{ borderColor: "var(--hairline)" }}
      data-testid="AppHeader-root"
    >
      <span className="flex items-center gap-2 text-[15px] font-bold tracking-tight"
            style={{ color: "var(--ink)" }}>
        <span className="logo-mark" aria-hidden />
        db-viewer
      </span>
      <nav className="flex items-center gap-1">
        {LINKS.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className="pressable rounded px-2.5 py-1 text-sm"
              style={active
                ? { background: "var(--soft-stone)", fontWeight: 500 }
                : { color: "var(--slate)" }}
              data-testid={`AppHeader-link-${href === "/" ? "browser" : href.slice(1)}`}
            >
              {label}
            </Link>
          );
        })}
        {(me?.is_sysadmin || me?.auth_enabled === false) && (
          <Link href="/admin" className="pressable rounded px-2.5 py-1 text-sm"
                style={pathname === "/admin"
                  ? { background: "var(--soft-stone)", fontWeight: 500 }
                  : { color: "var(--slate)" }}
                data-testid="AppHeader-link-admin">
            관리
          </Link>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        {children}
        <ThemeToggle />
        {me && (
          <span className="text-sm" style={{ color: "var(--slate)" }}
                data-testid="AppHeader-userName">
            {me.name}
          </span>
        )}
        {me?.auth_enabled && <LogoutButton />}
      </div>
    </header>
  );
}
