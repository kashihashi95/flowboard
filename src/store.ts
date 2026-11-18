import { useCallback, useRef, useState } from 'react'
import { insideRect } from './geometry'
import { fitToText } from './richtext'
import type { TrackPoint } from './tracks'
import type { Doc, EdgeEl, NodeEl, ShapeKind, View } from './types'

export const uid = () => Math.random().toString(36).slice(2, 10)

const HISTORY_LIMIT = 200

/** Document state with undo/redo. `commit` records a history step; `live`
 *  updates without one (used mid-drag), and `record(before)` later turns the
 *  whole drag into a single step. */
export function useHistory(initial: Doc) {
  const [doc, setDoc] = useState(initial)
  const docRef = useRef(doc)
  const past = useRef<Doc[]>([])
  const future = useRef<Doc[]>([])
  const [, force] = useState(0)

  const set = useCallback((next: Doc) => {
    docRef.current = next
    setDoc(next)
  }, [])

  const record = useCallback((before: Doc) => {
    if (before === docRef.current) return
    past.current.push(before)
    if (past.current.length > HISTORY_LIMIT) past.current.shift()
    future.current = []
    force((x) => x + 1)
  }, [])

  const commit = useCallback(
    (fn: (d: Doc) => Doc) => {
      const before = docRef.current
      const next = fn(before)
      if (next === before) return
      set(next)
      record(before)
    },
    [set, record],
  )

  const live = useCallback((fn: (d: Doc) => Doc) => set(fn(docRef.current)), [set])

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (!prev) return
    future.current.push(docRef.current)
    set(prev)
  }, [set])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    past.current.push(docRef.current)
    set(next)
  }, [set])

  const reset = useCallback(
    (d: Doc) => {
      past.current = []
      future.current = []
      set(d)
    },
    [set],
  )

  return {
    doc,
    docRef,
    commit,
    live,
    record,
    undo,
    redo,
    reset,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  }
}

// ---------- document operations ----------

export const DEFAULT_SIZE: Record<ShapeKind, { w: number; h: number }> = {
  rect: { w: 160, h: 80 },
  rounded: { w: 160, h: 64 },
  diamond: { w: 160, h: 112 },
  ellipse: { w: 140, h: 90 },
  parallelogram: { w: 170, h: 80 },
  cylinder: { w: 120, h: 100 },
  hexagon: { w: 170, h: 80 },
  sticky: { w: 200, h: 200 },
  text: { w: 200, h: 30 },
  image: { w: 240, h: 180 },
  section: { w: 480, h: 320 },
}

export function makeNode(kind: ShapeKind, x: number, y: number, w?: number, h?: number, extra: Partial<NodeEl> = {}): NodeEl {
  const size = DEFAULT_SIZE[kind]
  return {
    id: uid(),
    kind,
    x,
    y,
    w: w ?? size.w,
    h: h ?? size.h,
    text: '',
    color: kind === 'sticky' ? 'yellow' : 'ink',
    fontSize: kind === 'text' ? 20 : 16,
    ...extra,
  }
}

export function makeEdge(from: EdgeEl['from'], to: EdgeEl['to'], extra: Partial<EdgeEl> = {}): EdgeEl {
  return {
    id: uid(),
    from,
    to,
    route: 'elbow',
    color: 'ink',
    width: 2,
    dashed: false,
    startHead: 'none',
    endHead: 'triangle',
    label: '',
    ...extra,
  }
}

/** `ids` plus every shape sitting fully inside a selected section, since a
 *  section carries its contents when moved, copied or exported. */
export function withSectionContents(doc: Doc, ids: Set<string>): Set<string> {
  const out = new Set(ids)
  const sections = doc.nodes.filter((n) => n.kind === 'section' && ids.has(n.id))
  for (const s of sections) for (const n of doc.nodes) if (n.id !== s.id && insideRect(s, n)) out.add(n.id)
  return out
}

export function nextSectionName(doc: Doc): string {
  return `Section ${doc.nodes.filter((n) => n.kind === 'section').length + 1}`
}

/** Sections first so they draw behind everything else; otherwise keeps order. */
export const drawOrder = (nodes: NodeEl[]) => [...nodes.filter((n) => n.kind === 'section'), ...nodes.filter((n) => n.kind !== 'section')]

