// Run last: the worker pins every exported resource to one complete release.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/',
  '.woff': 'font/',
  '.woff2': 'font/',
  '.mp4': 'video/mp4',
  '.xml': '',
}

/** Exported for the fixture test; no bundler or service-worker dependency. */
export function stampWorker(directory, template) {
  const assets = []
  function walk(relative = '') {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(name)
        continue
      }
      if (
        name === 'sw.js' ||
        name.startsWith('screenshots/') ||
        name === 'icons/icon-source-1024.png'
      )
        continue
      const type = TYPES[extname(name)]
      // Deployment metadata, source art and marketing text mirrors aren't app resources.
      if (type === undefined && !name.endsWith('opengraph-image')) continue
      const bytes = readFileSync(join(directory, name))
      const url = name === 'index.html' ? '/' : `/${name.replace(/\.html$/, '')}`
      assets.push({
        url,
        integrity: `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
        type: type ?? 'image/png',
      })
    }
  }
  walk()
  assets.sort((a, b) => a.url.localeCompare(b.url, 'en'))
  for (const required of ['/', '/404', '/game']) {
    if (!assets.some((asset) => asset.url === required))
      throw new Error(`Missing offline route: ${required}`)
  }
  const contentId = createHash('sha256')
    .update(template)
    .update(JSON.stringify(assets))
    .digest('hex')
    .slice(0, 16)
  if (!template.includes('/*__PRECACHE__*/ []') || !template.includes('__CONTENT_ID__'))
    throw new Error('Missing SW build placeholders')
  writeFileSync(
    join(directory, 'sw.js'),
    template
      .replace('__CONTENT_ID__', contentId)
      .replace('/*__PRECACHE__*/ []', JSON.stringify(assets)),
  )
  return { contentId, count: assets.length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = stampWorker(
    fileURLToPath(new URL('../out/', import.meta.url)),
    readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'),
  )
  console.log(`stamp-sw: ${result.count} resources, pip-offline-${result.contentId}`)
}
