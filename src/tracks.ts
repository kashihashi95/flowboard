import { storageKey } from './store'
import type { Doc } from './types'

/** A saved moment in a board's history, to compare later versions against. */
export interface TrackPoint {
  id: string
  /** When it was made (ms since 1970). */
  at: number
  label: string
  doc: Doc
}

// Snapshots can be large (pictures), so they live in IndexedDB rather than localStorage.
const DB = 'flowboard-tracks'
const STORE = 'tracks'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const full = (key: string) => `${storageKey}|${key}`

export async function loadTrack(key: string): Promise<TrackPoint[]> {
  try {
    const db = await open()
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(full(key))
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : [])
      req.onerror = () => reject(req.error)
    })
  } catch {
    return []
  }
}

/** Returns false when the browser wouldn't store it. */
export async function saveTrack(key: string, points: TrackPoint[]): Promise<boolean> {
  try {
    const db = await open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(points, full(key))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    return true
  } catch {
    return false
  }
}

/** Which history the open board belongs to (its file, or the board itself). */
export function currentTrackKey(): string {
  try {
    return localStorage.getItem(`${storageKey}.track`) ?? 'board'
  } catch {
    return 'board'
  }
}

export function rememberTrackKey(key: string): void {
  try {
    localStorage.setItem(`${storageKey}.track`, key)
  } catch {
    /* falls back to 'board' next time */
  }
}
