FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
