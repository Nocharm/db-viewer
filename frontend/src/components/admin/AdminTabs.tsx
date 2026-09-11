"use client";

/** 관리 콘솔 상단 탭 바 — 아이콘·라벨·카운트 pill, 활성(또는 올린) 탭의 한 줄 설명, ←/→ 키
 * 이동. 상태는 부모가 가진다(URL ?tab=과 동기화). 감사 로그도 다섯 번째 탭이다 — 예전
 * /admin/audit 주소는 ?tab=audit로 리다이렉트된다.
 * Controlled tab strip: icon, label, count pill; the audit log is a tab like the others. */

import { useState, type KeyboardEvent, type ReactNode } from "react";

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
  audit: { label: "admin.tab.audit", desc: "admin.tab.auditDesc", icon: <ClipboardIcon size={15} /> },
};

/** 탭 버튼의 DOM id — 패널의 aria-labelledby가 같은 규칙으로 가리킨다 / shared id scheme */
export function getAdminTabId(tab: AdminTabId): string {
  return `admin-tab-${tab}`;
}

export function getAdminPanelId(tab: AdminTabId): string {
  return `admin-panel-${tab}`;
}

/** 상태 점 — 숫자보다 상태가 중요한 탭(AI 색인 진행 중/완료) */
export type AdminTabDot = "running" | "ok";

interface AdminTabsProps {
  active: AdminTabId;
  onChange: (tab: AdminTabId) => void;
  /** 탭 라벨 옆 카운트 pill — 소스 수·허용 스키마 수·사용자 수·오늘 감사 건수 */
  counts?: Partial<Record<AdminTabId, number | string>>;
  dots?: Partial<Record<AdminTabId, AdminTabDot>>;
}

export function AdminTabs({ active, onChange, counts, dots }: AdminTabsProps) {
  const { t } = useI18n();
  // 마우스 또는 포커스가 올라간 탭 — 힌트 줄이 그 탭의 설명으로 바뀐다(없으면 활성 탭)
  const [hovered, setHovered] = useState<AdminTabId | null>(null);
  const described = hovered ?? active;

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
            const count = counts?.[id];
            const dot = dots?.[id];
            return (
              <button
                key={id}
                id={getAdminTabId(id)}
                type="button"
                role="tab"
                // 감사 로그는 "읽기만" 하는 탭이라 조작 탭들과 떨어뜨려 오른쪽 끝에 둔다
                className={id === "audit" ? "admin-tab ml-auto" : "admin-tab"}
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
                {count !== undefined && (
                  <span className="admin-tab__count" data-testid={`AdminTabs-count-${id}`}>
                    {count}
                  </span>
                )}
                {dot && (
                  <span className={`admin-tab__dot admin-tab__dot--${dot}`} aria-hidden
                        data-testid={`AdminTabs-dot-${id}`} />
                )}
              </button>
            );
          })}
        </div>
      </div>
      {/* key가 바뀌면 다시 마운트되어 hint-in 애니메이션이 돈다 / re-mount drives the fade */}
      <p
        key={described}
        className="admin-tabs__hint mt-1.5 flex items-center gap-3"
        data-testid="AdminTabs-hint"
      >
        <span>{t(TAB_META[described].desc)}</span>
        <span className="admin-tabs__kbd">
          <kbd>←</kbd><kbd>→</kbd> {t("admin.tabs.kbdHint")}
        </span>
      </p>
    </div>
  );
}
