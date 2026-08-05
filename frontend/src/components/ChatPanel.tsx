"use client";

/** 스키마 Q&A 플로팅 챗 — 세션 메모리만, 전 페이지 공용 (사이클2 §4). */

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ChatIcon, CloseIcon } from "@/components/icons";
import { useI18n } from "@/components/i18n";
import { chatAi, searchObjects } from "@/lib/api";
import { buildChatHistory, loadChatSession, saveChatSession, type ChatMessage } from "@/lib/chat-utils";

export function ChatPanel() {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // 모듈 스코프 세션 캐시로 하이드레이트 — AppHeader가 페이지마다 재마운트돼도 대화 유지
  // hydrate from the module-scope cache so a per-page AppHeader remount keeps the conversation
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadChatSession().messages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mock, setMock] = useState(() => loadChatSession().mock);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const send = () => {
    const question = input.trim();
    if (question.length < 2 || busy) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: question }];
    setMessages(next);
    saveChatSession(next, mock);
    setInput("");
    setBusy(true);
    setError(null);
    chatAi(question, buildChatHistory(messages))
      .then((res) => {
        setMock(res.mock);
        const withAnswer: ChatMessage[] = [...next,
          { role: "assistant", content: res.answer, tables: res.tables }];
        setMessages(withAnswer);
        saveChatSession(withAnswer, res.mock);
        // 새 답변으로 스크롤 / scroll to the newest answer
        requestAnimationFrame(() =>
          listRef.current?.scrollTo({ top: listRef.current.scrollHeight }));
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  // 챗 응답의 테이블은 qname뿐 object id가 없어, 브라우저 페이지의 앵커 이동과
  // 동일하게 검색으로 id를 구한 뒤 이동한다 (erd 앵커 딥링크는 anchor=id + label=qname 필요).
  // chat only carries qnames (no id) — resolve one like the browser page's anchor flow does,
  // since the ERD deep link needs both a numeric anchor id and the qname label.
  const openTable = (qname: string) => {
    const name = qname.split(".", 2)[1] ?? qname;
    searchObjects(name, "table")
      .then((res) => {
        const hit = res.items.find((i) => `${i.schema}.${i.name}` === qname);
        if (hit) router.push(`/erd?anchor=${hit.id}&label=${qname}`);
      })
      .catch((e) => setError(e.message));
  };

  return (
    <>
      <button className="icon-button" onClick={() => setOpen((cur) => !cur)}
              title={t("chat.title")} data-testid="ChatPanel-toggleButton">
        <ChatIcon />
      </button>
      {open && (
        <div className="fixed bottom-4 right-4 z-50 flex h-[480px] w-96 flex-col rounded-lg border shadow-lg"
             style={{ borderColor: "var(--hairline)", background: "var(--surface-card)" }}
             data-testid="ChatPanel-root">
          <div className="flex items-center gap-2 border-b px-3 py-2"
               style={{ borderColor: "var(--hairline)" }}>
            <span className="text-sm font-semibold">{t("chat.title")}</span>
            {mock && (
              <span className="badge badge--muted" data-testid="ChatPanel-mockBadge">
                {t("chat.mockBadge")}
              </span>
            )}
            <button className="icon-button ml-auto" onClick={() => setOpen(false)}
                    data-testid="ChatPanel-closeButton"><CloseIcon /></button>
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
               data-testid="ChatPanel-messages">
            {messages.length === 0 && (
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                {t("chat.emptyHint")}
              </p>
            )}
            {messages.map((message, index) => (
              <div key={index} className="mb-2">
                <div className="text-xs font-semibold"
                     style={{ color: message.role === "user" ? "var(--stat-ink)" : "var(--slate)" }}>
                  {message.role === "user" ? t("chat.you") : "AI"}
                </div>
                <div className="whitespace-pre-wrap text-sm">{message.content}</div>
                {message.tables && message.tables.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {message.tables.map((qname) => (
                      <button key={qname} onClick={() => openTable(qname)}
                              className="badge badge--muted"
                              data-testid={`ChatPanel-tableChip-${qname}`}>
                        {qname}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && <p className="text-xs" style={{ color: "var(--muted)" }}>{t("ai.working")}</p>}
            {error && <p className="text-xs" style={{ color: "var(--error)" }}
                         data-testid="ChatPanel-error">{error}</p>}
          </div>
          <div className="flex gap-2 border-t px-3 py-2" style={{ borderColor: "var(--hairline)" }}>
            <input className="min-w-0 flex-1 rounded border px-2 py-1 text-sm"
                   style={{ borderColor: "var(--hairline)", background: "transparent" }}
                   value={input}
                   placeholder={t("chat.placeholder")}
                   onChange={(e) => setInput(e.target.value)}
                   onKeyDown={(e) => {
                     if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
                   }}
                   data-testid="ChatPanel-input" />
            <button className="btn-secondary !py-1 text-xs" onClick={send}
                    disabled={busy || input.trim().length < 2}
                    data-testid="ChatPanel-sendButton">
              {t("chat.send")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
