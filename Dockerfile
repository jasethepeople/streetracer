FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/game/package.json packages/game/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/vehicle/package.json packages/vehicle/package.json
COPY packages/world/package.json packages/world/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN mkdir -p /app/runtime-deps/node_modules && cp -aL apps/server/node_modules/ws /app/runtime-deps/node_modules/ws

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/runtime-deps/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /app/.cache/openstreet-racer/osm && chown -R node:node /app/.cache
USER node
EXPOSE 3001
CMD ["node", "apps/server/dist/index.js"]
