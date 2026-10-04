FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Data (SQLite) lives in $DATA_DIR — mount a persistent disk/volume there (render.yaml / docker-compose do this).
EXPOSE 3000
CMD ["node", "server/index.js"]
