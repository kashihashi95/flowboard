import { FONT, type ArrowHead, type Doc, type EdgeEl, type NodeEl, type Pt, type Rect, type Side } from './types'

export const SIDES: Side[] = ['top', 'right', 'bottom', 'left']

export const DIR: Record<Side, Pt> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

export const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
export const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k })
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
export const norm = (a: Pt): Pt => {
  const l = Math.hypot(a.x, a.y) || 1
  return { x: a.x / l, y: a.y / l }
}

export const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

export const rectFromPoints = (a: Pt, b: Pt): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(a.x - b.x),
  h: Math.abs(a.y - b.y),
})

export const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

export const contains = (r: Rect, p: Pt, margin = 0) =>
  p.x >= r.x - margin && p.x <= r.x + r.w + margin && p.y >= r.y - margin && p.y <= r.y + r.h + margin

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const r of rects) {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.w)
    y2 = Math.max(y2, r.y + r.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export const parallelogramSkew = (n: Rect) => Math.min(n.w * 0.25, n.h * 0.6)

/** Connection point in the middle of each side, on the shape's outline. */
export function anchor(n: NodeEl, side: Side, at?: number): Pt {
  if (at !== undefined) return outlineAt(n, side, at)
  const c = center(n)
  const inset = n.kind === 'parallelogram' ? parallelogramSkew(n) / 2 : 0
  switch (side) {
    case 'top':
      return { x: c.x, y: n.y }
    case 'bottom':
      return { x: c.x, y: n.y + n.h }
    case 'left':
      return { x: n.x + inset, y: c.y }
    case 'right':
      return { x: n.x + n.w - inset, y: c.y }
  }
}

export function autoSide(n: NodeEl, toward: Pt): Side {
  const c = center(n)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (Math.abs(dx) / Math.max(n.w, 1) > Math.abs(dy) / Math.max(n.h, 1)) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'bottom' : 'top'
}

/** Unit vector along the dominant axis of `v`. */
const dominant = (v: Pt): Pt =>
  Math.abs(v.x) >= Math.abs(v.y) ? { x: Math.sign(v.x) || 1, y: 0 } : { x: 0, y: Math.sign(v.y) || 1 }

export interface Endpoints {
  p1: Pt
  d1: Pt
  p2: Pt
  d2: Pt
  /** Inside a shape, from the phrase out to p1 / from p2 in to the phrase:
   *  the line runs between text lines when words block a straight approach. */
  lead1?: Pt[]
  lead2?: Pt[]
}

/** World-space box of a highlighted phrase inside a node; set by richtext,
 *  which owns text layout (kept as a hook to avoid an import cycle). */
export interface LinkRect extends Rect {
  /** No other text between the phrase and the text box's left / right edge on this line. */
  freeLeft: boolean
  freeRight: boolean
  /** No other words directly above / below the phrase. */
  freeTop?: boolean
  freeBottom?: boolean
  /** Where a connector may leave on each side: past any punctuation next to the phrase. */
  outLeft?: number
  outRight?: number
}

let linkRectOf: (n: NodeEl, linkId: string) => LinkRect[] = () => []
export const setLinkRectResolver = (f: typeof linkRectOf) => {
  linkRectOf = f
}

/** x of the shape's outline at height `y`, on the left or right. */
export function outlineX(n: NodeEl, y: number, side: 'left' | 'right'): number {
  const dy = Math.min(Math.abs(y - (n.y + n.h / 2)), n.h / 2)
  const t = Math.min(Math.max((y - n.y) / Math.max(n.h, 1), 0), 1)
  let inset = 0
  switch (n.kind) {
    case 'ellipse':
      inset = (n.w / 2) * (1 - Math.sqrt(Math.max(1 - (dy / (n.h / 2)) ** 2, 0)))
      break
    case 'diamond':
      inset = (n.w / 2) * (dy / (n.h / 2))
      break
    case 'hexagon':
      inset = Math.min(n.w * 0.2, n.h * 0.5) * (dy / (n.h / 2))
      break
    case 'rounded': {
      const r = Math.min(n.w, n.h) / 2
      const into = dy - (n.h / 2 - r)
      if (into > 0) inset = r - Math.sqrt(Math.max(r * r - into * into, 0))
      break
    }
    case 'parallelogram': {
      const sk = parallelogramSkew(n)
      inset = side === 'left' ? sk * (1 - t) : sk * t
      break
    }
  }
  return side === 'left' ? n.x + inset : n.x + n.w - inset
}

/** y of the shape's outline at `x`, on the top or bottom. */
export function outlineY(n: NodeEl, x: number, side: 'top' | 'bottom'): number {
  const dx = Math.min(Math.abs(x - (n.x + n.w / 2)), n.w / 2)
  let inset = 0
  switch (n.kind) {
    case 'ellipse':
      inset = (n.h / 2) * (1 - Math.sqrt(Math.max(1 - (dx / (n.w / 2)) ** 2, 0)))
      break
    case 'diamond':
      inset = (n.h / 2) * (dx / (n.w / 2))
      break
    case 'hexagon': {
      const k = Math.min(n.w * 0.2, n.h * 0.5)
      const into = dx - (n.w / 2 - k)
      if (into > 0) inset = (n.h / 2) * (into / k)
      break
    }
    case 'rounded': {
      const r = Math.min(n.w, n.h) / 2
      const into = dx - (n.w / 2 - r)
      if (into > 0) inset = r - Math.sqrt(Math.max(r * r - into * into, 0))
      break
    }
    case 'parallelogram': {
      const sk = parallelogramSkew(n)
      if (side === 'top' && x < n.x + sk) inset = (n.h * (n.x + sk - x)) / sk
      if (side === 'bottom' && x > n.x + n.w - sk) inset = (n.h * (x - (n.x + n.w - sk))) / sk
      break
    }
  }
  return side === 'top' ? n.y + inset : n.y + n.h - inset
}

/** The point on a side's outline `t` (0–1) of the way along it. */
export function outlineAt(n: NodeEl, side: Side, t: number): Pt {
  const u = Math.min(Math.max(t, 0), 1)
  if (side === 'left' || side === 'right') {
    const y = n.y + u * n.h
    return { x: outlineX(n, y, side), y }
  }
  const x = n.x + u * n.w
  return { x, y: outlineY(n, x, side) }
}

/** The outline point nearest `p`: its side and how far along it. */
export function nearestOnOutline(n: NodeEl, p: Pt): { side: Side; at: number; p: Pt; d: number } {
  let best = { side: 'top' as Side, at: 0.5, p: anchor(n, 'top'), d: Infinity }
  for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) {
    const horiz = side === 'top' || side === 'bottom'
    const at = Math.min(Math.max(horiz ? (p.x - n.x) / Math.max(n.w, 1) : (p.y - n.y) / Math.max(n.h, 1), 0), 1)
    const q = outlineAt(n, side, at)
    const d = dist(q, p)
    if (d < best.d) best = { side, at, p: q, d }
  }
  return best
}

