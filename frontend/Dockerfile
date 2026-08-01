# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# standalone 산출물만 복사 — 이미지 최소화 / minimal runtime image (docker.md)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# non-root 실행 / node 유저 사용 (docker.md)
USER node

# BACKEND_URL은 기동 시 rewrites에서 평가된다 — compose가 주입 (config.md)
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
