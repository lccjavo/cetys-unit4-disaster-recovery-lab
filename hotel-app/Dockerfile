FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY views ./views
COPY public ./public
COPY migrations ./migrations
COPY test ./test

# Puntos de montaje de volumenes compartidos (lectura de respaldos/WAL, control del laboratorio).
RUN mkdir -p /lab-control /backups/catalog /wal-archive \
    && chmod 1777 /lab-control \
    && chown 999:999 /backups /backups/catalog /wal-archive \
    && chmod 0755 /backups /backups/catalog /wal-archive

USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
