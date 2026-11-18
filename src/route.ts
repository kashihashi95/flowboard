import { edgePolyline, lineHeight, measure, polylineAt, resolveEnds, sectionTitleRect } from './geometry'
import type { Doc, EdgeEl, EdgeEnd, NodeEl, Pt, Rect, Side } from './types'

/** Routes a laid-out board's connectors around its shapes, the way a tidy
 *  flowchart draws them: every connector leaves and enters straight, keeps
 *  clear of words and outlines, bends as little as it can, and runs in its own
 *  lane where it travels beside others. The result is stored as pinned sides
 *  and corner points, so it reads back from a file exactly as it was. */

export type Flow = 'down' | 'right'

/** Space kept around shapes. */
const PAD = 12
/** How far a connector runs straight out of a shape before it may turn. */
const STUB = 20
/** Space between neighbouring connectors running side by side. */
const LANE = 12
/** Extra length a bend is worth. */
const BEND = 50
/** Extra length a crossing is worth. */
const CROSS = 90
/** How hard the search leans toward the goal: a little over 1 finds nearly
 *  the best route in a fraction of the time. */
const GREED = 1.3


/** Words the connector attaches to at each end ("link joins" between the same phrase stay hidden). */
function phraseOf(n: NodeEl | undefined, id: string | undefined): string | null {
  if (!n?.rich || !id) return null
  return (
    n.rich
      .flatMap((p) => p.runs.filter((r) => r.link === id).map((r) => r.text))
      .join('')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase() || null
  )
}
export const isHiddenJoin = (e: EdgeEl, nodes: Map<string, NodeEl>) => {
  if (!e.dashed || e.startHead !== 'none' || e.endHead !== 'none') return false
  const a = phraseOf(nodes.get(e.from.nodeId ?? ''), e.from.textId)
  return !!a && a === phraseOf(nodes.get(e.to.nodeId ?? ''), e.to.textId)
}

const lowerBound = (xs: Float64Array | number[], v: number) => {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Binary heap of (priority, value). */
class Heap {
  p: number[] = []
  v: number[] = []
  push(p: number, v: number) {
    const P = this.p
    const V = this.v
    let i = P.length
    P.push(p)
    V.push(v)
    while (i > 0) {
      const j = (i - 1) >> 1
      if (P[j] <= p) break
      P[i] = P[j]
      V[i] = V[j]
      i = j
    }
    P[i] = p
    V[i] = v
  }
  pop(): number {
    const P = this.p
    const V = this.v
    const top = V[0]
    const lp = P.pop()!
    const lv = V.pop()!
    if (P.length) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= P.length) break
        if (c + 1 < P.length && P[c + 1] < P[c]) c++
        if (P[c] >= lp) break
        P[i] = P[c]
        V[i] = V[c]
        i = c
      }
      P[i] = lp
      V[i] = lv
    }
    return top
  }
  get size() {
    return this.p.length
  }
}

interface Job {
  e: EdgeEl
  p1: Pt
  d1: Pt
  p2: Pt
  d2: Pt
  /** A connector looping back against the flow, sent around the outside. */
  back?: { lo: number; hi: number }
  /** Where a connector from words inside a shape crosses its outline. */
  q1?: Pt
  q2?: Pt
  pts?: Pt[]
}

const dirIndex = (d: Pt) => (d.x > 0 ? 0 : d.x < 0 ? 1 : d.y > 0 ? 2 : 3)
const DX = [1, -1, 0, 0]
const DY = [0, 0, 1, -1]

