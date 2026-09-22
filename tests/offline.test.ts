import test from 'ava'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stampWorker } from '../scripts/stamp-sw.mjs'
import { runInNewContext } from 'node:vm'

const origin = 'https://pip.test'
const assets = [
  { url: '/', integrity: 'sha256-home', type: 'text/html' },
  { url: '/stats', integrity: 'sha256-stats', type: 'text/html' },
  { url: '/404', integrity: 'sha256-404', type: 'text/html' },
  { url: '/game/drills.txt', integrity: 'sha256-data', type: 'text/plain' },
  { url: '/_next/static/app.js', integrity: 'sha256-js', type: 'application/javascript' },
]

type WorkerEvent = {
  request?: { url: string; method: string; mode: string }
  data?: { type: string }
  ports?: { postMessage: (value: unknown) => void }[]
  waitUntil: (promise: Promise<unknown>) => void
  respondWith: (promise: Promise<Response>) => void
}

function worker(votes: boolean[] = [], quotaFailure = false) {
  let activated = false
  const buckets = new Map<string, Map<string, Response>>()
  const handlers: Record<string, (event: WorkerEvent) => void> = {}
  const key = (input: string | Request | URL) =>
    new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      origin,
    ).href
  let offline = false
  let failedPath = ''
  const cache = async (name: string) => {
    if (!buckets.has(name)) buckets.set(name, new Map())
    const data = buckets.get(name)!
    return {
      keys: async () => [...data.keys()].map((url) => new Request(url)),
      match: async (input: string | Request | URL) => data.get(key(input))?.clone(),
      put: async (input: string | Request | URL, response: Response) => {
        if (quotaFailure) throw new Error('QuotaExceededError')
        data.set(key(input), response.clone())
      },
      add: async (url: string) => {
        data.set(key(url), await fetcher(url))
      },
    }
  }
  const fetcher = async (input: string | Request | URL) => {
    const path = new URL(key(input)).pathname
    if (offline || path === failedPath) throw new Error('Network unavailable')
    const asset = assets.find((a) => a.url === path)
    return new Response(path === '/stats' ? 'Stats' : path, {
      status: asset ? 200 : 404,
      headers: { 'Content-Type': asset?.type ?? 'text/plain' },
    })
  }
  const caches = {
    open: cache,
    keys: async () => [...buckets.keys()],
    delete: async (name: string) => buckets.delete(name),
    match: async (input: string | Request | URL) => {
      for (const bucket of buckets.values()) {
        const hit = bucket.get(key(input))
        if (hit) return hit.clone()
      }
    },
  }
  runInNewContext(
    readFileSync('public/sw.js', 'utf8')
      .replaceAll('__BUILD_ID__', 'test')
      .replaceAll('__CONTENT_ID__', '0123456789abcdef')
      .replace('/*__PRECACHE__*/ []', JSON.stringify(assets)),
    {
      self: {
        addEventListener: (name: string, handler: (event: WorkerEvent) => void) => {
          handlers[name] = handler
        },
        clients: {
          claim: async () => {},
          matchAll: async () =>
            votes.map((vote) => ({
              postMessage: (_message: unknown, ports?: MessagePort[]) =>
                ports?.[0]?.postMessage(vote),
            })),
        },
        skipWaiting: async () => {
          activated = true
        },
      },
      caches,
      location: { origin },
      fetch: fetcher,
      URL,
      Request,
      Response,
      AbortSignal,
      setTimeout,
      clearTimeout,
      MessageChannel,
    },
  )
  return {
    buckets,
    activated: () => activated,
    cache,
    offline: () => {
      offline = true
    },
    fail: (path: string) => {
      failedPath = path
    },
    async dispatch(name: string, extra = {}) {
      let pending: Promise<unknown> = Promise.resolve()
      handlers[name]({
        ...extra,
        waitUntil: (p) => {
          pending = p
        },
        respondWith: (p) => {
          pending = p
        },
      })
      return (await pending) as Response | undefined
    },
    async get(path: string, mode = 'navigate') {
      return this.dispatch('fetch', { request: { url: origin + path, method: 'GET', mode } })
    },
  }
}

test('offline direct navigation returns the requested page, including an unvisited route', async (t) => {
  const sw = worker()
  await sw.dispatch('install')
  await sw.get('/')
  sw.offline()
  const response = await sw.get('/stats')
  t.is(await response?.text(), 'Stats')
})

test('RSC data is available offline and never replaced by HTML', async (t) => {
  const sw = worker()
  await sw.dispatch('install')
  sw.offline()
  const response = await sw.get('/game/drills.txt?_rsc=changing-token', 'cors')
  t.is(await response?.text(), '/game/drills.txt')
  t.is(response?.headers.get('Content-Type'), 'text/plain')
})

test('an incomplete install rejects, leaving other caches untouched', async (t) => {
  const sw = worker()
  await (await sw.cache('unrelated-app')).put('/', new Response('Keep'))
  sw.fail('/stats')
  await t.throwsAsync(sw.dispatch('install'))
  t.is(await (await sw.cache('unrelated-app')).match('/').then((r) => r?.text()), 'Keep')
})

test('unknown offline navigations are 404s rather than an unrelated cached page', async (t) => {
  const sw = worker()
  await sw.dispatch('install')
  sw.offline()
  t.is((await sw.get('/not-a-route'))?.status, 404)
})

test('activation only removes older Pip caches and retains the previous release', async (t) => {
  const sw = worker()
  await sw.cache('pip-offline-1111111111111111')
  await sw.cache('unrelated-app')
  await sw.cache('pip-offline-2222222222222222')
  await sw.dispatch('install')
  await sw.dispatch('activate')
  t.false(sw.buckets.has('pip-offline-1111111111111111'))
  t.true(sw.buckets.has('pip-offline-2222222222222222'))
  t.true(sw.buckets.has('unrelated-app'))
})

test('quota failure prevents installation, without declaring offline ready', async (t) => {
  const sw = worker([], true)
  await t.throwsAsync(sw.dispatch('install'))
  t.is(sw.buckets.size, 0)
})

test('every client must approve before an update can take over', async (t) => {
  for (const votes of [
    [true, false],
    [true, true],
  ]) {
    const sw = worker(votes)
    await sw.dispatch('install')
    let reply: unknown
    await sw.dispatch('message', {
      data: { type: 'SKIP_WAITING' },
      ports: [
        {
          postMessage: (value: unknown) => {
            reply = value
          },
        },
      ],
    })
    t.deepEqual(reply, { blocked: !votes.every(Boolean) })
    t.is(sw.activated(), votes.every(Boolean))
  }
})

test('content changes at the same commit change the cache ID; output is repeatable', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pip-offline-'))
  try {
    for (const file of ['index.html', '404.html', 'game.html'])
      writeFileSync(join(dir, file), '<html>Original</html>')
    mkdirSync(join(dir, 'game'))
    writeFileSync(join(dir, 'game', '__next._tree.txt'), 'route data')
    writeFileSync(join(dir, '_headers'), 'not a fetchable file')
    const template = readFileSync('public/sw.js', 'utf8')
    const first = stampWorker(dir, template)
    t.deepEqual(stampWorker(dir, template), first)
    writeFileSync(join(dir, 'game.html'), '<html>Changed</html>')
    t.not(stampWorker(dir, template).contentId, first.contentId)
    const sw = readFileSync(join(dir, 'sw.js'), 'utf8')
    t.true(sw.includes('/game/__next._tree.txt'))
    t.false(sw.includes('"url":"/_headers"'))
    t.is(first.count, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
