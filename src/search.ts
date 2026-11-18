import { edgeGeometry, lineHeight, measure, sectionTitleRect } from './geometry'
import { containingSections } from './layout'
import { measureRun, nodeLines, paragraphsOf, paragraphsToPlain, textOrigin } from './richtext'
import type { Doc, NodeEl, Rect } from './types'

// Find on the board. The browser's own find sees the drawn text, where every
// wrapped line runs into the next with no space ("idle villagers" reads
// "idlevillagers") and the page can't scroll to a match on the canvas. This
// searches the board's own text instead and maps matches back to where the
// words are drawn.

const LABEL_FONT = 14

export type HitKind = 'shape' | 'section' | 'label'

/** One searchable piece of text: a shape's words, a section title or a connector label. */
interface Entry {
  kind: HitKind
  id: string
  /** The text as written, paragraphs joined by newlines. */
  text: string
  /** Lower-cased, accents and formatting dropped, runs of spaces made one. */
  norm: string
  /** For each character of norm, where it starts in text. */
  back: number[]
  section?: string
  /** Reading order on the board. */
  y: number
  x: number
}

export interface Hit {
  kind: HitKind
  id: string
  /** The section it sits in, if any. */
  section?: string
  /** 0 whole word, 1 start of a word, 2 inside a word, 3 all the words but not together. */
  rank: number
  /** Where the matches are in the text as written: [start, end) pairs. */
  ranges: [number, number][]
  text: string
}

export interface Group {
  /** The section's id, or undefined for shapes in no section. */
  section?: string
  title: string
  hits: Hit[]
}

// Curly quotes and dashes match their plain forms.
const FOLD: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', ' ': ' ' }

/** Normalize text for matching, remembering where each character came from. */
export function normalize(text: string): { norm: string; back: number[] } {
  let norm = ''
  const back: number[] = []
  let space = true
  for (let i = 0; i < text.length; i++) {
    const ch = FOLD[text[i]] ?? text[i]
    if (/\s/.test(ch)) {
      if (!space) {
        norm += ' '
        back.push(i)
      }
      space = true
      continue
    }
    space = false
    for (const c of ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()) {
      norm += c
      back.push(i)
    }
  }
  if (norm.endsWith(' ')) {
    norm = norm.slice(0, -1)
    back.pop()
  }
  return { norm, back }
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c)

/** Everything on the board that has words, in reading order. */
export function buildIndex(doc: Doc): Entry[] {
  const inSection = containingSections(doc.nodes)
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]))
  const out: Entry[] = []
  const add = (kind: HitKind, id: string, text: string, at: { x: number; y: number }, section?: string) => {
    if (!text.trim()) return
    out.push({ kind, id, text, ...normalize(text), section, x: at.x, y: at.y })
  }
  for (const n of doc.nodes) {
    if (n.kind === 'image') continue
    if (n.kind === 'section') add('section', n.id, n.text, n, inSection.get(n.id))
    else {
      // Lay the words out now, so highlighting matches costs nothing per keypress.
      add('shape', n.id, layoutOf(n).plain, n, inSection.get(n.id))
    }
  }
  for (const e of doc.edges) {
    if (!e.label?.trim()) continue
    const a = e.from.nodeId ? nodes.get(e.from.nodeId) : undefined
    const b = e.to.nodeId ? nodes.get(e.to.nodeId) : undefined
    const s = a && b && inSection.get(a.id) === inSection.get(b.id) ? inSection.get(a.id) : undefined
    let mid = { x: 0, y: 0 }
    try {
      mid = edgeGeometry(e, nodes).mid
    } catch {
      /* a broken end still gets found */
    }
    add('label', e.id, e.label, mid, s)
  }
  return out
}

