FROM node:24-bookworm-slim

WORKDIR /app

RUN npm ci --ignore-scripts \
    && npm run typecheck \
    && npm run test:coverage \
    && npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force \
    && rm -rf \
      /app/coverage \
      /app/src \
      /app/test \
      /app/docs \
      /app/scripts \
      /app/.github \
      /app/tsconfig.json \
      /app/tsconfig.build.json \
      /app/vitest.config.ts \
    && chown -R node:node /app

ENV NODE_ENV=production

USER node

ENTRYPOINT ["node", "dist/cli/main.js"]
CMD ["--help"]
