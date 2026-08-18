FROM node:20-alpine

WORKDIR /app

# Install deps (pure JS, no native build needed).
COPY package.json ./
RUN npm install --omit=dev || npm install

COPY tsconfig.json ./
COPY src ./src
COPY .env.example ./.env.example

RUN npm run build

ENV DB_PATH=/app/data/share.json
ENV PORT=8787
ENV PUBLIC_URL=http://localhost:8787
ENV SESSION_SECRET=change-me
VOLUME ["/app/data"]

EXPOSE 8787

# Env comes from the platform (Render/Docker -e), not a baked-in .env file.
CMD ["node", "dist/server.js"]
