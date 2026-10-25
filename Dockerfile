# Udhaar Agent: one shop per container. Agent37 build: npx agent37 templates build . --name udhaar-gupta --default-port 8000
FROM node:22-alpine
WORKDIR /app
# npm dependencies (pinned in package-lock.json): the WhatsApp Web library (WA_PROVIDER=web) and pg (DATABASE_URL).
# The dev dependencies (TypeScript and its type packages) are needed only for the build and are pruned after it.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --omit=peer --no-audit --no-fund
COPY core ./core
COPY web ./web
COPY vendor ./vendor
COPY server ./server
COPY db ./db
COPY scripts ./scripts
COPY build.js ./
# the hand-written cases and runner for the live test-run page (/test-run)
COPY livetest ./livetest
# TypeScript (core, server, scripts) -> dist-server/, then the page with the compiled core inlined -> dist/
RUN npx tsc -p tsconfig.json
RUN node build.js
RUN npm prune --omit=dev --omit=peer --no-audit --no-fund && npm cache clean --force && node -e "require('pg')"
USER node
# Which demo shop this image runs. One template per shop: see README, "Deploy on Agent37".
ENV SHOP=gupta
# /home/node is a separate mount on Agent37, so the khata (and udhaar.env) are kept apart from the image.
# The demo khata is seeded only when no saved khata exists there yet.
ENV PORT=8000 DATA_DIR=/home/node/data NODE_ENV=production REAL_CLOCK=1 TZ=Asia/Kolkata
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8000/healthz || exit 1
CMD ["node", "dist-server/server/server.js"]
