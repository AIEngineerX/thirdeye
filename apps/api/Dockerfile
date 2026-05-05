FROM oven/bun:1.2-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/helius/package.json packages/helius/
COPY packages/scanner/package.json packages/scanner/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3001
CMD ["bun", "run", "apps/api/src/index.ts"]
