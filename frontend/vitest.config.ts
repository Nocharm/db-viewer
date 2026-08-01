import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node", // 순수 로직만 단위 테스트 / pure-logic units only
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
