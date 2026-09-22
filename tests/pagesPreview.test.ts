import test from 'ava'
import { readFileSync } from 'node:fs'
import { assertReleasePreview } from '../scripts/check-pages-preview.mjs'

test('Cloudflare Git builds require release and the Preview-only environment marker', (t) => {
  const preview = { CF_PAGES: '1', CF_PAGES_BRANCH: 'release', PIP_PREVIEW_ONLY: 'true' }
  t.notThrows(() => assertReleasePreview(preview))
  for (const env of [
    {},
    { ...preview, CF_PAGES: undefined },
    { ...preview, CF_PAGES_BRANCH: 'main' },
    { ...preview, PIP_PREVIEW_ONLY: undefined },
    { ...preview, PIP_PREVIEW_ONLY: 'false' },
  ]) {
    t.throws(() => assertReleasePreview(env))
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  t.is(
    pkg.scripts['build:preview'],
    'node scripts/check-pages-preview.mjs && pnpm test:all && pnpm build',
  )
})
