FROM node:24.22.3-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/F4brici0L4yme/fetcher-n-sender-unsa" \
      org.opencontainers.image.description="Personal local Aula Virtual UNSA capture, delivery, notes, and sandboxed MCP server"

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
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
    && install -d -m 0700 -o node -g node /data/uploads /sessions \
    && sha256sum package-lock.json | cut -d ' ' -f 1 > node_modules/.runtime-lock.sha256 \
    && chown -R node:node /workspace
RUN install -d -m 0700 -o node -g node /data /data/uploads /data/uploads/proofs /sessions \
    && install -d -m 0755 -o node -g node /inbox

COPY --chown=node:node . .
RUN npm run build && chown -R node:node /workspace/dist
COPY scripts/container-entrypoint.sh /usr/local/bin/homework-entrypoint
RUN chmod 755 /usr/local/bin/homework-entrypoint

USER node
ENTRYPOINT ["homework-entrypoint"]
CMD ["app"]
