import { describe, expect, it } from "vitest";

import { buildChatHistory, CHAT_HISTORY_LIMIT, type ChatMessage } from "./chat-utils";

function makeMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg-${i}`,
    tables: i % 2 === 1 ? [`dbo.T_${i}`] : undefined,
  }));
}

describe("buildChatHistory", () => {
  it("keeps only the last CHAT_HISTORY_LIMIT turns", () => {
    const messages = makeMessages(7);
    const history = buildChatHistory(messages);
    expect(history).toHaveLength(CHAT_HISTORY_LIMIT);
    expect(history.map((h) => h.content)).toEqual(
      messages.slice(-CHAT_HISTORY_LIMIT).map((m) => m.content),
    );
  });

  it("strips the tables field, keeping only role and content", () => {
    const messages = makeMessages(2);
    const history = buildChatHistory(messages);
    for (const turn of history) {
      expect(Object.keys(turn).sort()).toEqual(["content", "role"]);
    }
  });

  it("passes through fewer than the limit unchanged", () => {
    const messages = makeMessages(3);
    const history = buildChatHistory(messages);
    expect(history).toEqual([
      { role: "user", content: "msg-0" },
      { role: "assistant", content: "msg-1" },
      { role: "user", content: "msg-2" },
    ]);
  });
});
