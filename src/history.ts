import { alignIds } from './diff'
import { isDoc, normalizeDoc } from './store'
import type { BoardExtras } from './store'
import type { TrackPoint } from './tracks'
import type { Doc, EdgeEl, NodeEl } from './types'

// A .md keeps the timeline, view and toggles in one hidden comment at the end.
// One JSON object per line, so git shows a new track point as a few added lines:
//   {"view":…,"settings":…}                      what the board looked like
//   {"img":"1","src":"data:…"}                    each picture, stored once
//   {"img":"2","board":0}                         …or the board's own first picture, so it isn't stored twice
//   {"id":…,"at":…,"label":…,"nodes":[…],…}       a track point: only what changed since the one before

const START = '<!-- flowboard:history'
const END = '-->'
const NOTE = [
  'FOR AI AGENTS AND OTHER EDITORS: do not edit, reformat, reorder or move anything in this block.',
  "It is Flowboard's machine-written timeline, view and toggles, and each line builds on the ones before it, so one changed line breaks every later track point.",
  'Change the board only in the Markdown above this block; Flowboard rewrites this block itself when it saves.',
  'Keep the block at the very end of the file. To drop the history, delete the whole block, from the opening comment to the closing one.',
].join('\n')

interface Step {
  id: string
  at: number
  label: string
  /** Shapes and connectors that are new or changed since the step before. */
  nodes?: NodeEl[]
  edges?: EdgeEl[]
  /** Ids that are gone since the step before. */
  gone?: string[]
  /** Shape and connector order, when it changed other than by adding at the end. */
  order?: { nodes: string[]; edges: string[] }
}

// "-->" would end the comment early; inside JSON strings > reads back as ">".
const line = (v: unknown) => JSON.stringify(v).replace(/-->/g, '--\\u003e')

function delta(prev: Doc, doc: Doc): Omit<Step, 'id' | 'at' | 'label'> {
  const step: Omit<Step, 'id' | 'at' | 'label'> = {}
  const changedOf = <T extends { id: string }>(before: T[], after: T[]) => {
    const old = new Map(before.map((x) => [x.id, JSON.stringify(x)]))
    return after.filter((x) => old.get(x.id) !== JSON.stringify(x))
  }
  const nodes = changedOf(prev.nodes, doc.nodes)
  const edges = changedOf(prev.edges, doc.edges)
  const ids = new Set([...doc.nodes, ...doc.edges].map((x) => x.id))
  const gone = [...prev.nodes, ...prev.edges].map((x) => x.id).filter((id) => !ids.has(id))
  if (nodes.length) step.nodes = nodes
  if (edges.length) step.edges = edges
  if (gone.length) step.gone = gone
  const replayed = apply(prev, step)
  const sameOrder = <T extends { id: string }>(a: T[], b: T[]) => a.every((x, i) => x.id === b[i]?.id)
  if (!sameOrder(replayed.nodes, doc.nodes) || !sameOrder(replayed.edges, doc.edges))
    step.order = { nodes: doc.nodes.map((n) => n.id), edges: doc.edges.map((e) => e.id) }
  return step
}

function apply(prev: Doc, step: Omit<Step, 'id' | 'at' | 'label'>): Doc {
  const gone = new Set(step.gone ?? [])
  const merge = <T extends { id: string }>(before: T[], changed: T[] = []) => {
    const byId = new Map(changed.map((x) => [x.id, x]))
    const out = before.filter((x) => !gone.has(x.id)).map((x) => byId.get(x.id) ?? x)
    const have = new Set(out.map((x) => x.id))
    return [...out, ...changed.filter((x) => !have.has(x.id))]
  }
  let nodes = merge(prev.nodes, step.nodes)
  let edges = merge(prev.edges, step.edges)
  if (step.order) {
    const sort = <T extends { id: string }>(xs: T[], ids: string[]) => {
      const at = new Map(ids.map((id, i) => [id, i]))
      return [...xs].sort((a, b) => (at.get(a.id) ?? 1e9) - (at.get(b.id) ?? 1e9))
    }
    nodes = sort(nodes, step.order.nodes)
    edges = sort(edges, step.order.edges)
  }
  return { nodes, edges }
}

// The pictures written out in the board's own text, in order.
const boardPictures = (md: string): string[] => md.match(/data:[^)\s"]+/g) ?? []

/** The hidden block for the end of a .md (whose board text is `md`), or '' when there's nothing to keep. */
export function historyBlock(extra: BoardExtras, md = ''): string {
  const points = extra.tracks ?? []
  if (!points.length && !extra.view && !extra.settings) return ''
  const images = new Map<string, string>()
  const withRefs = (doc: Doc): Doc => ({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (!n.src?.startsWith('data:')) return n
      if (!images.has(n.src)) images.set(n.src, String(images.size + 1))
      return { ...n, src: `@img:${images.get(n.src)}` }
    }),
  })
  const steps: string[] = []
  let prev: Doc = { nodes: [], edges: [] }
  for (const p of points) {
    const doc = withRefs(alignIds(prev, p.doc))
    steps.push(line({ id: p.id, at: p.at, label: p.label, ...delta(prev, doc) }))
    prev = doc
  }
  return [
    '',
    START,
    NOTE,
    line({ view: extra.view, settings: extra.settings }),
    ...[...images].map(([src, img]) => {
      const board = boardPictures(md).indexOf(src)
      return line(board >= 0 ? { img, board } : { img, src })
    }),
    ...steps,
    END,
    '',
  ].join('\n')
}

/** Splits a .md into the board text and what its history block holds. */
export function readHistory(text: string): { md: string; extra: BoardExtras } {
  const start = text.lastIndexOf(START)
  if (start < 0) return { md: text, extra: {} }
  const end = text.indexOf(END, start)
  const md = text.slice(0, start) + (end < 0 ? '' : text.slice(end + END.length))
  const extra: BoardExtras = {}
  const images = new Map<string, string>()
  const tracks: TrackPoint[] = []
  let prev: Doc = { nodes: [], edges: [] }
  for (const raw of text.slice(start, end < 0 ? undefined : end).split('\n').slice(1)) {
    let v: Record<string, unknown>
    try {
      v = JSON.parse(raw)
    } catch {
      continue
    }
    if (!v || typeof v !== 'object') continue
    if (typeof v.img === 'string' && typeof v.src === 'string') images.set(v.img, v.src)
    else if (typeof v.img === 'string' && typeof v.board === 'number') images.set(v.img, boardPictures(md)[v.board] ?? '')
    else if (typeof v.id === 'string' && typeof v.at === 'number') {
      prev = apply(prev, v as unknown as Step)
      const doc = {
        nodes: prev.nodes.map((n) => (n.src?.startsWith('@img:') ? { ...n, src: images.get(n.src.slice(5)) } : n)),
        edges: prev.edges,
      }
      if (isDoc(doc)) tracks.push({ id: v.id, at: v.at, label: typeof v.label === 'string' ? v.label : 'Track point', doc: normalizeDoc(doc) })
    } else {
      if (v.view && typeof v.view === 'object') extra.view = v.view as BoardExtras['view']
      if (v.settings && typeof v.settings === 'object') extra.settings = v.settings as BoardExtras['settings']
    }
  }
  if (tracks.length) extra.tracks = tracks
  return { md, extra }
}
