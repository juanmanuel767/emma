FROM node:22-alpine AS base
RUN npm install -g pnpm@9
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY apps/gateway/package.json ./apps/gateway/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/gateway/node_modules ./apps/gateway/node_modules
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY apps/gateway ./apps/gateway
RUN pnpm --filter @emma/shared build
RUN pnpm --filter @emma/core build
RUN pnpm --filter @emma/gateway build

FROM node:22-alpine AS runner
RUN npm install -g pnpm@9
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/gateway/node_modules ./apps/gateway/node_modules
EXPOSE 3000
CMD ["node", "apps/gateway/dist/index.js"]