/** Every match of the query in the index, best first within reading order. */
export function search(index: Entry[], query: string): Hit[] {
  const q = normalize(query).norm
  if (!q) return []
  const words = q.split(' ').filter(Boolean)
  const hits: Hit[] = []
  for (const en of index) {
    const ranges: [number, number][] = []
    let rank = 9
    for (let at = en.norm.indexOf(q); at >= 0; at = en.norm.indexOf(q, at + 1)) {
      const startsWord = !isWordChar(en.norm[at - 1]) || !isWordChar(q[0])
      const endsWord = !isWordChar(en.norm[at + q.length]) || !isWordChar(q[q.length - 1])
      rank = Math.min(rank, startsWord && endsWord ? 0 : startsWord ? 1 : 2)
      ranges.push(toSource(en, at, at + q.length))
    }
    // Several words that are all there, but not side by side.
    if (!ranges.length && words.length > 1 && words.every((w) => en.norm.includes(w))) {
      rank = 3
      for (const w of words) for (let at = en.norm.indexOf(w); at >= 0; at = en.norm.indexOf(w, at + 1)) ranges.push(toSource(en, at, at + w.length))
      ranges.sort((a, b) => a[0] - b[0])
    }
    if (ranges.length) hits.push({ kind: en.kind, id: en.id, section: en.section, rank, ranges, text: en.text })
  }
  return hits
}

function toSource(en: Entry, a: number, b: number): [number, number] {
  return [en.back[a], en.back[b - 1] + 1]
}

/** Hits grouped by the section they're in. Groups, and the hits in each, go
 *  best match first, then top to bottom, left to right. */
export function groupHits(index: Entry[], hits: Hit[], doc: Doc): Group[] {
  const pos = new Map(index.map((e) => [e.id, e]))
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]))
  const order = (a: { x: number; y: number }, b: { x: number; y: number }) => a.y - b.y || a.x - b.x
  const groups = new Map<string, Group>()
  for (const h of hits) {
    const key = h.section ?? ''
    if (!groups.has(key)) groups.set(key, { section: h.section, title: h.section ? nodes.get(h.section)?.text.trim() || 'Section' : 'Not in a section', hits: [] })
    groups.get(key)!.hits.push(h)
  }
  const best = (g: Group) => Math.min(...g.hits.map((h) => h.rank))
  const where = (g: Group) => (g.section && nodes.get(g.section)) || { x: Infinity, y: Infinity }
  for (const g of groups.values()) g.hits.sort((a, b) => a.rank - b.rank || order(pos.get(a.id)!, pos.get(b.id)!))
  return [...groups.values()].sort((a, b) => best(a) - best(b) || order(where(a), where(b)))
}

/** A short piece of the text around the first match, split into plain and matched parts. */
export function snippet(h: Hit, around = 36): { text: string; hit: boolean }[] {
  const t = h.text.replace(/\s+/g, ' ')
  // Positions shift when whitespace collapses: map them onto the flattened text.
  const flat: number[] = []
  for (let i = 0, j = 0; i <= h.text.length; i++) {
    flat.push(j)
    if (!(/\s/.test(h.text[i]) && /\s/.test(h.text[i + 1] ?? ''))) j++
  }
  // Only the matches that can show in the snippet.
  const near = h.ranges.filter(([a]) => a < h.ranges[0][0] + around * 4)
  const ranges = near.map(([a, b]) => [flat[a], flat[b]] as [number, number])
  const [a0] = ranges[0]
  let from = Math.max(0, a0 - around)
  if (from > 0) {
    const sp = t.indexOf(' ', from)
    if (sp >= 0 && sp < a0) from = sp + 1
  }
  let to = Math.min(t.length, Math.max(ranges[0][1], from + around * 2.4))
  if (to < t.length) {
    const sp = t.lastIndexOf(' ', to)
    if (sp > ranges[0][1]) to = sp
  }
  const parts: { text: string; hit: boolean }[] = []
  if (from > 0) parts.push({ text: '…', hit: false })
  let at = from
  for (const [a, b] of ranges) {
    if (b <= from || a >= to) continue
    if (a > at) parts.push({ text: t.slice(at, a), hit: false })
    parts.push({ text: t.slice(Math.max(a, at), Math.min(b, to)), hit: true })
    at = Math.min(b, to)
  }
  if (at < to) parts.push({ text: t.slice(at, to), hit: false })
  if (to < t.length) parts.push({ text: '…', hit: false })
  return parts
}

const nodeMaps = new WeakMap<Doc, Map<string, NodeEl>>()
const nodeMapOf = (doc: Doc) => {
  let m = nodeMaps.get(doc)
  if (!m) nodeMaps.set(doc, (m = new Map(doc.nodes.map((n) => [n.id, n]))))
  return m
}