/** Where a connector meets a phrase: the start of its first line or the end of
 *  its last, whichever faces the other end (or the pinned side). When other
 *  words sit between the phrase and the shape's edge, it comes from above or
 *  below, or else runs in along the gap between text lines. */
function textAnchor(n: NodeEl, rects: LinkRect[], side: Side | undefined, toward: Pt): { p: Pt; d: Pt; lead?: Pt[] } {
  const all = unionRects(rects)!
  const first = rects[0]
  const last = rects[rects.length - 1]
  const s = side === 'left' || side === 'right' ? side : toward.x >= all.x + all.w / 2 ? 'right' : 'left'
  const r = s === 'right' ? last : first
  const y = r.y + r.h / 2
  const free = s === 'right' ? r.freeRight : r.freeLeft
  // Words in the way sideways: meet the phrase from above or below instead, if that's clear.
  if (side === 'top' || side === 'bottom' || (!free && !side)) {
    const up = toward.y < all.y + all.h / 2
    const order: ('top' | 'bottom')[] = side === 'top' || side === 'bottom' ? [side] : up ? ['top', 'bottom'] : ['bottom', 'top']
    for (const v of order) {
      const q = v === 'top' ? first : last
      if (side || (v === 'top' ? q.freeTop : q.freeBottom)) return { p: { x: q.x + q.w / 2, y: v === 'top' ? q.y + 1 : q.y + q.h - 1 }, d: DIR[v] }
    }
  }
  if (free) return { p: { x: s === 'right' ? (r.outRight ?? r.x + r.w) + 3 : (r.outLeft ?? r.x) - 3, y }, d: DIR[s] }
  // Boxed in by words: leave the outline in the gap between text lines and run
  // along it to the phrase's corner, so the line still visibly reaches it.
  const gy = toward.y < y ? r.y : r.y + r.h
  const tip = { x: s === 'right' ? r.x + r.w : r.x, y: gy }
  return { p: { x: outlineX(n, gy, s), y: gy }, d: DIR[s], lead: [tip] }
}

