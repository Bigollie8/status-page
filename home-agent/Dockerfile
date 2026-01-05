FROM node:20-alpine

WORKDIR /app

# Install necessary tools for system monitoring
RUN apk add --no-cache procps

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:3005/health || exit 1

CMD ["node", "server.js"]
