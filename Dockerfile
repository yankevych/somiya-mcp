# For directories that start the server to read its tool list (Glama). Without
# SOMIYA_TOKEN it lists every tool and each call says how to get a token.
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
RUN pnpm install --frozen-lockfile && pnpm build && pnpm prune --prod
CMD ["node", "dist/index.js"]
