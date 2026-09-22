import test from 'ava'
import { useSync } from '@/store/sync'
import { useMembership } from '@/store/entitlement'

test('membership cache survives pending session restoration, but is cleared after confirmed sign-out', (t) => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const entries = new Map([['pip.membership', 'saved membership']])
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    },
  })
  try {
    useSync.setState({ status: 'signed-out', ready: false })
    useMembership.getState().start()
    t.is(entries.get('pip.membership'), 'saved membership')
    t.false(useMembership.getState().checked)
    useSync.setState({ ready: true })
    t.false(entries.has('pip.membership'))
    t.true(useMembership.getState().checked)
    t.false(useMembership.getState().member)
  } finally {
    if (old) Object.defineProperty(globalThis, 'localStorage', old)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
