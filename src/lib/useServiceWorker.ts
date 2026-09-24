'use client'

import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

const UPDATE_INTERVAL_MS = 60 * 60 * 1000

type OfflineStatus = 'preparing' | 'ready' | 'unavailable' | 'development'

// Registration has one owner (UpdatePrompt); Settings reads the same status.
export const useOffline = create<{
  status: OfflineStatus
  error: boolean
  retry: () => void
}>(() => ({
  status: process.env.NODE_ENV === 'production' ? 'preparing' : 'development',
  error: false,
  retry: () => {},
}))

function message(worker: ServiceWorker, type: string, timeout = 4000) {
  return new Promise<{ ready?: boolean; blocked?: boolean }>((resolve, reject) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => {
      channel.port1.close()
      reject(new Error('Worker unavailable'))
    }, timeout)
    channel.port1.onmessage = (event) => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(event.data)
    }
    worker.postMessage({ type }, [channel.port2])
  })
}

export function useServiceWorkerUpdate(safeToReload: () => boolean) {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [applying, setApplying] = useState(false)
  const reloading = useRef(false)

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) {
      queueMicrotask(() => useOffline.setState({ status: 'unavailable' }))
      return
    }
    let registration: ServiceWorkerRegistration | null = null
    let disposed = false
    const inspected = new WeakSet<ServiceWorker>()
    const fail = () => {
      if (!disposed) useOffline.setState({ error: true })
    }
    const inspect = async () => {
      const controller = navigator.serviceWorker.controller
      if (!controller) return
      try {
        const { ready } = await message(controller, 'STATUS')
        if (!disposed) useOffline.setState({ status: ready ? 'ready' : 'preparing', error: !ready })
      } catch {
        fail()
      }
    }
    const offer = () => {
      if (!disposed && registration?.waiting && navigator.serviceWorker.controller)
        setWaiting(registration.waiting)
    }
    const watch = () => {
      const installing = registration?.installing
      if (!installing || inspected.has(installing)) return
      inspected.add(installing)
      installing.addEventListener('statechange', () => {
        if (disposed) return
        if (installing.state === 'installed') {
          offer()
          void inspect()
        }
        if (installing.state === 'redundant') fail()
      })
    }
    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
        if (disposed) return
        registration = reg
        reg.addEventListener('updatefound', watch)
        watch()
        offer()
        await inspect()
      } catch {
        fail()
      }
    }
    const retry = async () => {
      useOffline.setState({ error: false })
      if (!registration || (!registration.active && !registration.installing)) {
        await register()
        return
      }
      try {
        const controller = navigator.serviceWorker.controller
        if (controller && !registration.waiting) {
          const { ready } = await message(controller, 'RETRY_OFFLINE', 120000)
          if (!disposed)
            useOffline.setState({ status: ready ? 'ready' : 'preparing', error: !ready })
        }
        await registration.update()
        watch()
        offer()
      } catch {
        fail()
      }
    }
    // Assignment is not a React render update; the owner is the global registration.
    useOffline.setState({
      retry: () => {
        void retry()
      },
    })
    void register()

    let controlled = Boolean(navigator.serviceWorker.controller)
    const onControllerChange = () => {
      const wasControlled = controlled
      controlled = true
      void inspect()
      if (reloading.current || !wasControlled) return
      // Re-check after the worker's cross-tab vote in case the user entered a table meanwhile.
      if (!safeToReload()) {
        setBlocked(true)
        return
      }
      reloading.current = true
      location.reload()
    }
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'CAN_RELOAD') event.ports[0]?.postMessage(safeToReload())
      if (event.data?.type === 'OFFLINE_ERROR') fail()
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    navigator.serviceWorker.addEventListener('message', onMessage)
    const check = () => {
      void inspect()
      void registration?.update().catch(fail)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    const interval = setInterval(check, UPDATE_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', check)
    return () => {
      disposed = true
      clearInterval(interval)
      registration?.removeEventListener('updatefound', watch)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      navigator.serviceWorker.removeEventListener('message', onMessage)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', check)
    }
  }, [safeToReload])

  return {
    updateReady: waiting !== null,
    blocked,
    applying,
    applyUpdate: async () => {
      if (!waiting || applying) return
      if (!safeToReload()) {
        setBlocked(true)
        return
      }
      if (waiting.state === 'activated' || waiting.state === 'redundant') {
        location.reload()
        return
      }
      setApplying(true)
      try {
        setBlocked(Boolean((await message(waiting, 'SKIP_WAITING')).blocked))
      } catch {
        setBlocked(true)
      } finally {
        setApplying(false)
      }
    },
  }
}
