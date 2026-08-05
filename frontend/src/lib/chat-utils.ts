/** 챗 이력 정리 — 서버 상한(6턴)에 맞춰 최근 턴만 전송 / trim to the server cap. */

import type { ChatTurn } from "./api";

export const CHAT_HISTORY_LIMIT = 6;

export interface ChatMessage extends ChatTurn { tables?: string[] }

export function buildChatHistory(messages: ChatMessage[]): ChatTurn[] {
  return messages.slice(-CHAT_HISTORY_LIMIT)
    .map(({ role, content }) => ({ role, content }));
}

// 라우트 전환 리마운트에도 대화 유지 — 모듈 스코프 세션 캐시 (api.ts authToken 관용)
// 새로고침 시 초기화되는 것은 스펙 그대로(세션 메모리만).
let sessionMessages: ChatMessage[] = [];
let sessionMock = false;

export function loadChatSession(): { messages: ChatMessage[]; mock: boolean } {
  return { messages: sessionMessages, mock: sessionMock };
}

export function saveChatSession(messages: ChatMessage[], mock: boolean): void {
  sessionMessages = messages;
  sessionMock = mock;
}
