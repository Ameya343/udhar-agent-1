# Udhaar Agent: one shop per container. Agent37 build: npx agent37 templates build . --name udhaar-gupta --default-port 8000
FROM node:22-alpine
WORKDIR /app
# The only npm dependency: the WhatsApp Web library for WA_PROVIDER=web (pinned in package-lock.json).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=peer --no-audit --no-fund && npm cache clean --force
COPY core ./core
COPY web ./web
COPY vendor ./vendor
COPY server ./server
COPY build.js ./
RUN node build.js
USER node
# Which demo shop this image runs. One template per shop: see README, "Deploy on Agent37".
ENV SHOP=gupta
# /home/node is a separate mount on Agent37, so the khata (and udhaar.env) are kept apart from the image.
# The demo khata is seeded only when no saved khata exists there yet.
ENV PORT=8000 DATA_DIR=/home/node/data NODE_ENV=production REAL_CLOCK=1 TZ=Asia/Kolkata
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8000/healthz || exit 1
CMD ["node", "server/server.js"]
