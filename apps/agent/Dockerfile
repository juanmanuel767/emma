FROM node:22-alpine AS base
RUN npm install -g pnpm@9
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY packages/memory/package.json ./packages/memory/
COPY packages/tools/package.json ./packages/tools/
COPY apps/agent/package.json ./apps/agent/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/memory/node_modules ./packages/memory/node_modules
COPY --from=deps /app/packages/tools/node_modules ./packages/tools/node_modules
COPY --from=deps /app/apps/agent/node_modules ./apps/agent/node_modules
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/memory ./packages/memory
COPY packages/tools ./packages/tools
COPY apps/agent ./apps/agent
RUN pnpm --filter @emma/shared build
RUN pnpm --filter @emma/core build
RUN pnpm --filter @emma/memory build
RUN pnpm --filter @emma/tools build
RUN pnpm --filter @emma/agent build

FROM node:22-alpine AS runner
RUN npm install -g pnpm@9
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/memory/dist ./packages/memory/dist
COPY --from=build /app/packages/tools/dist ./packages/tools/dist
COPY --from=build /app/apps/agent/dist ./apps/agent/dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/agent/node_modules ./apps/agent/node_modules
EXPOSE 3001
CMD ["node", "apps/agent/dist/index.js"]