/** Remove the given ids, plus any connector attached to a removed shape. */
export function deleteIds(doc: Doc, ids: Set<string>): Doc {
  const nodes = doc.nodes.filter((n) => !ids.has(n.id))
  const gone = new Set(doc.nodes.filter((n) => ids.has(n.id)).map((n) => n.id))
  const edges = doc.edges.filter(
    (e) => !ids.has(e.id) && !(e.from.nodeId && gone.has(e.from.nodeId)) && !(e.to.nodeId && gone.has(e.to.nodeId)),
  )
  return { nodes, edges }
}

/** Copy of the selection: shapes, selected connectors, and connectors running
 *  between two copied shapes. Ends pointing outside the copy become free. */
export function extract(doc: Doc, ids: Set<string>): Doc {
  const nodes = doc.nodes.filter((n) => ids.has(n.id))
  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges = doc.edges
    .filter((e) => ids.has(e.id) || (e.from.nodeId && e.to.nodeId && nodeIds.has(e.from.nodeId) && nodeIds.has(e.to.nodeId)))
    .map((e) => ({
      ...e,
      from: e.from.nodeId && !nodeIds.has(e.from.nodeId) ? { x: e.from.x, y: e.from.y } : e.from,
      to: e.to.nodeId && !nodeIds.has(e.to.nodeId) ? { x: e.to.x, y: e.to.y } : e.to,
    }))
  return { nodes, edges }
}

/** Fresh ids and an offset, ready to paste. */
export function cloneDoc(part: Doc, dx: number, dy: number): Doc {
  const map = new Map<string, string>()
  const nodes = part.nodes.map((n) => {
    const id = uid()
    map.set(n.id, id)
    return { ...n, id, x: n.x + dx, y: n.y + dy }
  })
  const moveEnd = (end: EdgeEl['from']) =>
    end.nodeId ? { ...end, nodeId: map.get(end.nodeId) ?? end.nodeId } : { x: end.x + dx, y: end.y + dy }
  const edges = part.edges.map((e) => ({ ...e, id: uid(), from: moveEnd(e.from), to: moveEnd(e.to) }))
  return { nodes, edges }
}

/** Move shapes, plus the free ends of any connectors in `ids`. */
export function translate(doc: Doc, ids: Set<string>, dx: number, dy: number): Doc {
  return {
    nodes: doc.nodes.map((n) => (ids.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
    edges: doc.edges.map((e) => {
      const moveFree = ids.has(e.id)
      const shift = (end: EdgeEl['from']) => (moveFree && !end.nodeId ? { ...end, x: end.x + dx, y: end.y + dy } : end)
      // A hand-adjusted route moves along when both of its ends move.
      const moves = (end: EdgeEl['from']) => (end.nodeId ? ids.has(end.nodeId) : moveFree)
      const points = e.points && moves(e.from) && moves(e.to) ? e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) : e.points
      return moveFree || points !== e.points ? { ...e, from: shift(e.from), to: shift(e.to), points } : e
    }),
  }
}

export function isDoc(v: unknown): v is Doc {
  const d = v as Doc
  return !!d && Array.isArray(d.nodes) && Array.isArray(d.edges)
}

/** Bring boards saved by older versions up to the current format. */
export function normalizeDoc(d: Doc): Doc {
  return {
    nodes: d.nodes,
    edges: d.edges.map((e) => {
      const old = e as EdgeEl & { startArrow?: boolean; endArrow?: boolean }
      if (old.startHead && old.endHead) return e
      const { startArrow, endArrow, ...rest } = old
      return { ...rest, startHead: old.startHead ?? (startArrow ? 'triangle' : 'none'), endHead: old.endHead ?? (endArrow === false ? 'none' : 'triangle') }
    }),
  }
}

// ---------- persistence ----------

/** A board built into this page by "Export → HTML": the app plus one chart. */
interface Embedded {
  id: string
  title: string
  doc: Doc
  /** What a .md leaves out: the timeline, view and toggles. */
  extra?: BoardExtras
}

/** Saved with a board in .html (and .json) files, beyond the board itself. */
export interface BoardExtras {
  view?: View
  tracks?: TrackPoint[]
  settings?: { flow?: boolean; crossColors?: boolean; diff?: boolean }
}

const EMBED_ID = 'flowboard-board'

function parseEmbedded(el: Element | null): Embedded | null {
  try {
    if (!el?.textContent) return null
    const e = JSON.parse(el.textContent) as Embedded
    return isDoc(e.doc) ? { ...e, doc: normalizeDoc(e.doc) } : null
  } catch {
    return null
  }
}

/** The board inside a Flowboard .html file, if it has one. */
export function boardFromHtml(text: string): Embedded | null {
  return parseEmbedded(new DOMParser().parseFromString(text, 'text/html').getElementById(EMBED_ID))
}

const embedded = typeof document !== 'undefined' ? parseEmbedded(document.getElementById(EMBED_ID)) : null

// Local files all share one browser storage, so each exported HTML board
// autosaves under its own key instead of mixing with the main app's board.
const KEY = embedded ? `flowboard.v1:${embedded.id}` : 'flowboard.v1'
/** This page is an exported board opened for the first time in this browser: start from what it carries. */
export const embeddedFirstRun = (() => {
  try {
    return !!embedded && localStorage.getItem(KEY) === null
  } catch {
    return !!embedded
  }
})()
export const storageKey = KEY
export const embeddedBoard = embedded

export interface Saved {
  doc: Doc
  view: View
  title: string
  /** Not saved yet: fit the board to the window on opening. */
  fit?: boolean
}

export function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) {
      if (!embedded) return null
      const v = embedded.extra?.view
      return { doc: embedded.doc, title: embedded.title, view: v ?? { x: 0, y: 0, zoom: 1 }, fit: !v }
    }
    const s = JSON.parse(raw) as Saved
    return isDoc(s.doc) ? { ...s, doc: normalizeDoc(s.doc) } : null
  } catch {
    return null
  }
}