export function resolveEnds(e: EdgeEl, nodes: Map<string, NodeEl>): Endpoints {
  const A = e.from.nodeId ? nodes.get(e.from.nodeId) : undefined
  const B = e.to.nodeId ? nodes.get(e.to.nodeId) : undefined
  const ra = A && e.from.textId ? linkRectOf(A, e.from.textId) : []
  const rb = B && e.to.textId ? linkRectOf(B, e.to.textId) : []
  const ca = ra.length ? center(unionRects(ra)!) : A ? center(A) : { x: e.from.x, y: e.from.y }
  const cb = rb.length ? center(unionRects(rb)!) : B ? center(B) : { x: e.to.x, y: e.to.y }
  let p1 = ca, p2 = cb
  let d1: Pt | null = null, d2: Pt | null = null
  let lead1: Pt[] | undefined, lead2: Pt[] | undefined
  if (ra.length) {
    const t = textAnchor(A!, ra, e.from.side, cb)
    p1 = t.p
    d1 = t.d
    lead1 = t.lead
  } else if (A) {
    const s = e.from.side ?? autoSide(A, cb)
    p1 = anchor(A, s, e.from.side ? e.from.at : undefined)
    d1 = DIR[s]
  }
  if (rb.length) {
    const t = textAnchor(B!, rb, e.to.side, ca)
    p2 = t.p
    d2 = t.d
    lead2 = t.lead && [...t.lead].reverse()
  } else if (B) {
    const s = e.to.side ?? autoSide(B, ca)
    p2 = anchor(B, s, e.to.side ? e.to.at : undefined)
    d2 = DIR[s]
  }
  return { p1, d1: d1 ?? dominant(sub(p2, p1)), p2, d2: d2 ?? dominant(sub(p1, p2)), lead1, lead2 }
}

function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    if (out.length && dist(out[out.length - 1], p) < 0.5) continue
    out.push(p)
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1], b = out[i], c = out[i + 1]
    const collinear = (Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) || (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5)
    if (collinear) out.splice(i, 1)
  }
  return out
}

const PAD = 24

/** For a route that leaves and arrives facing each other, the axis it crosses
 *  over on and where (the middle by default); undefined for other routes. */
function crossing({ p1, d1, p2, d2 }: Endpoints): { axis: 'x' | 'y'; mid: number } | undefined {
  if (d1.x !== 0 && d1.x === -d2.x && (p2.x - p1.x) * d1.x > 0) return { axis: 'x', mid: (p1.x + p2.x) / 2 }
  if (d1.y !== 0 && d1.y === -d2.y && (p2.y - p1.y) * d1.y > 0) return { axis: 'y', mid: (p1.y + p2.y) / 2 }
}

// Shared cross-over positions, so connectors leaving (or entering) the same
// point run together as one trunk. Worked out for the whole board by bundleTrunks.
let trunks = new Map<string, number>()
export const setTrunks = (m: Map<string, number>) => {
  trunks = m
}

/** Connectors that leave the same point the same way cross over at the same
 *  place (the one nearest that point), so their shared stretch overlaps; same
 *  for connectors arriving at one point. Hand-routed connectors keep their route. */
