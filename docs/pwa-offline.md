# Hold’em PWA offline play

This workspace restores the Texas Hold’em product from local `main` at
`85c6629` (v1.24.1), retaining only the offline enhancement. Game rules,
wallets, profile storage, account configuration and membership behavior follow
that baseline. There is no second game or unified archive runtime.

The final build step generates a complete resource manifest with SHA-256
integrity checks. Settings reports **Ready to play offline** only after the
entire download succeeds. Failed installs preserve the previous version;
Settings offers a retry. Updates require every open tab to confirm that it is
safe to reload and never interrupt an active table.

After the initial download, the local game, routes, art and supported local
backup flows work without a network. Login, cloud sync, new membership checks
and external resources still require connectivity. The offline boot fix keeps
cached membership data while account restoration is pending; it does not
unlock paid features or extend their validity.

## Verification

```sh
pnpm test:all
pnpm build
pnpm test:offline
```

The browser test uses an existing Playwright installation; set
`PIP_PLAYWRIGHT_MODULE` to its absolute entry path if it is supplied externally.
It serves temporary copies of `out/` and uses isolated browser contexts. It
checks complete offline resource integrity, cold navigation, drills, file
backup/restore, failed updates, multi-tab update vetoes and retry. No real user
profile is changed. Development mode does not register the service worker;
use the production export to test offline operation.

The original `pip.profile` and `pip.table` storage format is restored. Experimental
archive data is not read or deleted by this version. Keep a backup of experimental
data separately if it is needed; this rollback does not migrate it into the
original profile.

## Local acceptance (2026-09-22)

- `pnpm test:all`: 733 AVA tests plus formatting, types, lint, knip and audit passed.
- `pnpm build`: passed; 468 resources in the offline manifest.
- `pnpm test:offline`: all 11 Chromium 151 checks passed, including every
  resource digest, offline backup/restore and two-release update scenarios.
- `pnpm dev --hostname 127.0.0.1 --port 4174`: local acceptance server;
  removed second-game route returns 404. Real-device installation and CDN
  deployment were not part of this local check.
