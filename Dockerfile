FROM node:24.22.3-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/F4brici0L4yme/fetcher-n-sender-unsa" \
      org.opencontainers.image.description="Personal local Aula Virtual UNSA capture, delivery, notes, and sandboxed MCP server"

ENV HOST=0.0.0.0 \
    PORT=3000 \
    TZ=America/Lima \
    UPLOAD_DIR=/data/uploads \
    PROOF_DIR=/data/uploads/proofs \
    SESSION_DIR=/sessions \
    AULA_CAPTURE_MODE=browser \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    DISPLAY=:99 \
    MCP_INBOX_DIR=/inbox
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci \
    && npx playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11-utils x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /opt/playwright \
    && install -d -m 0700 -o node -g node /data /data/uploads /data/uploads/proofs /sessions \
    && install -d -m 0755 -o node -g node /inbox \
    && sha256sum package-lock.json | cut -d ' ' -f 1 > node_modules/.runtime-lock.sha256 \
    && chown -R node:node /workspace

COPY --chown=node:node . .
RUN npm run build && chown -R node:node /workspace/dist
COPY scripts/container-entrypoint.sh /usr/local/bin/homework-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/homework-entrypoint && chmod 755 /usr/local/bin/homework-entrypoint

EXPOSE 3000 6080

USER node
ENTRYPOINT ["homework-entrypoint"]
CMD ["app"]