export function bundleTrunks(edges: EdgeEl[], nodes: Map<string, NodeEl>): Map<string, number> {
  const info = edges
    .filter((e) => e.route === 'elbow' && !e.points?.length)
    .map((e) => ({ e, ends: resolveEnds(e, nodes) }))
    .map(({ e, ends }) => ({ e, ends, c: crossing(ends) }))
    .filter((x): x is { e: EdgeEl; ends: Endpoints; c: { axis: 'x' | 'y'; mid: number } } => !!x.c)
  const out = new Map<string, number>()
  const pass = (end: 'p1' | 'p2', nodeOf: (e: EdgeEl) => string | undefined) => {
    const groups = new Map<string, typeof info>()
    for (const x of info) {
      if (out.has(x.e.id) || !nodeOf(x.e)) continue
      const p = x.ends[end]
      const key = `${nodeOf(x.e)}|${x.c.axis}|${Math.round(p.x)},${Math.round(p.y)}`
      groups.set(key, [...(groups.get(key) ?? []), x])
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue
      const a = g[0].c.axis
      const from = g[0].ends[end][a]
      // The cross-over nearest the shared point suits every line that reaches past it.
      const shared = g.map((x) => x.c.mid).reduce((m, v) => (Math.abs(v - from) < Math.abs(m - from) ? v : m))
      for (const x of g) {
        const far = (end === 'p1' ? x.ends.p2 : x.ends.p1)[a]
        if ((shared - from) * (far - shared) > 0 && Math.abs(far - shared) >= 12) out.set(x.e.id, shared)
      }
    }
  }
  pass('p1', (e) => e.from.nodeId)
  pass('p2', (e) => e.to.nodeId)
  return out
}

function elbowPoints({ p1, d1, p2, d2 }: Endpoints, trunk?: number): Pt[] {
  const s = add(p1, mul(d1, PAD))
  const t = add(p2, mul(d2, PAD))
  const h1 = d1.x !== 0
  const h2 = d2.x !== 0
  if (h1 && h2) {
    if (d1.x === -d2.x && (p2.x - p1.x) * d1.x > 0) {
      const mx = trunk ?? (p1.x + p2.x) / 2
      return [p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2]
    }
    if (d1.x === d2.x) {
      const X = d1.x > 0 ? Math.max(s.x, t.x) : Math.min(s.x, t.x)
      return [p1, { x: X, y: p1.y }, { x: X, y: p2.y }, p2]
    }
    const my = (p1.y + p2.y) / 2
    return [p1, s, { x: s.x, y: my }, { x: t.x, y: my }, t, p2]
  }
  if (!h1 && !h2) {
    if (d1.y === -d2.y && (p2.y - p1.y) * d1.y > 0) {
      const my = trunk ?? (p1.y + p2.y) / 2
      return [p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2]
    }
    if (d1.y === d2.y) {
      const Y = d1.y > 0 ? Math.max(s.y, t.y) : Math.min(s.y, t.y)
      return [p1, { x: p1.x, y: Y }, { x: p2.x, y: Y }, p2]
    }
    const mx = (p1.x + p2.x) / 2
    return [p1, s, { x: mx, y: s.y }, { x: mx, y: t.y }, t, p2]
  }
  if (h1) {
    const c = { x: p2.x, y: p1.y }
    if ((c.x - p1.x) * d1.x > 0 && (c.y - p2.y) * d2.y > 0) return [p1, c, p2]
    return [p1, s, { x: s.x, y: t.y }, t, p2]
  }
  const c = { x: p1.x, y: p2.y }
  if ((c.y - p1.y) * d1.y > 0 && (c.x - p2.x) * d2.x > 0) return [p1, c, p2]
  return [p1, s, { x: t.x, y: s.y }, t, p2]
}

/** Make every segment horizontal or vertical by adding a corner where needed. */
function orthogonalize(pts: Pt[]): Pt[] {
  const out: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1]
    const b = pts[i]
    if (Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) out.push({ x: b.x, y: a.y })
    out.push(b)
  }
  return out
}

/** An elbow route the user adjusted: the stored corners, with the first and
 *  last nudged so the line still leaves and enters its shapes straight. */
