# The repository-image service copies the repository into /app and sets the
# working directory before these instructions run, so this file adds no COPY of
# its own.
#
# Every RUN is a single physical line. Backslash continuations are valid Docker
# and build fine locally, but the platform's parser reads the continued lines as
# instructions in their own right, so a wrapped `rm -rf` list fails validation
# with "unknown instruction: /app/tsconfig.build.json".

FROM node:24-bookworm-slim

WORKDIR /app

RUN npm ci --ignore-scripts && npm run typecheck && npm run test:coverage && npm run build && npm prune --omit=dev && npm cache clean --force

RUN rm -rf /app/coverage /app/src /app/test /app/docs /app/scripts /app/.github /app/tsconfig.json /app/tsconfig.build.json /app/vitest.config.ts

# Hand /app to the runtime user before switching to it: the platform appends its
# own `git config` step after these instructions, running as the final USER, and
# it cannot write /app/.git/config otherwise.
RUN chown -R node:node /app

ENV NODE_ENV=production

USER node

ENTRYPOINT ["node", "dist/cli/main.js"]
CMD ["--help"]
