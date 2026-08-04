# Multi-stage build.
#
# The single-stage version of this file ran `npm ci --omit=dev` and THEN `npm run build`, which
# cannot work: `vite` and `typescript` are required (non-optional) peers of `@react-router/dev`
# and live in devDependencies, so the build step had no bundler. The build now happens in a stage
# with the full dependency tree, and only the compiled output plus production dependencies are
# carried into the runtime image.

# ---------- build ----------
FROM node:20-alpine AS builder
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
# Generates the Prisma client and compiles the server + client bundles.
RUN npx prisma generate && npm run build

# ---------- runtime ----------
FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

ENV NODE_ENV=production
EXPOSE 3000

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Prisma schema + migrations are needed at runtime: `docker-start` runs `prisma migrate deploy`.
COPY prisma ./prisma
RUN npx prisma generate

COPY --from=builder /app/build ./build
COPY --from=builder /app/public ./public

# Drop privileges — nothing here needs root.
USER node

CMD ["npm", "run", "docker-start"]
