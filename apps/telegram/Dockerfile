FROM node:22-alpine AS base
RUN npm install -g pnpm@9
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY apps/telegram/package.json ./apps/telegram/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY apps/telegram ./apps/telegram
RUN pnpm --filter @emma/shared build
RUN pnpm --filter @emma/core build
RUN pnpm --filter @emma/telegram build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/telegram/dist ./apps/telegram/dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/telegram/node_modules ./apps/telegram/node_modules
CMD ["node", "apps/telegram/dist/index.js"]
