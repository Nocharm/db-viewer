"use client";

/** 관리 콘솔 상단 탭 바 — 아이콘·라벨, 올린 탭의 한 줄 설명, ←/→ 키 이동. 상태는 부모가
 * 가진다(URL ?tab=과 동기화). 감사 로그는 별도 화면이라 탭이 아닌 링크지만 같은 줄에 둔다.
 * Controlled tab strip for the admin console; the audit log is a link styled like a tab. */

import { useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";

import { useI18n } from "@/components/i18n";
import {
  ClipboardIcon,
  DatabaseIcon,
  ShieldIcon,
  SparklesIcon,
  UsersIcon,
} from "@/components/icons";
import { ADMIN_TAB_IDS, getNeighbourTab, type AdminTabId } from "@/lib/admin-tabs";
import type { MessageKey } from "@/lib/i18n";

interface TabMeta {
  label: MessageKey;
  desc: MessageKey;
  icon: ReactNode;
}

const TAB_META: Record<AdminTabId, TabMeta> = {
  sources: {
    label: "admin.tab.sources", desc: "admin.tab.sourcesDesc", icon: <DatabaseIcon size={15} />,
  },
  access: {
    label: "admin.tab.access", desc: "admin.tab.accessDesc", icon: <ShieldIcon size={15} />,
  },
  ai: { label: "admin.tab.ai", desc: "admin.tab.aiDesc", icon: <SparklesIcon size={15} /> },
  users: { label: "admin.tab.users", desc: "admin.tab.usersDesc", icon: <UsersIcon size={15} /> },
};

/** 탭 버튼의 DOM id — 패널의 aria-labelledby가 같은 규칙으로 가리킨다 / shared id scheme */
export function getAdminTabId(tab: AdminTabId): string {
  return `admin-tab-${tab}`;
}

export function getAdminPanelId(tab: AdminTabId): string {
  return `admin-panel-${tab}`;
}

interface AdminTabsProps {
  active: AdminTabId;
  onChange: (tab: AdminTabId) => void;
}

export function AdminTabs({ active, onChange }: AdminTabsProps) {
  const { t } = useI18n();
  // 마우스 또는 포커스가 올라간 탭 — 힌트 줄이 그 탭의 설명으로 바뀐다
  const [hovered, setHovered] = useState<AdminTabId | null>(null);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = getNeighbourTab(active, e.key === "ArrowLeft" ? -1 : 1);
    onChange(next);
    // 포커스도 따라간다 — 화살표로 옮긴 탭이 키보드 포커스를 잃지 않게 (roving tabindex)
    document.getElementById(getAdminTabId(next))?.focus();
  };

  return (
    <div className="mb-4" data-testid="AdminTabs-root">
      <div className="admin-tabs">
        <div
          className="admin-tabs__list"
          role="tablist"
          aria-label={t("admin.tabs.label")}
          onKeyDown={handleKeyDown}
        >
          {ADMIN_TAB_IDS.map((id) => {
            const meta = TAB_META[id];
            const selected = id === active;
            return (
              <button
                key={id}
                id={getAdminTabId(id)}
                type="button"
                role="tab"
                className="admin-tab"
                aria-selected={selected}
                aria-controls={getAdminPanelId(id)}
                tabIndex={selected ? 0 : -1}
                onClick={() => onChange(id)}
                onMouseEnter={() => setHovered(id)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(id)}
                onBlur={() => setHovered(null)}
                data-testid={`AdminTabs-tab-${id}`}
              >
                <span className="admin-tab__icon">{meta.icon}</span>
                <span>{t(meta.label)}</span>
              </button>
            );
          })}
        </div>
        <Link
          href="/admin/audit"
          className="admin-tab ml-auto"
          data-testid="AdminPage-auditLink"
        >
          <span className="admin-tab__icon"><ClipboardIcon size={15} /></span>
          <span>{t("admin.tab.audit")}</span>
        </Link>
      </div>
      {/* key가 바뀌면 다시 마운트되어 hint-in 애니메이션이 돈다 / re-mount drives the fade */}
      <p
        key={hovered ?? "idle"}
        className="admin-tabs__hint mt-1.5"
        style={hovered ? undefined : { color: "var(--muted)" }}
        data-testid="AdminTabs-hint"
      >
        {hovered ? t(TAB_META[hovered].desc) : t("admin.tabs.hint")}
      </p>
    </div>
  );
}