/** Where a hit's matched words are drawn on the board. */
export function hitRects(h: Hit, doc: Doc): Rect[] {
  const nodes = nodeMapOf(doc)
  if (h.kind === 'section') {
    const n = nodes.get(h.id)
    return n ? [sectionTitleRect(n)] : []
  }
  if (h.kind === 'label') {
    const e = doc.edges.find((x) => x.id === h.id)
    if (!e?.label) return []
    const mid = edgeGeometry(e, nodes).mid
    const lines = e.label.split('\n')
    const lh = lineHeight(LABEL_FONT)
    const out: Rect[] = []
    let start = 0
    lines.forEach((line, i) => {
      const y = mid.y - ((lines.length - 1) * lh) / 2 + i * lh - lh / 2
      const x0 = mid.x - measure(line, LABEL_FONT) / 2
      for (const [a, b] of h.ranges) {
        const s = Math.max(a, start) - start
        const t = Math.min(b, start + line.length) - start
        if (t > s) out.push({ x: x0 + measure(line.slice(0, s), LABEL_FONT), y, w: measure(line.slice(s, t), LABEL_FONT), h: lh })
      }
      start += line.length + 1
    })
    return out
  }
  const n = nodes.get(h.id)
  return n ? nodeTextRects(n, h.ranges) : []
}

/** Rectangles around characters [a, b) of a shape's text, as laid out in the shape. */
// Laying out a shape's words is the slow part; shapes don't change between keypresses.
const layouts = new WeakMap<NodeEl, { plain: string; lines: ReturnType<typeof nodeLines>; left: number; top: number; lh: number }>()
function layoutOf(n: NodeEl) {
  let l = layouts.get(n)
  if (!l) {
    const lines = nodeLines(n)
    l = { plain: paragraphsToPlain(paragraphsOf(n)), lines, ...textOrigin(n, lines.length), lh: lineHeight(n.fontSize) }
    layouts.set(n, l)
  }
  return l
}

// The same slices get measured again as a search grows a letter at a time.
const widths = new Map<string, number>()
function width(text: string, run: Parameters<typeof measureRun>[1], size: number) {
  const key = `${size}|${run.bold ? 1 : 0}${run.italic ? 1 : 0}|${text}`
  let w = widths.get(key)
  if (w === undefined) {
    if (widths.size > 50000) widths.clear()
    widths.set(key, (w = measureRun(text, run, size)))
  }
  return w
}

export function nodeTextRects(n: NodeEl, ranges: [number, number][]): Rect[] {
  const { plain, lines, left, top, lh } = layoutOf(n)
  const out: Rect[] = []
  // Walk the drawn pieces through the text; a wrap drops the space it broke at.
  let cursor = 0
  lines.forEach((line, i) => {
    const y = top + i * lh - lh / 2
    let row: Rect | undefined
    for (const seg of line.segs) {
      if (!seg.text) continue
      const at = plain.indexOf(seg.text, cursor)
      if (at < 0) continue
      cursor = at + seg.text.length
      for (const [a, b] of ranges) {
        const s = Math.max(a, at) - at
        const t = Math.min(b, cursor) - at
        if (t <= s) continue
        const x = left + seg.x + width(seg.text.slice(0, s), seg.run, n.fontSize)
        const w = width(seg.text.slice(s, t), seg.run, n.fontSize)
        // Pieces of one match on one line (split by bold and so on) join up.
        if (row && Math.abs(row.x + row.w - x) < 0.5) row.w = x + w - row.x
        else out.push((row = { x, y, w, h: lh }))
      }
    }
  })
  return out
}

/** The rectangle the view should show for a hit, and the size its words are drawn at. */
export function hitFocus(h: Hit, doc: Doc): { box: Rect; words: Rect[]; font: number } | undefined {
  const words = hitRects(h, doc)
  if (h.kind === 'label') {
    const e = doc.edges.find((x) => x.id === h.id)
    if (!e) return undefined
    const mid = edgeGeometry(e, nodeMapOf(doc)).mid
    const box = words.length ? unite(words) : { x: mid.x - 20, y: mid.y - 10, w: 40, h: 20 }
    return { box: pad(box, 60), words, font: LABEL_FONT }
  }
  const n = doc.nodes.find((x) => x.id === h.id)
  if (!n) return undefined
  if (n.kind === 'section') return { box: sectionTitleRect(n), words, font: 15 }
  return { box: n, words, font: n.fontSize }
}

const unite = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x))
  const y = Math.min(...rs.map((r) => r.y))
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y }
}
const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p })
export { unite as uniteRects }
