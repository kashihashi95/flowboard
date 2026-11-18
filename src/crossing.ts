import { edgePolyline, parallelogramSkew } from './geometry'
import { outlineOf, strokeOf } from './render'
import type { Doc, NodeEl, Pt } from './types'

/** Connectors that cross a connector, or a shape's outline, of the same color
 *  get a color of their own, so each line can be followed through the crossing. Connectors that
 *  share a shape (a fan out of one box, or into one) may cross freely. */

// Hues spaced by the golden angle, so neighbours in the list look far apart.
const HUES = Array.from({ length: 24 }, (_, i) => `hsl(${Math.round((i * 137.508 + 205) % 360)} 72% 52%)`)

type Seg = [Pt, Pt]

function segments(pts: Pt[]): Seg[] {
  const out: Seg[] = []
  for (let i = 0; i + 1 < pts.length; i++) if (pts[i].x !== pts[i + 1].x || pts[i].y !== pts[i + 1].y) out.push([pts[i], pts[i + 1]])
  return out
}

const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

/** Whether two segments cross or run along each other (touching ends don't count). */
function meets([a, b]: Seg, [c, d]: Seg): boolean {
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  const eps = 1e-6
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true
  // Collinear and overlapping by more than a couple of pixels.
  if (Math.abs(d1) < eps && Math.abs(d2) < eps) {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (!len) return false
    const ux = (b.x - a.x) / len
    const uy = (b.y - a.y) / len
    const t1 = (c.x - a.x) * ux + (c.y - a.y) * uy
    const t2 = (d.x - a.x) * ux + (d.y - a.y) * uy
    return Math.min(len, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)) > 2
  }
  return false
}

function bbox(pts: Pt[]) {
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
}

/** A shape's outline as a closed loop of points. */
function outlinePoints(n: NodeEl): Pt[] {
  const { x, y, w, h } = n
  switch (n.kind) {
    case 'diamond':
      return [{ x: x + w / 2, y }, { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, { x, y: y + h / 2 }]
    case 'ellipse':
      return Array.from({ length: 24 }, (_, i) => {
        const a = (i / 24) * Math.PI * 2
        return { x: x + w / 2 + (Math.cos(a) * w) / 2, y: y + h / 2 + (Math.sin(a) * h) / 2 }
      })
    case 'hexagon': {
      const k = Math.min(w * 0.2, h * 0.5)
      return [{ x: x + k, y }, { x: x + w - k, y }, { x: x + w, y: y + h / 2 }, { x: x + w - k, y: y + h }, { x: x + k, y: y + h }, { x, y: y + h / 2 }]
    }
    case 'parallelogram': {
      const sk = parallelogramSkew(n)
      return [{ x: x + sk, y }, { x: x + w, y }, { x: x + w - sk, y: y + h }, { x, y: y + h }]
    }
    default:
      return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
  }
}

/** Display colors for connectors that need a different one; the rest keep theirs. */
export function crossingColors(doc: Doc, nodes: Map<string, NodeEl>): Map<string, string> {
  const edges = doc.edges.map((e) => {
    const pts = edgePolyline(e, nodes)
    return { e, segs: segments(pts), box: bbox(pts), base: strokeOf(e.color) }
  })
  const neighbours = edges.map(() => [] as number[])
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const A = edges[i]
      const B = edges[j]
      const shared = [A.e.from.nodeId, A.e.to.nodeId].some((id) => id && (id === B.e.from.nodeId || id === B.e.to.nodeId))
      if (shared) continue
      if (A.box.x2 < B.box.x1 || B.box.x2 < A.box.x1 || A.box.y2 < B.box.y1 || B.box.y2 < A.box.y1) continue
      if (A.segs.some((s) => B.segs.some((t) => meets(s, t)))) {
        neighbours[i].push(j)
        neighbours[j].push(i)
      }
    }
  }
  // Shape outlines a connector cuts through (its own shape counts only when
  // the connector leaves from highlighted words inside it).
  const outlines = doc.nodes.flatMap((n) => {
    const color = outlineOf(n)
    if (!color) return []
    const pts = outlinePoints(n)
    return [{ n, color, segs: segments([...pts, pts[0]]), box: bbox(pts) }]
  })
  const outlineColors = edges.map(({ e, segs, box }) => {
    const out = new Set<string>()
    for (const o of outlines) {
      const own = (e.from.nodeId === o.n.id && !e.from.textId) || (e.to.nodeId === o.n.id && !e.to.textId)
      if (own || out.has(o.color)) continue
      if (box.x2 < o.box.x1 || o.box.x2 < box.x1 || box.y2 < o.box.y1 || o.box.y2 < box.y1) continue
      if (segs.some((s) => o.segs.some((t) => meets(s, t)))) out.add(o.color)
    }
    return out
  })

  // Greedy: in board order, keep the connector's own color unless a crossing
  // connector already shows it; otherwise take the first hue nobody nearby has.
  const shown: string[] = edges.map((E) => E.base)
  const out = new Map<string, string>()
  edges.forEach((E, i) => {
    if (!neighbours[i].length && !outlineColors[i].size) return
    const taken = new Set([...outlineColors[i], ...neighbours[i].filter((j) => j < i).map((j) => shown[j] ?? edges[j].base)])
    const pick = [E.base, ...HUES].find((c) => !taken.has(c)) ?? E.base
    shown[i] = pick
    if (pick !== E.base) out.set(E.e.id, pick)
  })
  return out
}
