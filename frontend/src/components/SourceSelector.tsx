"use client";

/** 소스 선택기 — 브라우저·ERD·값 추적·관리 화면이 공유한다. 네이티브 `<select>` 대신
 * 아이콘·엔진 배지·선택 체크가 있는 메뉴로 그려 어느 DB를 보고 있는지 한눈에 읽힌다.
 * 열림 상태·키보드(↑↓ Enter Esc)·바깥 클릭 닫힘은 여기서 처리하고, 어떤 소스가 골라졌는지는
 * 부모가 가진다(URL ?source=와 동기화).
 * Custom source picker shared by four screens: icon + engine badge + check mark, keyboard and
 * outside-click handled here, selection owned by the parent. */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { useI18n } from "@/components/i18n";
import { CaretDownIcon, CheckIcon, DatabaseIcon } from "@/components/icons";
import { useDataSources } from "@/lib/use-data-sources";
import { resolveSelectedSource, stepActiveIndex } from "@/lib/source-picker";

interface SourceSelectorProps {
  value: number | null;
  onChange: (sourceId: number | null) => void;
}

export function SourceSelector({ value, onChange }: SourceSelectorProps) {
  const { t } = useI18n();
  const sources = useDataSources();
  const [open, setOpen] = useState(false);
  // 키보드로 짚고 있는 항목 — 열릴 때 현재 선택으로 맞춘다 / keyboard cursor, seeded on open
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // 소스가 하나뿐이면 고를 것이 없다 — 화면을 어지럽히지 않는다
  if (sources.length <= 1) return null;

  const selected = resolveSelectedSource(sources, value);

  const openMenu = () => {
    setActiveIndex(sources.findIndex((source) => source.id === selected?.id));
    setOpen(true);
  };

  const closeMenu = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (id: number) => {
    setOpen(false);
    if (id !== selected?.id) onChange(id);
    triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenu();
    }
  };

  const handleMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((cur) => stepActiveIndex(cur, e.key === "ArrowDown" ? 1 : -1, sources.length));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const target = sources[activeIndex];
      if (target) choose(target.id);
    } else if (e.key === "Tab") {
      // 포커스가 떠나면 메뉴만 닫는다 — 포커스를 되돌리지 않아 탭 순서가 자연스럽다
      setOpen(false);
    }
  };

  const optionId = (index: number) => `${menuId}-option-${index}`;

  return (
    <div ref={rootRef} className="relative" data-testid="SourceSelector-root">
      <button
        ref={triggerRef}
        type="button"
        className="source-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t("source.pickerLabel")}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
        data-testid="SourceSelector-trigger"
      >
        <span className="source-picker__icon"><DatabaseIcon size={14} /></span>
        <span className="source-picker__name" data-testid="SourceSelector-currentName">
          {selected?.name ?? "—"}
        </span>
        {selected && (
          <span className="source-picker__engine">{selected.engine}</span>
        )}
        <span className={`source-picker__caret ${open ? "source-picker__caret--open" : ""}`}>
          <CaretDownIcon size={12} />
        </span>
      </button>

      {open && (
        <div
          id={menuId}
          className="source-picker__menu"
          role="listbox"
          aria-label={t("source.pickerLabel")}
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          tabIndex={-1}
          // 열리자마자 메뉴가 포커스를 받아 ↑↓ Enter Esc가 바로 먹는다 / focus on open
          ref={(el) => el?.focus()}
          onKeyDown={handleMenuKeyDown}
          data-testid="SourceSelector-menu"
        >
          <div className="source-picker__label">{t("source.pickerLabel")}</div>
          {sources.map((source, index) => {
            const isSelected = source.id === selected?.id;
            return (
              <button
                key={source.id}
                id={optionId(index)}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`source-picker__option ${index === activeIndex ? "source-picker__option--active" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(source.id)}
                data-testid={`SourceSelector-option-${source.id}`}
              >
                <span className="source-picker__icon"><DatabaseIcon size={14} /></span>
                <span className="source-picker__option-body">
                  <span className="source-picker__option-name">{source.name}</span>
                  <span className="source-picker__engine">{source.engine}</span>
                </span>
                {isSelected && (
                  <span className="source-picker__check" data-testid={`SourceSelector-check-${source.id}`}>
                    <CheckIcon size={13} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
