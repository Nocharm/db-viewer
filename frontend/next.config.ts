import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 개발 중 백엔드 프록시 / dev proxy to the FastAPI backend
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
