# Livestorm dashboard — zero runtime dependencies, so this stays minimal.
FROM node:22-alpine

# Run as the built-in non-root user for safety.
WORKDIR /app

# Only package.json is needed (no dependencies to install).
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
# deploybay/most platforms inject PORT; default to 3000 for local `docker run`.
ENV PORT=3000
EXPOSE 3000

USER node

CMD ["node", "server.js"]
