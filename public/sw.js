// Generated from the final static export. No account responses or user data are cached.
const CACHE = 'pip-offline-__CONTENT_ID__'
const ASSETS = /*__PRECACHE__*/ []
const FILES = new Map(ASSETS.map((asset) => [asset.url, asset]))
const OWN_CACHE = /^pip-offline-[a-f0-9]{16}$/
const LEGACY_CACHE = /^pip-[a-f0-9]{7,40}$/

async function tellClients(message) {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    client.postMessage(message)
  }
}

let downloading = null
function download() {
  if (downloading) return downloading
  downloading = (async () => {
    const cache = await caches.open(CACHE)
    // Bound network/memory use, and wait for every writer before reporting a failure.
    for (let offset = 0; offset < ASSETS.length; offset += 8) {
      const results = await Promise.allSettled(
        ASSETS.slice(offset, offset + 8).map(async (asset) => {
          if (await cache.match(asset.url)) return
          const response = await fetch(new URL(asset.url, location.origin), {
            cache: 'reload',
            integrity: asset.integrity,
            signal: AbortSignal.timeout(30000),
          })
          const type = response.headers.get('Content-Type') ?? ''
          if (!response.ok || (asset.type && !type.startsWith(asset.type))) {
            throw new Error(`Offline download failed: ${asset.url}`)
          }
          await cache.put(asset.url, response)
        }),
      )
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Offline download incomplete')
    }
  })().finally(() => {
    downloading = null
  })
  return downloading
}

self.addEventListener('install', (event) => {
  // Never skipWaiting here. A failed new release must not replace the working one.
  event.waitUntil(
    download().catch(async (error) => {
      await caches.delete(CACHE)
      await tellClients({ type: 'OFFLINE_ERROR' })
      throw error
    }),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Keep the previous release for clients finishing their reload, including old hashed chunks.
      const keys = (await caches.keys()).filter(
        (key) => key !== CACHE && (OWN_CACHE.test(key) || LEGACY_CACHE.test(key)),
      )
      await Promise.all(keys.slice(0, -1).map((key) => caches.delete(key)))
      await self.clients.claim()
    })(),
  )
})

async function complete() {
  const keys = new Set(
    (await (await caches.open(CACHE)).keys()).map((r) => new URL(r.url).pathname),
  )
  return ASSETS.length > 0 && ASSETS.every((asset) => keys.has(asset.url))
}

// A hidden, busy or pre-upgrade client that cannot answer vetoes the update.
function canReload(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const finish = (safe) => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(safe)
    }
    const timer = setTimeout(() => finish(false), 2000)
    channel.port1.onmessage = (event) => finish(event.data === true)
    try {
      client.postMessage({ type: 'CAN_RELOAD' }, [channel.port2])
    } catch {
      finish(false)
    }
  })
}

self.addEventListener('message', (event) => {
  const reply = (message) => event.ports?.[0]?.postMessage(message)
  if (event.data?.type === 'STATUS') {
    event.waitUntil(complete().then((ready) => reply({ ready })))
  } else if (event.data?.type === 'RETRY_OFFLINE') {
    event.waitUntil(
      download()
        .then(() => reply({ ready: true }))
        .catch(() => reply({ ready: false })),
    )
  } else if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        const safe = await Promise.all(clients.map(canReload))
        if (!safe.every(Boolean) || !(await complete())) {
          reply({ blocked: true })
          return
        }
        reply({ blocked: false })
        await self.skipWaiting()
      })(),
    )
  }
})

function assetPath(request) {
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== location.origin) return null
  let path = url.pathname
  if (request.mode === 'navigate') {
    path = path.replace(/\.html$/, '').replace(/\/$/, '') || '/'
    if (path === '/index') path = '/'
  }
  // Only listed, immutable export files may ignore query strings. Client URL semantics
  // (e.g. tutorial?from=onboarding) stay intact; no queried network response is stored.
  return FILES.has(path) ? path : null
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== location.origin) return
  const path = assetPath(request)
  if (path) {
    event.respondWith(
      (async () => {
        const hit = await (await caches.open(CACHE)).match(path)
        // A storage eviction is recoverable online, but never silently marks us offline-ready.
        return hit ?? fetch(request)
      })(),
    )
  } else if (url.pathname.startsWith('/_next/static/')) {
    // Only content-hashed Next assets can be borrowed from the previous release.
    event.respondWith(
      (async () => {
        for (const key of (await caches.keys())
          .filter((k) => OWN_CACHE.test(k) || LEGACY_CACHE.test(k))
          .reverse()) {
          const hit = await (await caches.open(key)).match(request)
          if (hit) return hit
        }
        return fetch(request)
      })(),
    )
  } else if (request.mode === 'navigate') {
    // Unknown routes must not show another page or mix a newer document with this release.
    event.respondWith(
      (async () => {
        const page = await (await caches.open(CACHE)).match('/404')
        return new Response(page ? await page.text() : 'Page unavailable offline.', {
          status: 404,
          headers: { 'Content-Type': page ? 'text/html; charset=utf-8' : 'text/plain' },
        })
      })(),
    )
  }
})
