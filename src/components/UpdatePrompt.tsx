'use client'

import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useGame } from '@/store/game'
import { sound } from '@/lib/sound'
import { useOffline, useServiceWorkerUpdate } from '@/lib/useServiceWorker'

/** Persistent status in Settings; a successful registration alone does not mean offline-ready. */
export function OfflineStatus() {
  const { status, error, retry } = useOffline()
  if (status === 'development') return null
  return (
    <div className="text-center text-xs text-muted-foreground">
      <p role="status">
        {status === 'ready'
          ? 'Ready to play offline.'
          : status === 'unavailable'
            ? 'Offline downloads are unavailable in this browser.'
            : error
              ? 'Offline download incomplete. Connect and try again.'
              : 'Preparing offline play…'}
      </p>
      {error && status === 'ready' && (
        <p>Your saved version works offline. The update could not finish.</p>
      )}
      {error && (
        <Button variant="ghost" size="sm" className="min-h-11" onClick={retry}>
          Retry download
        </Button>
      )}
    </div>
  )
}

function safeToReload() {
  return !location.pathname.startsWith('/play/') && useGame.getState().venue === null
}

export function UpdatePrompt() {
  const { updateReady, applyUpdate, applying, blocked } = useServiceWorkerUpdate(safeToReload)
  const pathname = usePathname()
  // No overlay over a live table's actions. The update stays waiting.
  if (!updateReady || pathname.startsWith('/play/')) return null

  return (
    <div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="flex max-w-lg items-center gap-3 rounded-2xl border border-border bg-background px-4 py-3 text-foreground shadow-lg">
        <p role="status" className="text-sm">
          {blocked
            ? 'Finish or leave tables in other tabs, then retry. Close older Pip tabs if needed.'
            : 'A new version of Pip is ready.'}
        </p>
        <Button
          variant="secondary"
          className="min-h-11"
          disabled={applying}
          onClick={() => {
            sound.play('tap')
            void applyUpdate()
          }}
        >
          {applying ? 'Checking…' : 'Reload'}
        </Button>
      </div>
    </div>
  )
}
