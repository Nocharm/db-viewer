"use client";

/** 공용 헤더 — 로고(홈 초기화)·내비·테마·언어·사용자 드롭다운 / shared header. */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ChatPanel } from "@/components/ChatPanel";
import { CaretDownIcon, LogoMark, MoonIcon, SunIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import { LogoutButton } from "@/components/logout-button";
import { useMe } from "@/components/providers";

function ThemeToggle() {
  const { t } = useI18n();
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
    <button className="icon-button" onClick={toggle} title={t("header.themeToggle")}
            data-testid="AppHeader-themeToggle">
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function LangToggle() {
  const { lang, toggleLang, t } = useI18n();
  return (
    <button className="icon-button" onClick={toggleLang} title={t("header.langToggle")}
            data-testid="AppHeader-langToggle">
      {lang === "ko" ? "EN" : "한"}
    </button>
  );
}

/** 사용자 이름 클릭 → 드롭다운 (로그아웃 포함) / user dropdown with sign-out. */
function UserMenu() {
  const me = useMe();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 바깥 클릭으로 닫기 / close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!me) return null;

  return (
    <div ref={rootRef} className="relative">
      {/* rounded-lg — 유틸 클러스터의 icon-button(8px radius)과 모서리를 맞춘다 */}
      <button
        className="pressable rounded-lg px-2 py-1 text-sm"
        style={{ color: "var(--slate)" }}
        onClick={() => setOpen((cur) => !cur)}
        data-testid="AppHeader-userMenuButton"
      >
        {me.name} <CaretDownIcon size={11} className="inline-block align-middle" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border py-1.5"
          style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
          data-testid="AppHeader-userMenu"
        >
          <div className="px-3 py-1.5">
            <div className="text-sm font-medium" style={{ color: "var(--ink)" }}>{me.name}</div>
            <div className="font-mono text-xs" style={{ color: "var(--muted)" }}>{me.login_id}</div>
          </div>
          {me.auth_enabled && (
            <>
              <div className="my-1 border-t" style={{ borderColor: "var(--hairline)" }} />
              <div className="px-1.5">
                <LogoutButton label={t("header.logout")} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const LINKS = [
  { href: "/", key: "nav.tables" as const },
  { href: "/verify", key: "nav.verify" as const },
  { href: "/erd", key: "nav.erd" as const },
  { href: "/parsing", key: "nav.parsing" as const },
];

// 비-MSSQL 소스에서 숨기는 링크 — 뷰 lineage 역추적·관계 온디맨드 발견은 MSSQL 전용
// (스펙 명시적 비목표). 백엔드도 검증·파싱 엔드포인트는 소스를 무시하고 항상 기본
// 소스를 본다 — 숨기지 않으면 엉뚱한 소스의 데이터를 보고 버그로 오해한다.
const MSSQL_ONLY_HREFS = new Set(["/verify", "/parsing"]);

export interface AppHeaderProps {
  children?: React.ReactNode;
  /** 선택된 소스 엔진 — "mssql"이 아니면 검증·파싱·AI 챗 진입점을 숨긴다.
   * 소스 선택을 추적하지 않는 화면(로그인·관리 등)은 생략해 기존 동작(전부 노출)을
   * 유지한다 / omit on pages that don't track source selection to keep everything visible. */
  sourceEngine?: string | null;
}

export function AppHeader({ children, sourceEngine }: AppHeaderProps) {
  const me = useMe();
  const { t } = useI18n();
  const pathname = usePathname();
  // undefined(생략)·null(기본 소스)·"mssql" 전부 노출 — 다른 엔진일 때만 숨긴다
  const isMssqlSource = sourceEngine === undefined || sourceEngine === null
    || sourceEngine === "mssql";
  const links = isMssqlSource ? LINKS : LINKS.filter((l) => !MSSQL_ONLY_HREFS.has(l.href));

  return (
    <header
      className="flex shrink-0 items-center gap-4 border-b px-4 py-2"
      style={{ borderColor: "var(--hairline)" }}
      data-testid="AppHeader-root"
    >
      {/* 풀 리로드 링크 — 클라이언트 상태(필터·선택)까지 전부 초기화하는 것이 목적이라
          Link 대신 <a>를 의도적으로 사용 / intentional hard reload to reset client state */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" title={t("header.homeTitle")}
         className="pressable flex items-center gap-2 rounded px-1 text-[15px] font-bold tracking-tight"
         style={{ color: "var(--ink)" }}
         data-testid="AppHeader-homeLink">
        <LogoMark size={18} />
        DB-viewer
      </a>
      <nav className="flex items-center gap-1">
        {links.map(({ href, key }) => {
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
              {t(key)}
            </Link>
          );
        })}
        {(me?.is_sysadmin || me?.auth_enabled === false) && (
          <Link href="/admin" className="pressable rounded px-2.5 py-1 text-sm"
                style={pathname === "/admin"
                  ? { background: "var(--soft-stone)", fontWeight: 500 }
                  : { color: "var(--slate)" }}
                data-testid="AppHeader-link-admin">
            {t("nav.admin")}
          </Link>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        {children}
        {isMssqlSource && <ChatPanel />}
        <LangToggle />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
