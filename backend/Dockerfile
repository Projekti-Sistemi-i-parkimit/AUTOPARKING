# syntax=docker/dockerfile:1
# Imazhi i backend-it (shërben edhe frontend-in statik).
# Ndërtohet nga rrënja e repo-s:  docker build -f backend/Dockerfile .
# Përdoret node:22-slim (glibc) që better-sqlite3 të marrë binarë të parandërtuar.

# ---------- Faza 1: varësitë e prodhimit ----------
FROM node:22-slim AS deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# ---------- Faza 2: imazhi final ----------
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/backend

COPY --from=deps /app/backend/node_modules ./node_modules
COPY backend/package.json ./
COPY backend/src ./src
# Frontend-i shërbehet nga backend-i (express.static në ../frontend)
COPY frontend /app/frontend

# Databaza jeton në /data (volum i qëndrueshëm në docker-compose.yml)
ENV DB_PATH=/data/parking.db
RUN mkdir -p /data && chown -R node:node /data /app

# Ekzekutohet si përdorues pa privilegje
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Seed-i është idempotent: krijon adminin/çelësin API vetëm nëse mungojnë,
# pastaj niset serveri. Çelësi i ri API shfaqet VETËM një herë në logje.
CMD ["sh", "-c", "node src/db/seed.js && exec node src/server.js"]