FROM node:24.22.3-bookworm-slim

WORKDIR /workspace
RUN install -d -o node -g node /workspace/node_modules /data/uploads

USER node
CMD ["sleep", "infinity"]