export function routeEdges(doc: Doc, flow: Flow): Doc {
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]))
  const down = flow === 'down'
  const solid = doc.nodes.filter((n) => n.kind !== 'section')
  if (!solid.length) return doc
  const minX = Math.min(...doc.nodes.map((n) => n.x))
  const maxX = Math.max(...doc.nodes.map((n) => n.x + n.w))
  const minY = Math.min(...doc.nodes.map((n) => n.y - (n.kind === 'section' ? 36 : 0)))
  const maxY = Math.max(...doc.nodes.map((n) => n.y + n.h))
  const mid = down ? (minX + maxX) / 2 : (minY + maxY) / 2

  // Which way each connector flows (a head only at the start flows backwards).
  const backwards = (e: EdgeEl) => e.startHead !== 'none' && e.endHead === 'none'
  const fed = new Set<string>()
  for (const e of doc.edges) {
    const t = backwards(e) ? e.from.nodeId : e.to.nodeId
    if (t) fed.add(t)
  }

  // ---- sides ----
  type Pick = { e: EdgeEl; from?: Side; to?: Side; back?: { lo: number; hi: number }; pinned?: { from: boolean; to: boolean } }
  const picks: Pick[] = []
  for (const e of doc.edges) {
    const A0 = e.from.nodeId ? nodes.get(e.from.nodeId) : undefined
    const B0 = e.to.nodeId ? nodes.get(e.to.nodeId) : undefined
    if (!A0 || !B0 || A0 === B0 || isHiddenJoin(e, nodes)) continue
    const rev = backwards(e)
    const [A, B] = rev ? [B0, A0] : [A0, B0]
    // Along the flow (m) and across it (c).
    const m0 = (n: NodeEl) => (down ? n.y : n.x)
    const m1 = (n: NodeEl) => (down ? n.y + n.h : n.x + n.w)
    const c = (n: NodeEl) => (down ? n.x + n.w / 2 : n.y + n.h / 2)
    const [ahead, behind, plus, minus]: Side[] = down ? ['bottom', 'top', 'right', 'left'] : ['right', 'left', 'bottom', 'top']
    let sa: Side
    let sb: Side
    let back: Pick['back']
    if (m0(B) >= m1(A) - 1) {
      sa = ahead
      sb = behind
    } else if (m1(B) <= m0(A) + 1) {
      if (!fed.has(A.id)) {
        // A note pointing back up at what it describes.
        sa = behind
        sb = ahead
      } else {
        // A loop: out the side and around, on whichever side of the board is nearer.
        sa = sb = (c(A) + c(B)) / 2 > mid ? plus : minus
        back = { lo: m0(B), hi: m1(A) }
      }
    } else {
      sa = c(B) >= c(A) ? plus : minus
      sb = c(B) >= c(A) ? minus : plus
    }
    const textA = rev ? e.to.textId : e.from.textId
    const textB = rev ? e.from.textId : e.to.textId
    const pa = textA ? undefined : sa
    const pb = textB ? undefined : sb
    // A side already pinned (written in a file) stays.
    const keepA = rev ? e.to.side : e.from.side
    const keepB = rev ? e.from.side : e.to.side
    const fa = keepA ?? pa
    const fb = keepB ?? pb
    picks.push({ e, from: rev ? fb : fa, to: rev ? fa : fb, back, pinned: { from: !!e.from.side && e.from.at !== undefined, to: !!e.to.side && e.to.at !== undefined } })
  }

  // ---- ports: along each side, lined up with the other end where they can
  // be (a straight connector), else spread in the order of where the other end is ----
  const at = new Map<string, number>() // `${edgeId}|from|to` -> at
  const horizSide = (s: Side) => s === 'top' || s === 'bottom'
  /** The stretch of a side a connector may attach to, in board coordinates. */
  const range = (n: NodeEl, side: Side): [number, number] => {
    const h = horizSide(side)
    const lo = h ? n.x : n.y
    const len = h ? n.w : n.h
    const pointy = n.kind === 'diamond' || n.kind === 'ellipse' || n.kind === 'hexagon'
    const f = pointy ? 0.2 : n.kind === 'rounded' || n.kind === 'cylinder' ? 0.3 : 0.4
    return [lo + len * (0.5 - f), lo + len * (0.5 + f)]
  }
  const midOf = (n: NodeEl, side: Side) => (horizSide(side) ? n.x + n.w / 2 : n.y + n.h / 2)
  const clamp = (v: number, r: [number, number]) => Math.min(Math.max(v, r[0]), r[1])
  const bySide = new Map<string, { want: number; key: number; id: string; end: 'from' | 'to'; outer: number }[]>()
  for (const p of picks) {
    const ends = (['from', 'to'] as const).filter((end) => p[end])
    const nodeOf = (end: 'from' | 'to') => nodes.get(p.e[end].nodeId!)!
    // Facing sides that overlap: both ends meet in the middle of the overlap.
    let shared: number | undefined
    if (ends.length === 2 && horizSide(p.from!) === horizSide(p.to!) && p.from !== p.to) {
      const ra = range(nodeOf('from'), p.from!)
      const rb = range(nodeOf('to'), p.to!)
      const lo = Math.max(ra[0], rb[0])
      const hi = Math.min(ra[1], rb[1])
      if (lo <= hi) shared = clamp((midOf(nodeOf('from'), p.from!) + midOf(nodeOf('to'), p.to!)) / 2, [lo, hi])
    }
    for (const end of ends) {
      const side = p[end]!
      const self = nodeOf(end)
      const other = nodeOf(end === 'from' ? 'to' : 'from')
      const oc = midOf(other, side)
      // Loops leave on the outer edge of their side; the longer the loop, the further out.
      const outer = p.back ? (side === 'right' || side === 'bottom' ? 1 : -1) * (p.back.hi - p.back.lo) : 0
      const r = range(self, side)
      const want = outer ? (outer > 0 ? r[1] : r[0]) : (shared ?? clamp(oc, r))
      const k = `${self.id}|${side}`
      bySide.set(k, [...(bySide.get(k) ?? []), { want, key: oc, id: p.e.id, end, outer }])
    }
  }
  for (const [k, list] of bySide) {
    const [id, side] = k.split('|') as [string, Side]
    const n = nodes.get(id)!
    const r = range(n, side)
    const len = horizSide(side) ? n.w : n.h
    const lo0 = horizSide(side) ? n.x : n.y
    list.sort((a, b) => (a.outer && !b.outer ? a.outer : !a.outer && b.outer ? -b.outer : a.outer - b.outer) || a.want - b.want || a.key - b.key)
    // As near their wish as they can be, in order, a lane apart, inside the side.
    const step = list.length > 1 ? Math.min(20, (r[1] - r[0]) / (list.length - 1)) : 0
    const blocks: { s: number; n: number }[] = []
    list.forEach((x, i) => {
      blocks.push({ s: x.want - i * step, n: 1 })
      while (blocks.length > 1 && blocks[blocks.length - 2].s / blocks[blocks.length - 2].n > blocks[blocks.length - 1].s / blocks[blocks.length - 1].n) {
        const b = blocks.pop()!
        blocks[blocks.length - 1].s += b.s
        blocks[blocks.length - 1].n += b.n
      }
    })
    const pos: number[] = []
    for (const b of blocks) for (let q = 0; q < b.n; q++) pos.push(b.s / b.n + pos.length * step)
    // Keep the whole row inside the side.
    const shift = Math.max(0, r[0] - pos[0]) - Math.max(0, pos[pos.length - 1] - r[1])
    list.forEach((x, i) => {
      const v = Math.round(((clamp(pos[i] + shift, r) - lo0) / len) * 1000) / 1000
      if (Math.abs(v - 0.5) > 0.0005) at.set(`${x.id}|${x.end}`, v)
    })
  }

  const edges = doc.edges.map((e) => {
    const p = picks.find((q) => q.e === e)
    if (!p) return e
    const end = (which: 'from' | 'to'): EdgeEnd => {
      const side = p[which]
      const rest: EdgeEnd = { ...e[which] }
      delete rest.side
      delete rest.at
      const a = p.pinned?.[which] ? e[which].at : at.get(`${e.id}|${which}`)
      return side ? (a !== undefined ? { ...rest, side, at: a } : { ...rest, side }) : rest
    }
    return { ...e, from: end('from'), to: end('to'), points: undefined }
  })
  const sided: Doc = { nodes: doc.nodes, edges }

  // ---- obstacles and the routing grid ----
  const obstacles: Rect[] = []
  for (const n of doc.nodes) {
    if (n.kind === 'section') {
      const t = sectionTitleRect(n)
      obstacles.push({ x: t.x - 4, y: t.y - 4, w: t.w + 8, h: t.h + 8 })
    } else obstacles.push({ x: n.x - PAD, y: n.y - PAD, w: n.w + 2 * PAD, h: n.h + 2 * PAD })
  }
  const jobs: Job[] = []
  for (const e of edges) {
    const p = picks.find((q) => q.e.id === e.id)
    if (!p || e.route !== 'elbow') continue
    const ends = resolveEnds(e, nodes)
    // Straight out to the shape's box first: past a diamond's slope, or along
    // the line of words a connector meets inside a shape.
    const exit = (end: EdgeEnd, p: Pt, d: Pt, lead?: Pt[]) => {
      const n = lead?.length ? undefined : nodes.get(end.nodeId!)
      if (!n) return undefined
      return d.x ? { x: d.x > 0 ? n.x + n.w : n.x, y: p.y } : { x: p.x, y: d.y > 0 ? n.y + n.h : n.y }
    }
    const q1 = exit(e.from, ends.p1, ends.d1, ends.lead1) ?? ends.p1
    let q2 = exit(e.to, ends.p2, ends.d2, ends.lead2) ?? ends.p2
    // Ends lined up to within rounding: one straight line, not a tiny jog.
    if (!ends.d1.x && !ends.d2.x && Math.abs(q1.x - q2.x) < 1.5) q2 = { x: q1.x, y: q2.y }
    if (!ends.d1.y && !ends.d2.y && Math.abs(q1.y - q2.y) < 1.5) q2 = { x: q2.x, y: q1.y }
    jobs.push({ e, p1: ends.p1, d1: ends.d1, p2: ends.p2, d2: ends.d2, back: p.back, q1, q2 })
  }
  if (!jobs.length) return sided
  const xsSet = new Set<number>()
  const ysSet = new Set<number>()
  const R = (v: number) => Math.round(v * 2) / 2
  for (const o of obstacles) {
    xsSet.add(R(o.x))
    xsSet.add(R(o.x + o.w))
    ysSet.add(R(o.y))
    ysSet.add(R(o.y + o.h))
  }
  const stub = (p: Pt, d: Pt) => ({ x: R(p.x + d.x * STUB), y: R(p.y + d.y * STUB) })
  for (const j of jobs) {
    for (const s of [stub(j.q1 ?? j.p1, j.d1), stub(j.q2 ?? j.p2, j.d2)]) {
      xsSet.add(s.x)
      ysSet.add(s.y)
    }
  }
  const margin = 48
  xsSet.add(R(minX - margin))
  xsSet.add(R(maxX + margin))
  ysSet.add(R(minY - margin))
  ysSet.add(R(maxY + margin))
  const withMids = (set: Set<number>) => {
    const s = [...set].sort((a, b) => a - b)
    const out = [...s]
    // Lanes: lines a lane apart through every gap, so connectors can run side by side.
    for (let i = 1; i < s.length; i++) {
      const gap = s[i] - s[i - 1]
      const k = Math.floor(gap / LANE) - 1
      for (let q = 1; q <= k; q++) out.push(R(s[i - 1] + (gap * q) / (k + 1)))
      if (k < 1 && gap > LANE) out.push(R((s[i] + s[i - 1]) / 2))
    }
    return Float64Array.from(new Set(out)).sort()
  }
  const X = withMids(xsSet)
  const Y = withMids(ysSet)
  const nx = X.length
  const ny = Y.length
  const N = nx * ny
  const blockP = new Uint8Array(N)
  const blockH = new Uint8Array(N) // segment from (i,j) to (i+1,j)
  const blockV = new Uint8Array(N) // segment from (i,j) to (i,j+1)
  for (const o of obstacles) {
    const i0 = lowerBound(X, o.x)
    const i1 = lowerBound(X, o.x + o.w)
    const j0 = lowerBound(Y, o.y)
    const j1 = lowerBound(Y, o.y + o.h)
    for (let j = j0; j <= j1 && j < ny; j++) {
      const yIn = Y[j] > o.y && Y[j] < o.y + o.h
      for (let i = i0; i <= i1 && i < nx; i++) {
        const xIn = X[i] > o.x && X[i] < o.x + o.w
        const k = j * nx + i
        if (xIn && yIn) blockP[k] = 1
        if (yIn && i + 1 < nx) {
          const mx = (X[i] + X[i + 1]) / 2
          if (mx > o.x && mx < o.x + o.w) blockH[k] = 1
        }
        if (xIn && j + 1 < ny) {
          const my = (Y[j] + Y[j + 1]) / 2
          if (my > o.y && my < o.y + o.h) blockV[k] = 1
        }
      }
    }
  }
  // Grid lines closer than a lane to each one: connectors there would run cramped.
  const near = (A: Float64Array) =>
    Array.from(A, (v, i) => {
      const out: number[] = []
      for (let k = i - 1; k >= 0 && v - A[k] < LANE - 0.5; k--) out.push(k)
      for (let k = i + 1; k < A.length && A[k] - v < LANE - 0.5; k++) out.push(k)
      return out
    })
  const nearRow = near(Y)
  const nearCol = near(X)
  const usedH = new Uint16Array(N) // routes passing a point horizontally
  const usedV = new Uint16Array(N)
  const segH = new Uint16Array(N) // routes on a grid segment
  const segV = new Uint16Array(N)
  // Whose connector lies on a segment: the shape it leaves from, or -1 for several.
  // Connectors from one shape may share a trunk; anyone else running on top is an overlap.
  const ownH = new Int32Array(N)
  const ownV = new Int32Array(N)
  const srcIndex = new Map<string, number>()
  const srcOf = (j: Job) => {
    const id = j.e.from.nodeId ?? j.e.id
    if (!srcIndex.has(id)) srcIndex.set(id, srcIndex.size + 1)
    return srcIndex.get(id)!
  }
  let who = 0

  // ---- A* per connector, shortest first ----
  const S = N * 4
  const g = new Float64Array(S)
  const stamp = new Uint32Array(S)
  const from = new Int32Array(S)
  const closed = new Uint32Array(S)
  let gen = 0
  jobs.sort((a, b) => (a.e.dashed ? 1 : 0) - (b.e.dashed ? 1 : 0) || Math.abs(a.p1.x - a.p2.x) + Math.abs(a.p1.y - a.p2.y) - (Math.abs(b.p1.x - b.p2.x) + Math.abs(b.p1.y - b.p2.y)) || (a.back ? 1 : 0) - (b.back ? 1 : 0))
  const gridOf = (p: Pt) => {
    const i = lowerBound(X, p.x - 0.25)
    const j = lowerBound(Y, p.y - 0.25)
    return Math.abs(X[i] - p.x) < 0.5 && Math.abs(Y[j] - p.y) < 0.5 ? j * nx + i : -1
  }
  const cellsOf = new Map<Job, number[]>()
  const mark = (cells: number[], by: number) => {
    for (let q = 1; q < cells.length; q++) {
      const a = cells[q - 1]
      const b = cells[q]
      if (((a / nx) | 0) === ((b / nx) | 0)) {
        const k = ((a / nx) | 0) * nx + Math.min(a % nx, b % nx)
        if (by > 0) ownH[k] = segH[k] && ownH[k] !== who ? -1 : who
        segH[k] += by
        usedH[a] += by
        usedH[b] += by
      } else {
        const k = Math.min((a / nx) | 0, (b / nx) | 0) * nx + (a % nx)
        if (by > 0) ownV[k] = segV[k] && ownV[k] !== who ? -1 : who
        segV[k] += by
        usedV[a] += by
        usedV[b] += by
      }
    }
  }
  // Route everything, then route each again knowing where all the others went.
  // Keep whichever pass crossed least (each pass routes knowing the last one).
  let best: { cost: number; pts: Map<Job, Pt[] | undefined> } | undefined
  const PASSES = 3
  for (let pass = 0; pass < PASSES; pass++) {
  const order = pass === 2 ? [...jobs].reverse() : jobs
  for (const job of order) {
    const before = cellsOf.get(job)
    who = srcOf(job)
    if (before) mark(before, -1)
    const s1 = stub(job.q1 ?? job.p1, job.d1)
    const s2 = stub(job.q2 ?? job.p2, job.d2)
    const start = gridOf(s1)
    const goal = gridOf(s2)
    if (start < 0 || goal < 0) {
      continue
    }
    const startDir = dirIndex(job.d1)
    const into = dirIndex({ x: -job.d2.x, y: -job.d2.y })
    const gx = goal % nx
    const gy = (goal / nx) | 0
    // Least length the rest needs, plus a bend when the goal isn't straight ahead.
    const h = (k: number, d: number) => {
      const dx = X[gx] - X[k % nx]
      const dy = Y[gy] - Y[(k / nx) | 0]
      const ahead = d === 0 ? dx > 0 && !dy : d === 1 ? dx < 0 && !dy : d === 2 ? dy > 0 && !dx : dy < 0 && !dx
      return Math.abs(dx) + Math.abs(dy) + (ahead || (!dx && !dy) ? 0 : BEND)
    }
    // A loop stays out of the band of shapes it passes.
    let bandLo = Infinity
    let bandHi = -Infinity
    if (job.back) {
      for (const n of solid) {
        const m0 = down ? n.y : n.x
        const m1 = down ? n.y + n.h : n.x + n.w
        if (m1 > job.back.lo && m0 < job.back.hi) {
          bandLo = Math.min(bandLo, down ? n.x : n.y)
          bandHi = Math.max(bandHi, down ? n.x + n.w : n.y + n.h)
        }
      }
    }
    let found = -1
    // Look near the two ends first; the whole board only when that fails.
    const si = start % nx
    const sj = (start / nx) | 0
    for (const wide of [false, true]) {
    const reach = 400
    const i0 = wide ? 0 : Math.max(0, lowerBound(X, Math.min(X[si], X[gx]) - reach))
    const i1 = wide ? nx - 1 : Math.min(nx - 1, lowerBound(X, Math.max(X[si], X[gx]) + reach))
    const j0 = wide ? 0 : Math.max(0, lowerBound(Y, Math.min(Y[sj], Y[gy]) - reach))
    const j1 = wide ? ny - 1 : Math.min(ny - 1, lowerBound(Y, Math.max(Y[sj], Y[gy]) + reach))
    gen++
    const heap = new Heap()
    const s0 = start * 4 + startDir
    g[s0] = 0
    stamp[s0] = gen
    from[s0] = -1
    heap.push(h(start, startDir), s0)
    while (heap.size) {
      const s = heap.pop()
      if (closed[s] === gen) continue
      closed[s] = gen
      const k = s >> 2
      const d = s & 3
      if (k === goal) {
        found = s
        break
      }
      const i = k % nx
      const j = (k / nx) | 0
      for (let nd = 0; nd < 4; nd++) {
        if ((nd ^ 1) === d && nd >> 1 === d >> 1) continue // no U-turns
        const ni = i + DX[nd]
        const nj = j + DY[nd]
        if (ni < i0 || nj < j0 || ni > i1 || nj > j1) continue
        const nk = nj * nx + ni
        const horiz = nd < 2
        const segK = horiz ? j * nx + Math.min(i, ni) : Math.min(j, nj) * nx + i
        const free = k === start || nk === goal || nk === start
        if (!free && (blockP[nk] || (horiz ? blockH[segK] : blockV[segK]))) continue
        const len = horiz ? Math.abs(X[ni] - X[i]) : Math.abs(Y[nj] - Y[j])
        let cost = len
        if (nd !== d) cost += BEND
        if (horiz ? usedV[nk] : usedH[nk]) cost += CROSS
        const shared = horiz ? segH[segK] : segV[segK]
        if (shared) cost += (horiz ? ownH[segK] : ownV[segK]) === who ? 60 + len * 4 * shared : 300 + len * 8 * shared
        if (horiz) {
          for (const r of nearRow[j]) if (segH[r * nx + Math.min(i, ni)]) cost += 20 + len
        } else for (const c of nearCol[i]) if (segV[Math.min(j, nj) * nx + c]) cost += 20 + len
        if (job.back && !horiz === down) {
          const c = down ? X[i] : Y[j]
          if (c > bandLo && c < bandHi) cost += len * 3
        }
        if (nk === goal && nd !== into) cost += BEND
        const ns = nk * 4 + nd
        const ng = g[s] + cost
        if (stamp[ns] === gen && g[ns] <= ng) continue
        stamp[ns] = gen
        g[ns] = ng
        from[ns] = s
        heap.push(ng + h(nk, nd) * GREED, ns)
      }
    }
    if (found >= 0 || (i0 === 0 && j0 === 0 && i1 === nx - 1 && j1 === ny - 1)) break
    }
    if (found < 0) {
      if (before) mark(before, 1)
      continue
    }
    const cells: number[] = []
    for (let s = found; s >= 0; s = from[s]) cells.push(s >> 2)
    cells.reverse()
    mark(cells, 1)
    cellsOf.set(job, cells)
    job.pts = simplify([job.p1, ...cells.map((k) => ({ x: X[k % nx], y: Y[(k / nx) | 0] })), job.p2])
  }
  let cost = 0
  const done = jobs.filter((j) => j.pts)
  for (let a = 0; a < done.length; a++) {
    cost += (done[a].pts!.length - 2) * 0.25
    for (let b = a + 1; b < done.length; b++) {
      cost += crossingsBetween(done[a].pts!, done[b].pts!)
      const ea = done[a].e
      const eb = done[b].e
      const kin = (ea.from.nodeId && ea.from.nodeId === eb.from.nodeId) || (ea.to.nodeId && ea.to.nodeId === eb.to.nodeId)
      if (!kin) cost += 5 * overlapsBetween(done[a].pts!, done[b].pts!)
    }
  }
  if (!best || cost < best.cost) best = { cost, pts: new Map(jobs.map((j) => [j, j.pts?.map((q) => ({ ...q }))])) }
  }
  for (const j of jobs) j.pts = best?.pts.get(j)

  const routed = jobs.filter((j) => j.pts && j.pts.length >= 2)
  const rects = doc.nodes.map((n) => (n.kind === 'section' ? sectionTitleRect(n) : n))
  swapLanes(routed, obstacles)
  const pointsOf = new Map<string, Pt[]>()
  for (const j of routed) {
    const pts = simplify(j.pts!)
    pointsOf.set(j.e.id, pts.slice(1, -1).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })))
  }
  const done = edges.map((e) => {
    const pts = pointsOf.get(e.id)
    return pts?.length ? { ...e, points: pts } : e
  })
  return { nodes: doc.nodes, edges: placeLabels(done, nodes, rects) }
}