function manualPoints({ p1, d1, p2, d2 }: Endpoints, corners: Pt[]): Pt[] {
  const inner = corners.map((p) => ({ ...p }))
  const first = inner[0]
  const last = inner[inner.length - 1]
  if (d1.x !== 0) first.y = p1.y
  else first.x = p1.x
  if (inner.length > 1 || d1.x === d2.x) {
    if (d2.x !== 0) last.y = p2.y
    else last.x = p2.x
  }
  return orthogonalize([p1, ...inner, p2])
}

/** The corner points a route passes through, ends included. */
export function routePoints(e: EdgeEl, nodes: Map<string, NodeEl>): Pt[] {
  const ends = resolveEnds(e, nodes)
  if (e.route === 'straight') return [ends.p1, ends.p2]
  return simplify(e.points?.length ? manualPoints(ends, e.points) : elbowPoints(ends, trunks.get(e.id)))
}

/** Slide segment `i` of an elbow route by `delta` (across its direction),
 *  returning the new corner points. A segment that touches an end first gets
 *  a short stub, so the end stays where it is and a new bend appears. */
export function moveSegment(pts: Pt[], i: number, delta: Pt, d1: Pt, d2: Pt): Pt[] {
  const horizontal = Math.abs(pts[i].y - pts[i + 1].y) < 0.5
  let p = pts.map((q) => ({ ...q }))
  let k = i
  if (k === 0) {
    const s = add(p[0], mul(d1, PAD))
    p = [p[0], s, { ...s }, ...p.slice(1)]
    k += 2
  }
  if (k + 1 === p.length - 1) {
    const end = p[p.length - 1]
    const t = add(end, mul(d2, PAD))
    p = [...p.slice(0, -1), t, { ...t }, end]
  }
  if (horizontal) {
    p[k].y += delta.y
    p[k + 1].y += delta.y
  } else {
    p[k].x += delta.x
    p[k + 1].x += delta.x
  }
  return p.slice(1, -1)
}

