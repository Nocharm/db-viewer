/** 챗 이력 정리 — 서버 상한(6턴)에 맞춰 최근 턴만 전송 / trim to the server cap. */

import type { ChatTurn } from "./api";

export const CHAT_HISTORY_LIMIT = 6;

export interface ChatMessage extends ChatTurn { tables?: string[] }

export function buildChatHistory(messages: ChatMessage[]): ChatTurn[] {
  return messages.slice(-CHAT_HISTORY_LIMIT)
    .map(({ role, content }) => ({ role, content }));
}
