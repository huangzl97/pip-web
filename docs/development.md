# Development

## Prerequisites

- **Node** ≥ 20 (built on 22).
- **pnpm** (the only supported package manager here).

> Install everything with pnpm and **do not hand-pin versions** — install latest and let
> pnpm resolve. pnpm's build-script approvals live in `pnpm-workspace.yaml`
> (`allowBuilds` / `onlyBuiltDependencies` for `esbuild`, `sharp`, `unrs-resolver`).

## Scripts

```bash
pnpm dev         # Next dev server (Turbopack) → http://localhost:3000
pnpm build       # production build
pnpm start       # serve the production build
pnpm lint        # biome lint (must be clean — 0 errors)
pnpm lint:fix    # biome — apply safe + unsafe fixes
pnpm format      # biome — format + safe fixes, in place
pnpm typecheck   # tsc --noEmit
pnpm test        # AVA — the engine test suite
pnpm test:all    # scripts/test.sh — format, types, lint, AVA, knip, audit
pnpm sim         # difficulty simulation (scripts/sim.ts) — see below
```

Before considering a change done: **`pnpm test:all` should pass** (it runs the format
check, typecheck, lint, AVA suite, knip unused-code check, and dependency audit), and
for anything structural, `pnpm build`.

### The difficulty simulator

`pnpm sim` plays full sit-and-go tournaments with a proxy human against each
venue's real AI (real engine, blinds, escalation) and reports win rates — the
tool for tuning any `AiProfile` or pacing knob in `config/venues.ts`. Change a
knob, re-run, compare against the "fair" column (1/seats). Deterministic per seed.

```bash
pnpm sim                       # kitchen + the ladder (competent hero, n=200)
pnpm sim garage pub            # specific venues; also: ladder | side | all
pnpm sim garage --n 500        # more tournaments = tighter estimate (slower)
pnpm sim --hero casual         # beginner | casual | competent | best
pnpm sim garage --skill 0.4    # trial an AI skill without editing config
```

It's Monte-Carlo-heavy — a venue takes ~2–4 minutes at n=50; high venues
(more `iterations`) take longer. n=50 has roughly a ±7pp margin; use n≥200
for numbers you'll quote.

## Testing (AVA)

Tests are **AVA**, not Vitest. Config in `ava.config.js` runs TypeScript via `tsx`:

```js
export default {
  extensions: ['ts'],
  nodeArguments: ['--import=tsx'],
  workerThreads: false,      // so the tsx loader applies to test files
  files: ['tests/**/*.test.ts'],
}
```

- The package is ESM (`"type": "module"`), which is required for the `tsx` loader to
  resolve a single AVA instance — don't remove it.
- Only the **pure engine** is unit-tested (`tests/{cards,handEval,pots,engine,equity,ai}.test.ts`).
  UI is not unit-tested; verify it by running the app.
- `tests/helpers.ts` → `makeDeck(popOrder)` builds a deck whose `pop()` order is exactly
  `popOrder`, for deterministic scenarios.
- The AI/equity tests are Monte-Carlo and take a few seconds; a whole-run timeout under
  heavy load can flake — re-run `pnpm test` if you see "pending after a timeout".

Add a test for any rules/AI change. Favor invariants (chip conservation, legality)
alongside specific scenarios.

## Conventions & gotchas

