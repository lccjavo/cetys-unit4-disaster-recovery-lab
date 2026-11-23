FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY views ./views
COPY public ./public
COPY test ./test

RUN mkdir -p /vault/keys /vault/backups \
    && chown -R node:node /vault \
    && chmod 0700 /vault/keys /vault/backups

USER node
EXPOSE 3001 8200
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
