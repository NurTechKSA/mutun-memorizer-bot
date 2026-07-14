FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./
COPY content/sources.json ./content/sources.json
COPY content/catalog.json ./content/catalog.json
COPY content/prepared ./content/prepared
COPY assets ./assets
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "dist/src/index.js"]
