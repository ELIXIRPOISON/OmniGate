# Journal

Five lines a day: done / blocked / decided. Newest first.

## 2026-09-07 (Mon) - Sprint 1, day 1
- Done: repo bootstrapped as a pnpm workspace (`apps/gateway` NestJS, `apps/dashboard` Vite React, `packages/shared`), docs pack committed, `.env.example`, `routes.yaml`, Node 22 pin, CI skeleton. Build, typecheck, lint, unit and e2e tests green.
- Decided: repo lives at `~/PP/OmniGate`; git identity and SSH are scoped to `~/PP` so commits are always the personal account.
- Decided: package names are scoped (`@omnigate/gateway`, `@omnigate/dashboard`, `@omnigate/shared`); the doc pack's `pnpm --filter` commands were updated to match.
- Decided: build on what the current scaffolds produce rather than the doc pack's assumed versions: NestJS 12 (ESM), React 19, Vite 8, TypeScript 6, Vitest + oxlint (not Jest + ESLint). Prisma pinned to 7.10.0 because the npm `latest` tag currently points at an 8.0 release candidate.
- Decided: `LLM_PROVIDER=fake` is the local default so nothing needs an API key until Sprint 6.
- Next: S1-02 config module, S1-03 request-id + pino, S1-04 route resolver, S1-05 proxy, S1-06 mock upstream, S1-07 problem-details filter, S1-08 compose.
