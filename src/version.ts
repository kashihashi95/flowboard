declare const __FLOWBOARD_VERSION__: string
declare const __FLOWBOARD_BUILT__: string

/** This build's commit (short) and build date, set in vite.config.ts. "dev" for local builds. */
export const VERSION = __FLOWBOARD_VERSION__
export const BUILT = __FLOWBOARD_BUILT__

/** The live Flowboard, which is always the newest version. */
export const LATEST_URL = 'https://kashihashi95.github.io/flowboard/'

export type UpdateResult =
  | { kind: 'current' }
  | { kind: 'newer'; built: string }
  | { kind: 'dev'; built: string }
  | { kind: 'failed' }

/** Asks the live site which version it serves. Only called when the user clicks
 *  Check for updates; nothing about the board is sent. */
export async function checkForUpdate(): Promise<UpdateResult> {
  try {
    const res = await fetch(`${LATEST_URL}version.json`, { cache: 'no-store' })
    if (!res.ok) return { kind: 'failed' }
    const latest = (await res.json()) as { version?: string; built?: string }
    if (typeof latest.version !== 'string') return { kind: 'failed' }
    const built = typeof latest.built === 'string' ? latest.built : ''
    if (VERSION === 'dev') return { kind: 'dev', built }
    return latest.version === VERSION ? { kind: 'current' } : { kind: 'newer', built }
  } catch {
    return { kind: 'failed' }
  }
}