/** Returns false when the browser refused (storage full or blocked). */
export function save(s: Saved): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
    return true
  } catch {
    return false
  }
}

/** This page's HTML with `doc` built in, so the file opens straight to that board. */
export function htmlWithBoard(doc: Doc, title: string, extra?: BoardExtras): string {
  const root = document.documentElement.cloneNode(true) as HTMLElement
  // Back to the page as it loads: an empty app root and no earlier board.
  const appRoot = root.querySelector('#root')
  if (appRoot) appRoot.innerHTML = ''
  root.querySelector(`#${EMBED_ID}`)?.remove()
  root.querySelectorAll('body > :not(#root):not(script)').forEach((el) => el.remove())
  const data: Embedded = { id: Math.random().toString(36).slice(2, 10), title, doc, ...(extra ? { extra } : {}) }
  const tag = document.createElement('script')
  tag.id = EMBED_ID
  tag.type = 'application/json'
  // "<" escaped so text in the board can't end the script tag early.
  tag.textContent = JSON.stringify(data).replace(/</g, '\\u003c')
  root.querySelector('head')?.prepend(tag)
  const titleEl = root.querySelector('title')
  if (titleEl) titleEl.textContent = `${title} · Flowboard`
  return `<!doctype html>\n${root.outerHTML}`
}

export function sampleDoc(): Doc {
  const start = makeNode('rounded', 0, 0, 160, 60, { text: 'Start', color: 'green' })
  const form = makeNode('rect', 0, 140, 180, 80, { text: 'Fill in signup form' })
  const valid = makeNode('diamond', 10, 300, 160, 120, { text: 'Details valid?', color: 'yellow' })
  const save = makeNode('cylinder', 15, 500, 150, 100, { text: 'Save account', color: 'blue' })
  const fix = makeNode('parallelogram', 300, 320, 190, 80, { text: 'Show errors', color: 'red' })
  const end = makeNode('rounded', 10, 680, 160, 60, { text: 'Done', color: 'green' })
  const tip = makeNode('sticky', -330, 120, 240, 240, {
    text: 'Try it:\n• Hover a shape and drag a blue dot to connect\n• Click a dot to add the next step\n• Double-click to edit text\n• Paste or drop images\n• Press ? for shortcuts',
  })
  const nodes = [start, form, valid, save, fix, end, tip].map(fitToText)
  const e = (a: NodeEl, b: NodeEl, extra: Partial<EdgeEl> = {}) =>
    makeEdge({ nodeId: a.id, x: 0, y: 0 }, { nodeId: b.id, x: 0, y: 0 }, extra)
  return {
    nodes,
    edges: [
      e(start, form),
      e(form, valid),
      e(valid, save, { label: 'Yes' }),
      e(valid, fix, { label: 'No' }),
      { ...e(fix, form), to: { nodeId: form.id, side: 'right', x: 0, y: 0 }, from: { nodeId: fix.id, side: 'top', x: 0, y: 0 } },
      e(save, end),
    ],
  }
}
