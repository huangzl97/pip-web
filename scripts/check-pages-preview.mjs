import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// PIP_PREVIEW_ONLY must be configured only in Pages' Preview environment.
export function assertReleasePreview(env) {
  if (
    env.CF_PAGES !== '1' ||
    env.CF_PAGES_BRANCH !== 'release' ||
    env.PIP_PREVIEW_ONLY !== 'true'
  ) {
    throw new Error(
      'Only release Preview builds are enabled. Set PIP_PREVIEW_ONLY=true in Preview only.',
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertReleasePreview(process.env)
}
