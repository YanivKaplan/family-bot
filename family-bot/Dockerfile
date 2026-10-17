# No npm dependencies: the bot uses only Node built-ins (fetch, node:sqlite).
FROM node:22-slim
ENV NODE_ENV=production TZ=Asia/Jerusalem DB_PATH=/data/house.db
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.mjs"]
