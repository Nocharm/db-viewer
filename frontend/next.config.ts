import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 컨테이너 배포용 standalone 출력 / standalone output for Docker
  output: "standalone",
  // 백엔드 프록시 — 단일 포트(6678)로 UI와 /api를 함께 서빙 / single-port serving
  // BACKEND_URL은 빌드 시점에 평가되어 standalone manifest에 굳는다 — Dockerfile ARG로 주입
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.BACKEND_URL ?? "http://localhost:8000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
