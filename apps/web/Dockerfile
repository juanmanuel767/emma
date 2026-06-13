FROM node:22-alpine AS build
RUN npm install -g pnpm@9
WORKDIR /app
COPY pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
RUN pnpm --filter @emma/web build

FROM nginx:alpine AS runner
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