- **Colours:** use theme tokens, never hardcoded `white`/`black`. See [design.md](./design.md).
  The one deliberate exception is `QrCode.tsx` (fixed white card for camera
  scannability) — see [data-and-offline.md](./data-and-offline.md#qr-scan-to-phone).
- **`set-state-in-effect`:** no synchronous `setState` inside `useEffect` (a React 19
  rule; enforced by convention here — Biome has no equivalent). Patterns used instead:
  - client-only gate → `useHydrated()` (`useSyncExternalStore`).
  - "seed a form when a dialog opens" → mount the form only while open (`{open && <Form/>}`)
    and initialize its `useState` from the store (see `ProfileDialog`/`SettingsDialog`).
- **pokersolver is CommonJS:** import the default and destructure (`import pkg from
  'pokersolver'; const { Hand } = pkg`), with types in `src/types/pokersolver.d.ts`.
- **No `Date.now()`/`Math.random()` in engine logic that must be deterministic** — pass a
  seeded `Rng`. (They're fine in UI/store code like avatar seeds.)
- **Persisted profile:** changing its shape → bump `PERSIST_VERSION` and add a `migrate`
  branch in `store/profile.ts`. The profile is portable (file / code / QR) via one
  shared envelope — see [data-and-offline.md](./data-and-offline.md).
- **Turbopack root** is pinned in `next.config.ts` so `pnpm-workspace.yaml` isn't mistaken
  for a monorepo root.
- **Images:** venue art uses plain `<img>` (static art; `next/image` adds little for
  these) — Biome's `noImgElement` is off repo-wide. Avatars are inline SVG data URIs.

## Adding a dependency

```bash
pnpm add <pkg>            # runtime
pnpm add -D <pkg>         # dev
```
If pnpm reports ignored build scripts, add the package to `onlyBuiltDependencies` /
`allowBuilds` in `pnpm-workspace.yaml` and re-run `pnpm install`.

## Deploy & releases

**Cloudflare Pages, pure static.** `next.config.ts` sets `output: 'export'`, so
`pnpm build` writes the whole site to `out/` as plain files — no server, no env
vars, no secrets at runtime. Every route prerenders: `/play/[venue]` enumerates
its paths via `generateStaticParams` (all venues are known config), and
`app/manifest.ts` opts in with `dynamic = 'force-static'`.

### Cloudflare Git integration (release → dev preview)

Connect `huangzl97/pip-web` using the **Cloudflare Pages GitHub App**, with access
limited to this repository. No GitHub Actions deployment token or account ID
is needed. The GitHub CI workflow remains a PR check; Cloudflare performs its
own full gate before uploading.

Configure the Pages project:

| Setting | Value |
|---|---|
| Production branch | `main` (never `release`) |
| Automatic production deployments | Disabled |
| Preview branch deployments | Custom: include only `release` |
| Framework preset | None |
| Root directory | Repository root |
| Build command | `pnpm build:preview` |
| Build output directory | `out` |
| Build environment | `NODE_VERSION=22` |
| Preview-only environment variable | `PIP_PREVIEW_ONLY=true` |

The Preview marker is not a secret. Set it only in Preview, not Production.
The build command refuses other branches and environments before running
`pnpm test:all` and `pnpm build`. Keep pnpm selected via `packageManager`;
the lockfile must be installed without changes.

During first-time setup, if Pages requires an initial production build, do not
add the Preview marker to make it pass. The guard should reject it. Disable
automatic production deployments and configure the release Preview before
retrying. The configuration must be committed to the branch being built.

Cloudflare calls this environment **Preview**; it is our dev environment.
The branch alias is `release.<project-subdomain>.pages.dev`. No separate Git
branch named dev is required. Pages honors `public/_headers`, including SW
revalidation and extensionless image MIME types. Verify resource integrity
and offline installation against the real preview URL after deployment.

Do not add production backend or analytics configuration to Preview.
Local play and offline resources work without an account backend.
No automatic version bump, tag, GitHub release or production deployment runs.

The earlier Vercel configuration and Actions-based Cloudflare uploader have
been removed. The previously created GitHub dev environment is unused by the
native Git integration; it does not need deployment secrets.

See [Cloudflare Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/)
and [branch controls](https://developers.cloudflare.com/pages/configuration/branch-build-controls/).

### Versioning & cache-busting

Two values are injected at build (`next.config.ts` → `env`) and inlined into the
client bundle:

- `NEXT_PUBLIC_APP_VERSION` — the human version, read from `package.json`. Shown in
  the Settings footer (`Pip v0.1.0 · <build id>`).
- `NEXT_PUBLIC_BUILD_ID` — the git short SHA. Uniquely identifies each deploy.

The service worker's cache name is `pip-__BUILD_ID__`; `scripts/stamp-sw.mjs` (run
by `pnpm build`, after `next build`) stamps the git short SHA into `out/sw.js`. So
**every deploy ships a byte-different `sw.js`** → the browser installs a new worker
→ `activate` purges the old cache. That's the cache-bust.

On an update the new worker **waits** rather than taking over silently.
`useServiceWorkerUpdate` (registered from `UpdatePrompt`, mounted in the root
layout) detects the waiting worker — re-checking hourly and whenever the tab regains
focus — and shows a "new version is ready → Reload" nudge. Reload posts
`SKIP_WAITING`; the worker activates and the page reloads onto the new assets. See
[data-and-offline.md](./data-and-offline.md#offline-the-service-worker) for the
offline caching strategy itself.