/** Slide each label along its line to where it covers no shape, words or
 *  other line, as near the middle as it can. */
function placeLabels(edges: EdgeEl[], nodes: Map<string, NodeEl>, rects: Rect[]): EdgeEl[] {
  const lines = new Map(edges.filter((e) => !isHiddenJoin(e, nodes)).map((e) => [e.id, edgePolyline(e, nodes)]))
  const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  const segHit = (r: Rect, pts: Pt[]) =>
    pts.some((p, i) => {
      if (!i) return false
      const q = pts[i - 1]
      return hit(r, { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(p.x - q.x) || 0.01, h: Math.abs(p.y - q.y) || 0.01 })
    })
  const placed: Rect[] = []
  return edges.map((e) => {
    const pts = lines.get(e.id)
    if (!e.label.trim() || !pts || e.route === 'curved') return e
    const ls = e.label.split('\n')
    const w = Math.max(...ls.map((l) => measure(l, 14))) + 14 + 6
    const h = ls.length * lineHeight(14) + 6 + 6
    let best = { t: 0.5, cost: Infinity, r: { x: 0, y: 0, w: 0, h: 0 } }
    for (let k = 0; k <= 16; k++) {
      const t = 0.5 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.05
      const c = polylineAt(pts, t)
      const r = { x: c.x - w / 2, y: c.y - h / 2, w, h }
      let cost = Math.abs(t - 0.5)
      for (const s of rects) if (hit(r, s)) cost += 100
      for (const p of placed) if (hit(r, p)) cost += 50
      for (const [id, other] of lines) if (id !== e.id && segHit(r, other)) cost += 10
      if (cost < best.cost) best = { t, cost, r }
    }
    placed.push(best.r)
    const t = Math.round(best.t * 1000) / 1000
    const { labelAt: _old, ...rest } = e
    void _old
    return t === 0.5 ? rest : { ...rest, labelAt: t }
  })
}

