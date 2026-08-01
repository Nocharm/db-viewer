# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
# NEXT_PUBLIC_*는 빌드 시 인라인 — 값 변경엔 재빌드 필요 (bpm과 동일한 제약)
# NEXT_PUBLIC_* values are inlined at build time; changing them needs a rebuild
ARG NEXT_PUBLIC_AUTH_ENABLED=false
ARG NEXT_PUBLIC_KEYCLOAK_ISSUER=http://182.199.63.71:8080/realms/ai-portal
ARG NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=db-viewer-frontend
ENV NEXT_PUBLIC_AUTH_ENABLED=$NEXT_PUBLIC_AUTH_ENABLED \
    NEXT_PUBLIC_KEYCLOAK_ISSUER=$NEXT_PUBLIC_KEYCLOAK_ISSUER \
    NEXT_PUBLIC_KEYCLOAK_CLIENT_ID=$NEXT_PUBLIC_KEYCLOAK_CLIENT_ID
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
