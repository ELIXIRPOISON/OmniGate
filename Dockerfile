# Production image: one container that serves the gateway, the admin API and the dashboard.
#
# Build context is the repo root, because the build needs the workspace manifests and
# packages/shared:
#
#   docker build -t omnigate .                       # runtime image
#   docker build -t omnigate-migrate --target migrate .   # one-shot migration runner
#
# Two things are deliberate here.
#
# The dashboard is built in the same pass and copied to public/dashboard, where app.setup.ts finds
# it. That is what makes `docker compose up` give the whole product on one port, and a deploy one
# container instead of a stack.
#
# The Prisma CLI never reaches the runtime image. It drags Studio, pglite, effect and elkjs behind
# it, which is most of a 700 MB image on its own, and it is only needed to apply migrations. The
# `migrate` stage runs those; the app talks to Postgres through the pg driver adapter, so it needs
# no engine binary and no CLI.

# ---- deps: the full workspace, needed to build anything ---------------------------------------
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @omnigate/shared build \
 && pnpm --filter @omnigate/dashboard build \
 && pnpm --filter @omnigate/gateway exec prisma generate \
 && pnpm --filter @omnigate/gateway build

# ---- proddeps: the same lockfile resolved without dev dependencies ------------------------------
FROM node:22-alpine AS proddeps
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/gateway/package.json apps/gateway/
COPY packages/shared/package.json packages/shared/
# `@omnigate/gateway...` is the gateway plus its workspace dependencies. Install scripts stay on so
# bcrypt builds its binding.
RUN pnpm install --frozen-lockfile --prod --filter "@omnigate/gateway..." \
 && mkdir -p packages/shared/node_modules apps/gateway/node_modules

# @prisma/client declares `prisma` and `typescript` as OPTIONAL peer dependencies, and pnpm installs
# optional peers when the lockfile resolves them. That pulls the whole CLI in behind the runtime
# client: prisma, @prisma/studio-core, @electric-sql/pglite, effect, elkjs and typescript come to
# about 190 MB for code that only ever runs at build time. Setting auto-install-peers=false is not an
# option here because the lockfile records that setting and a frozen install refuses to disagree with
# it, so they are removed after the fact. The runtime reaches Postgres through @prisma/adapter-pg and
# the generated client is plain compiled TypeScript, so none of this is loaded at run time; the
# integration test that boots this image is what proves it.
RUN cd node_modules/.pnpm \
 && rm -rf prisma@* @prisma+studio-core@* @prisma+engines@* @electric-sql+pglite@* \
           effect@* elkjs@* typescript@* \
 && cd /repo \
 && rm -f node_modules/prisma node_modules/typescript \
          apps/gateway/node_modules/prisma apps/gateway/node_modules/typescript

# @prisma/client ships a WebAssembly query compiler for every database it supports, in two size
# variants, as both CJS and ESM: about 60 MB of MySQL, SQLite, SQL Server and CockroachDB compilers
# for a gateway whose datasource is postgresql. React and its scheduler arrive the same way, behind
# Prisma's dev tooling, and a Node process serving JSON has no use for them.
RUN cd node_modules/.pnpm/@prisma+client*/node_modules/@prisma/client/runtime \
 && find . -name 'query_compiler_*' ! -name '*postgresql*' -delete \
 && cd /repo/node_modules/.pnpm \
 && rm -rf react-dom@* react@* scheduler@* @prisma+dev@*

# ---- migrate: a one-shot container that applies migrations and exits ---------------------------
FROM node:22-alpine AS migrate
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/gateway/node_modules ./apps/gateway/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY apps/gateway/package.json apps/gateway/prisma.config.ts apps/gateway/
COPY apps/gateway/prisma apps/gateway/prisma
WORKDIR /repo/apps/gateway
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ---- runtime ----------------------------------------------------------------------------------
FROM node:22-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
# The workspace layout is preserved so pnpm's relative symlinks still resolve.
COPY --from=proddeps --chown=app:app /repo/node_modules ./node_modules
COPY --from=proddeps --chown=app:app /repo/apps/gateway/node_modules ./apps/gateway/node_modules
COPY --from=proddeps --chown=app:app /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build --chown=app:app /repo/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=app:app /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=app:app /repo/apps/gateway/package.json /repo/apps/gateway/routes.yaml /repo/apps/gateway/routes.demo.yaml ./apps/gateway/
COPY --from=build --chown=app:app /repo/apps/gateway/dist ./apps/gateway/dist
COPY --from=build --chown=app:app /repo/apps/dashboard/dist ./apps/gateway/public/dashboard
USER app
WORKDIR /app/apps/gateway
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/main.js"]