function roundedPath(pts: Pt[], r: number): string {
  let d = `M${pts[0].x},${pts[0].y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1], cur = pts[i], next = pts[i + 1]
    const rr = Math.min(r, dist(prev, cur) / 2, dist(cur, next) / 2)
    const a = sub(cur, mul(norm(sub(cur, prev)), rr))
    const b = add(cur, mul(norm(sub(next, cur)), rr))
    d += ` L${a.x},${a.y} Q${cur.x},${cur.y} ${b.x},${b.y}`
  }
  const last = pts[pts.length - 1]
  return d + ` L${last.x},${last.y}`
}

/** The point a fraction `t` of the way along a polyline, by length. */
export function polylineAt(pts: Pt[], t = 0.5): Pt {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i])
  let half = total * Math.min(Math.max(t, 0), 1)
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i])
    if (half <= seg) return add(pts[i - 1], mul(norm(sub(pts[i], pts[i - 1])), half))
    half -= seg
  }
  return pts[0]
}

export const arrowSize = (width: number) => 9 + width * 2

/** How far the line stops short of the tip so it doesn't poke through the head. */
export function headInset(head: ArrowHead, width: number): number {
  const L = arrowSize(width)
  switch (head) {
    case 'triangle':
      return L * 0.75
    case 'triangle-open':
      return L
    case 'circle':
    case 'circle-open':
      return L * 0.76
    case 'diamond':
      return L * 1.3
    default:
      return 0
  }
}

export interface EdgeGeom {
  d: string
  mid: Pt
  /** Arrow tips and the direction each arrow points. */
  start: Pt
  startDir: Pt
  end: Pt
  endDir: Pt
  bounds: Rect
}

/** `trunk`: the shared cross-over to use; null for none, left out to use the board's (see bundleTrunks). */
export function edgeGeometry(e: EdgeEl, nodes: Map<string, NodeEl>, trunk?: number | null): EdgeGeom {
  const ends = resolveEnds(e, nodes)
  const Ls = headInset(e.startHead, e.width)
  const Le = headInset(e.endHead, e.width)
  const { p1, d1, p2, d2, lead1 = [], lead2 = [] } = ends
  if (e.route === 'curved') {
    const k = Math.min(Math.max(dist(p1, p2) * 0.4, 30), 160)
    const c1 = add(p1, mul(d1, k))
    const c2 = add(p2, mul(d2, k))
    const a = lead1[0] ?? p1
    const b = lead2[lead2.length - 1] ?? p2
    const startDir = lead1.length ? norm(sub(a, p1)) : norm(sub(p1, c1))
    const endDir = lead2.length ? norm(sub(b, p2)) : norm(sub(p2, c2))
    const s = Ls ? sub(a, mul(startDir, Ls)) : a
    const t = Le ? sub(b, mul(endDir, Le)) : b
    const mid = {
      x: 0.125 * p1.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p2.x,
      y: 0.125 * p1.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p2.y,
    }
    const into = (pts: Pt[]) => pts.map((q) => ` L${q.x},${q.y}`).join('')
    return {
      d: `M${s.x},${s.y}${into([...lead1.slice(1), ...(lead1.length ? [p1] : [])])} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}${into([...lead2.slice(0, -1), t])}`,
      mid,
      start: a,
      startDir,
      end: b,
      endDir,
      bounds: unionRects([a, b, p1, p2, c1, c2].map((p) => ({ ...p, w: 0, h: 0 })))!,
    }
  }
  const route = e.route === 'straight' ? [p1, p2] : e.points?.length ? manualPoints(ends, e.points) : elbowPoints(ends, trunk === undefined ? trunks.get(e.id) : (trunk ?? undefined))
  const pts = simplify([...lead1, ...route, ...lead2])
  if (pts.length < 2) pts.push({ ...pts[0] })
  const n = pts.length
  const startDir = norm(sub(pts[0], pts[1]))
  const endDir = norm(sub(pts[n - 1], pts[n - 2]))
  const drawn = pts.map((p) => ({ ...p }))
  if (Ls && dist(pts[0], pts[1]) > Ls) drawn[0] = sub(pts[0], mul(startDir, Ls))
  if (Le && dist(pts[n - 1], pts[n - 2]) > Le) drawn[n - 1] = sub(pts[n - 1], mul(endDir, Le))
  return {
    d: e.route === 'straight' && n === 2 ? `M${drawn[0].x},${drawn[0].y} L${drawn[1].x},${drawn[1].y}` : roundedPath(drawn, e.route === 'straight' ? 0 : 10),
    mid: polylineAt(pts, e.labelAt),
    start: pts[0],
    startDir,
    end: pts[n - 1],
    endDir,
    bounds: unionRects(pts.map((p) => ({ ...p, w: 0, h: 0 })))!,
  }
}

/** The line a connector draws, as points (curves are sampled). */
export function edgePolyline(e: EdgeEl, nodes: Map<string, NodeEl>): Pt[] {
  const { p1, d1, p2, d2, lead1 = [], lead2 = [] } = resolveEnds(e, nodes)
  if (e.route !== 'curved') return [...lead1, ...routePoints(e, nodes), ...lead2]
  const k = Math.min(Math.max(dist(p1, p2) * 0.4, 30), 160)
  const c1 = add(p1, mul(d1, k))
  const c2 = add(p2, mul(d2, k))
  const out: Pt[] = []
  for (let i = 0; i <= 16; i++) {
    const t = i / 16
    const u = 1 - t
    out.push({
      x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
      y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
    })
  }
  return [...lead1, ...out, ...lead2]
}

/** Outline of an arrowhead whose tip sits at `tip`, pointing along `dir`.
 *  `filled` says whether to fill it or only stroke it. */
export function headShape(head: ArrowHead, tip: Pt, dir: Pt, width: number): { d: string; filled: boolean } | null {
  const L = arrowSize(width)
  const perp = { x: -dir.y, y: dir.x }
  const at = (back: number, side: number) => add(sub(tip, mul(dir, back)), mul(perp, side))
  const P = (p: Pt) => `${p.x},${p.y}`
  switch (head) {
    case 'triangle':
    case 'triangle-open': {
      const a = at(L, L * 0.5)
      const b = at(L, -L * 0.5)
      return { d: `M${P(tip)} L${P(a)} L${P(b)} Z`, filled: head === 'triangle' }
    }
    case 'arrow': {
      const a = at(L * 0.9, L * 0.5)
      const b = at(L * 0.9, -L * 0.5)
      return { d: `M${P(a)} L${P(tip)} L${P(b)}`, filled: false }
    }
    case 'circle':
    case 'circle-open': {
      const r = L * 0.38
      const c = at(r, 0)
      return { d: `M${c.x - r},${c.y} a${r},${r} 0 1 0 ${2 * r},0 a${r},${r} 0 1 0 ${-2 * r},0`, filled: head === 'circle' }
    }
    case 'diamond': {
      const D = L * 1.3
      return { d: `M${P(tip)} L${P(at(D / 2, D * 0.32))} L${P(at(D, 0))} L${P(at(D / 2, -D * 0.32))} Z`, filled: true }
    }
    case 'bar': {
      return { d: `M${P(at(0, L * 0.5))} L${P(at(0, -L * 0.5))}`, filled: false }
    }
    default:
      return null
  }
}

// ---------- text ----------

let measureCtx: CanvasRenderingContext2D | null = null
export function measure(text: string, fontSize: number, weight = 400, italic = false): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * fontSize * 0.55
  measureCtx.font = `${italic ? 'italic ' : ''}${weight} ${fontSize}px ${FONT}`
  return measureCtx.measureText(text).width
}

export function wrapText(text: string, maxW: number, fontSize: number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word
      if (measure(test, fontSize) <= maxW || !line) {
        line = test
      } else {
        lines.push(line)
        line = word
      }
      // A single word wider than the box gets broken by character.
      while (measure(line, fontSize) > maxW && line.length > 1) {
        let i = line.length - 1
        while (i > 1 && measure(line.slice(0, i), fontSize) > maxW) i--
        lines.push(line.slice(0, i))
        line = line.slice(i)
      }
    }
    lines.push(line)
  }
  return lines
}

export const lineHeight = (fontSize: number) => Math.round(fontSize * 1.35)

/** The box text wraps inside, relative to the node, per shape. */
export function textBox(n: NodeEl): Rect {
  switch (n.kind) {
    case 'diamond':
      return { x: n.w * 0.2, y: n.h * 0.2, w: n.w * 0.6, h: n.h * 0.6 }
    case 'ellipse':
      return { x: n.w * 0.15, y: n.h * 0.15, w: n.w * 0.7, h: n.h * 0.7 }
    case 'hexagon':
      return { x: n.w * 0.15, y: 8, w: n.w * 0.7, h: n.h - 16 }
    case 'parallelogram': {
      const sk = parallelogramSkew(n)
      return { x: sk / 2 + 10, y: 8, w: n.w - sk - 20, h: n.h - 16 }
    }
    case 'cylinder': {
      const ry = Math.min(n.h * 0.15, 16)
      return { x: 12, y: ry * 2, w: n.w - 24, h: n.h - ry * 3 }
    }
    case 'sticky':
      return { x: 16, y: 16, w: n.w - 32, h: n.h - 32 }
    case 'text':
      return { x: 4, y: 4, w: n.w - 8, h: n.h - 8 }
    default:
      return { x: 12, y: 8, w: n.w - 24, h: n.h - 16 }
  }
}

export function docBounds(doc: Doc): Rect | null {
  const map = new Map(doc.nodes.map((n) => [n.id, n]))
  const rects: Rect[] = doc.nodes.map((n) => n)
  for (const n of doc.nodes) if (n.kind === 'section') rects.push(sectionTitleRect(n))
  for (const e of doc.edges) rects.push(edgeGeometry(e, map).bounds)
  return unionRects(rects)
}

// ---------- sections ----------

export const SECTION_TITLE_SIZE = 15

/** The name tab drawn above a section's top-left corner. */
export function sectionTitleRect(n: NodeEl): Rect {
  const w = Math.max(measure(n.text || 'Section', SECTION_TITLE_SIZE, 600) + 20, 60)
  return { x: n.x, y: n.y - 32, w: Math.min(w, Math.max(n.w, 60)), h: 28 }
}

export const insideRect = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
