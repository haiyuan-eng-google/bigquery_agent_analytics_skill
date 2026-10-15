# Build stage: bundle the UI (single HTML file) and compile the server.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
  && npx esbuild server.ts --bundle --platform=node --format=esm \
     --packages=external --outfile=dist/server.mjs

# Runtime stage: production dependencies only, non-root user.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV BQAA_HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
# Cloud Run injects PORT; server reads it (defaults to 3001 locally)
CMD ["node", "dist/server.mjs"]