function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1].x - p.x) < 0.01 && Math.abs(out[out.length - 1].y - p.y) < 0.01) continue
    out.push({ ...p })
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1]
    const b = out[i]
    const c = out[i + 1]
    if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)) out.splice(i, 1)
  }
  return out
}

/** Does segment a-b pass through the inside of r? */
function segThrough(a: Pt, b: Pt, r: Rect): boolean {
  if (Math.abs(a.y - b.y) < 0.01) return a.y > r.y && a.y < r.y + r.h && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.w
  return a.x > r.x && a.x < r.x + r.w && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h
}

/** Stretches where two routes run on top of each other. */
function overlapsBetween(p: Pt[], q: Pt[]): number {
  let n = 0
  for (let i = 1; i < p.length; i++)
    for (let j = 1; j < q.length; j++) {
      const [a, b, c, d] = [p[i - 1], p[i], q[j - 1], q[j]]
      const ah = Math.abs(a.y - b.y) < 0.01
      if (ah !== Math.abs(c.y - d.y) < 0.01) continue
      if (ah ? Math.abs(a.y - c.y) > 2 : Math.abs(a.x - c.x) > 2) continue
      const lo = ah ? Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) : Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y))
      const hi = ah ? Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) : Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y))
      if (hi - lo > 4) n++
    }
  return n
}

