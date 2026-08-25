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
  // tsconfig의 jsx:"preserve"(Next.js SWC 전용 설정)를 그대로 물려받으면 .tsx를 import만
  // 해도 vite(oxc)가 JSX를 못 지운다 — 컴포넌트 파일에서 순수 함수를 골라 테스트할 때만
  // 필요(렌더는 안 한다. 이 설정이 프로덕션 빌드엔 안 쓰인다).
  oxc: { jsx: { runtime: "automatic" } },
});
