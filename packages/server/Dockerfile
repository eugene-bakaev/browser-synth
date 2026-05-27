# ---- builder ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
RUN npm ci --workspace=@fiddle/server --include-workspace-root

COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY tsconfig.base.json ./
RUN npm run build -w @fiddle/server

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
RUN npm ci --omit=dev --workspace=@fiddle/server --include-workspace-root

COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/shared ./packages/shared

EXPOSE 8787
CMD ["node", "packages/server/dist/index.js"]
