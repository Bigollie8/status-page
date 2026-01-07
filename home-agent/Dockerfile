FROM node:20-alpine

WORKDIR /app

# Install necessary tools for system monitoring and SQLite compilation
RUN apk add --no-cache \
    procps \
    python3 \
    make \
    g++ \
    lm-sensors

# Create data directory for SQLite persistence
RUN mkdir -p /app/data

COPY package*.json ./

# Install dependencies (better-sqlite3 requires native compilation)
RUN npm install --production

COPY . .

# Volume for persistent metrics database
VOLUME ["/app/data"]

EXPOSE 3005

# Environment variable for data directory
ENV DATA_DIR=/app/data

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:3005/health || exit 1

CMD ["node", "server.js"]
