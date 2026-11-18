/** A folder on the computer that Flowboard opens charts from and saves them
 *  to, using the browser's File System Access API (Chrome and Edge). The
 *  folder is remembered between visits; the browser asks once per visit
 *  before Flowboard can use it again. */

type Dir = FileSystemDirectoryHandle
type FileH = FileSystemFileHandle

export interface WorkspaceFile {
  /** Path inside the workspace, with / between folders. */
  path: string
  handle: FileH
  modified: number
}

export const workspaceSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

// ---------- remembering the folder (IndexedDB holds the handle) ----------

const DB = 'flowboard'
const STORE = 'handles'

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(req.error)
  })
}

export async function savedWorkspace(): Promise<Dir | null> {
  try {
    return (await idb<Dir | undefined>('readonly', (s) => s.get('workspace'))) ?? null
  } catch {
    return null
  }
}

/** Every folder used as a workspace, most recent first. */
export async function recentWorkspaces(): Promise<Dir[]> {
  try {
    return (await idb<Dir[] | undefined>('readonly', (s) => s.get('recent'))) ?? []
  } catch {
    return []
  }
}

async function remember(dir: Dir | null) {
  try {
    await idb('readwrite', (s) => (dir ? s.put(dir, 'workspace') : s.delete('workspace')))
    if (dir) {
      const rest: Dir[] = []
      for (const d of await recentWorkspaces()) if (!(await d.isSameEntry(dir))) rest.push(d)
      await idb('readwrite', (s) => s.put([dir, ...rest].slice(0, 12), 'recent'))
    }
  } catch {
    /* not remembered; still usable this visit */
  }
}

/** Make a folder from the list the current workspace again. */
export const useWorkspace = (dir: Dir) => remember(dir)

/** Take a folder off the list (the folder itself is untouched). */
export async function forgetRecent(dir: Dir) {
  const rest: Dir[] = []
  for (const d of await recentWorkspaces()) if (!(await d.isSameEntry(dir))) rest.push(d)
  await idb('readwrite', (s) => s.put(rest, 'recent'))
}

// ---------- permission ----------

type Perm = { mode: 'readwrite' }
type WithPerm = { queryPermission(p: Perm): Promise<PermissionState>; requestPermission(p: Perm): Promise<PermissionState> }

export async function hasAccess(dir: Dir): Promise<boolean> {
  return (await (dir as unknown as WithPerm).queryPermission({ mode: 'readwrite' })) === 'granted'
}

/** Ask for access again (must run from a click or key press). */
export async function requestAccess(dir: Dir): Promise<boolean> {
  const h = dir as unknown as WithPerm
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted'
}

export async function pickWorkspace(): Promise<Dir | null> {
  try {
    const pick = (window as unknown as { showDirectoryPicker(o: object): Promise<Dir> }).showDirectoryPicker
    const dir = await pick({ id: 'flowboard-workspace', mode: 'readwrite', startIn: 'documents' })
    await remember(dir)
    return dir
  } catch (err) {
    // Closing the picker isn't an error; anything else (such as running inside
    // a sandboxed preview) is passed on.
    if ((err as DOMException)?.name === 'AbortError') return null
    throw err
  }
}

export const forgetWorkspace = () => remember(null)

// ---------- files ----------

const BOARD = /\.(md|markdown|json|html?)$/i
// Build and engine folders hold thousands of files and never charts.
const SKIP = new Set(['node_modules', 'Library', 'Temp', 'Logs', 'obj', 'bin', 'build', 'dist', 'Packages', 'ProjectSettings', 'UserSettings'])

/** Charts in the workspace, its subfolders too (a few levels down), newest first. */
export async function listBoards(dir: Dir): Promise<WorkspaceFile[]> {
  const out: WorkspaceFile[] = []
  const walk = async (d: Dir, prefix: string, depth: number) => {
    for await (const entry of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (entry.kind === 'file' && BOARD.test(entry.name)) {
        const handle = entry as FileH
        const file = await handle.getFile()
        out.push({ path: prefix + entry.name, handle, modified: file.lastModified })
      } else if (entry.kind === 'directory' && depth < 3 && !entry.name.startsWith('.') && !SKIP.has(entry.name) && out.length < 500) {
        await walk(entry as Dir, `${prefix}${entry.name}/`, depth + 1)
      }
    }
  }
  await walk(dir, '', 0)
  return out.sort((a, b) => b.modified - a.modified)
}

export async function writeFile(handle: FileH, text: string | Blob) {
  const w = await (handle as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable()
  await w.write(text)
  await w.close()
}

/** A file named `name` in the workspace (made if missing). */
export async function fileIn(dir: Dir, name: string): Promise<FileH> {
  return dir.getFileHandle(name, { create: true })
}

export async function exists(dir: Dir, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

/** Where a file sits inside the workspace, or null if it's elsewhere. */
export async function pathIn(dir: Dir, handle: FileH): Promise<string | null> {
  const parts = await (dir as unknown as { resolve(h: FileSystemHandle): Promise<string[] | null> }).resolve(handle)
  return parts ? parts.join('/') : null
}
