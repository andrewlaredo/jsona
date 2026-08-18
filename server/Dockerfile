# ---- build stage: full deps + tsc ----
FROM node:20-alpine AS build

WORKDIR /app

# Install full deps (incl. typescript) with lockfile for reproducibility.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- runtime stage: prod deps only + dist ----
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Prod deps only, exact versions from lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

ENV DB_PATH=/app/data/share.db
ENV PORT=8787
ENV PUBLIC_URL=http://localhost:8787
ENV SESSION_SECRET=change-me
VOLUME ["/app/data"]

EXPOSE 8787

# Env comes from the platform (Render/Docker -e), not a baked-in .env file.
CMD ["node", "dist/server.js"]
