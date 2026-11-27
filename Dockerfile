# ── builder ────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install build deps for native modules (bcryptjs is JS so this is light)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# npm ci installs exactly what package-lock.json lists (Low, CWE-250)
RUN npm ci --omit=dev

COPY . .

# ── runner (distroless for minimal attack surface) ─────────────────────────
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy app + production node_modules
COPY --from=builder /app /app

# The :nonroot image runs as uid 65532, not root. The app writes only to /tmp.
EXPOSE 8080

# Cloud Run sends SIGTERM on shutdown; server.js handles it
CMD ["server.js"]
