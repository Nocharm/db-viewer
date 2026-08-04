"use client";

/** 언어 컨텍스트 — localStorage 유지, 사전은 lib/i18n. / language context over the dictionary. */

import { createContext, useCallback, useContext, useEffect, useState } from "react";

import { getMessage, LANG_STORAGE_KEY, type Lang, type MessageKey } from "@/lib/i18n";

interface LangState {
  lang: Lang;
  toggleLang: () => void;
}

const LangContext = createContext<LangState>({ lang: "ko", toggleLang: () => {} });

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState<Lang>("ko");

  useEffect(() => {
    try {
      if (localStorage.getItem(LANG_STORAGE_KEY) === "en") setLang("en");
    } catch {
      // localStorage 차단 환경 — 기본 한국어 유지 / stay on the default
    }
  }, []);

  const toggleLang = () => {
    setLang((cur) => {
      const next: Lang = cur === "ko" ? "en" : "ko";
      try {
        localStorage.setItem(LANG_STORAGE_KEY, next);
      } catch {
        // 세션 한정 토글 / session-only toggle
      }
      return next;
    });
  };

  return (
    <LangContext.Provider value={{ lang, toggleLang }}>{children}</LangContext.Provider>
  );
}

export function useI18n() {
  const { lang, toggleLang } = useContext(LangContext);
  // t를 lang에만 묶어 안정화 — 그렇지 않으면 소비 컴포넌트가 재렌더될 때마다
  // 새 클로저가 생겨, t를 effect deps에 쓰는 폴링(erd/page.tsx)이 매번 재시작된다.
  const t = useCallback((key: MessageKey) => getMessage(key, lang), [lang]);
  return { lang, toggleLang, t };
}