/** Proper crossings between two orthogonal routes. */
function crossingsBetween(p: Pt[], q: Pt[]): number {
  let n = 0
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]
    const b = p[i]
    const ah = Math.abs(a.y - b.y) < 0.01
    for (let j = 1; j < q.length; j++) {
      const c = q[j - 1]
      const d = q[j]
      const ch = Math.abs(c.y - d.y) < 0.01
      if (ah === ch) continue
      const [h1, h2, v1, v2] = ah ? [a, b, c, d] : [c, d, a, b]
      const x = v1.x
      const y = h1.y
      if (x > Math.min(h1.x, h2.x) + 0.01 && x < Math.max(h1.x, h2.x) - 0.01 && y > Math.min(v1.y, v2.y) + 0.01 && y < Math.max(v1.y, v2.y) - 0.01) n++
    }
  }
  return n
}

/** Connectors running beside each other in the same gap swap lanes when
 *  that crosses less: the router places one at a time, and the first ones
 *  in can't know where the later ones will need to turn. */
function swapLanes(jobs: Job[], obstacles: Rect[]) {
  const box = (p: Pt[]) => {
    const xs = p.map((q) => q.x)
    const ys = p.map((q) => q.y)
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
  }
  const touches = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1
  const kin = (a: Job, b: Job) => (a.e.from.nodeId && a.e.from.nodeId === b.e.from.nodeId) || (a.e.to.nodeId && a.e.to.nodeId === b.e.to.nodeId)
  const overOf = (j: Job) => {
    let n = 0
    for (const o of jobs) if (o !== j && !kin(o, j)) n += overlapsBetween(j.pts!, o.pts!)
    return n
  }
  // Every stretch still level or upright: a moved stretch next to an end can't be.
  const ortho = (j: Job) => j.pts!.every((q, i) => !i || Math.abs(q.x - j.pts![i - 1].x) < 0.5 || Math.abs(q.y - j.pts![i - 1].y) < 0.5)
  const crossOf = (j: Job) => {
    const bj = box(j.pts!)
    let n = 0
    for (const o of jobs) if (o !== j && touches(bj, box(o.pts!))) n += crossingsBetween(j.pts!, o.pts!)
    return n
  }
  // The middle stretches of a route stay clear of every shape; the end stubs may touch their own.
  const clear = (j: Job) => {
    const p = j.pts!
    const inside = (q: Pt, o: Rect) => q.x >= o.x && q.x <= o.x + o.w && q.y >= o.y && q.y <= o.y + o.h
    for (let i = 1; i < p.length; i++)
      for (const o of obstacles) {
        if ((i === 1 && inside(p[0], o)) || (i === p.length - 1 && inside(p[p.length - 1], o))) continue
        if (segThrough(p[i - 1], p[i], { x: o.x + 1, y: o.y + 1, w: o.w - 2, h: o.h - 2 })) return false
      }
    return true
  }
  // No two connectors on one line over the same stretch.
  const sharesLine = (j: Job, k: number, partner: Job) => {
    const p = j.pts!
    const a = p[k]
    const b = p[k + 1]
    const horiz = Math.abs(a.y - b.y) < 0.01
    const lo = horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
    const hi = horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
    for (const o of jobs) {
      if (o === j) continue
      const gap = o === partner ? 0.5 : LANE - 0.5
      const q = o.pts!
      for (let i = 1; i < q.length; i++) {
        const c = q[i - 1]
        const d = q[i]
        if (horiz ? Math.abs(c.y - d.y) > 0.01 || Math.abs(c.y - a.y) >= gap : Math.abs(c.x - d.x) > 0.01 || Math.abs(c.x - a.x) >= gap) continue
        const l2 = horiz ? Math.min(c.x, d.x) : Math.min(c.y, d.y)
        const h2 = horiz ? Math.max(c.x, d.x) : Math.max(c.y, d.y)
        if (Math.min(hi, h2) - Math.max(lo, l2) > 1) return true
      }
    }
    return false
  }
  const set = (j: Job, k: number, horiz: boolean, v: number) => {
    const p = j.pts!
    if (horiz) p[k].y = p[k + 1].y = v
    else p[k].x = p[k + 1].x = v
  }
  for (let round = 0; round < 4; round++) {
    let improved = false
    for (const horiz of [true, false]) {
      const segs: { j: Job; k: number; c: number; lo: number; hi: number }[] = []
      for (const j of jobs) {
        const p = j.pts!
        for (let k = 1; k < p.length - 2; k++) {
          const a = p[k]
          const b = p[k + 1]
          if ((Math.abs(a.y - b.y) < 0.01) !== horiz) continue
          segs.push({ j, k, c: horiz ? a.y : a.x, lo: horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y), hi: horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y) })
        }
      }
      for (let x = 0; x < segs.length; x++)
        for (let y = x + 1; y < segs.length; y++) {
          const A = segs[x]
          const B = segs[y]
          if (A.j === B.j || Math.min(A.hi, B.hi) - Math.max(A.lo, B.lo) <= 1 || Math.abs(A.c - B.c) > 240) continue
          const before = crossOf(A.j) + crossOf(B.j)
          if (!before) continue
          const over = overOf(A.j) + overOf(B.j)
          set(A.j, A.k, horiz, B.c)
          set(B.j, B.k, horiz, A.c)
          // Moving a stretch also stretches the two beside it: check all three.
          const lined = (J: typeof A, other: Job) => [J.k - 1, J.k, J.k + 1].some((k) => k >= 0 && k < J.j.pts!.length - 1 && sharesLine(J.j, k, other))
          const ok = ortho(A.j) && ortho(B.j) && clear(A.j) && clear(B.j) && !lined(A, B.j) && !lined(B, A.j) && crossOf(A.j) + crossOf(B.j) < before && overOf(A.j) + overOf(B.j) <= over
          if (ok) {
            ;[A.c, B.c] = [B.c, A.c]
            improved = true
          } else {
            set(A.j, A.k, horiz, A.c)
            set(B.j, B.k, horiz, B.c)
          }
        }
    }
    if (!improved) break
  }
}

/** How tangled a routed board looks: crossings weigh most, then corners, then
 *  total length. Used to choose which way Tidy up lays a board out. */
export function layoutCost(doc: Doc): number {
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]))
  const lines = doc.edges.filter((e) => !isHiddenJoin(e, nodes)).map((e) => edgePolyline(e, nodes))
  let cost = 0
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i]
    for (let k = 1; k < p.length; k++) cost += (Math.abs(p[k].x - p[k - 1].x) + Math.abs(p[k].y - p[k - 1].y)) / 10
    cost += Math.max(0, p.length - 2) * 20
    for (let j = i + 1; j < lines.length; j++) cost += crossingsBetween(p, lines[j]) * 300
  }
  return cost
}
