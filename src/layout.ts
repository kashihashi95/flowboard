import { insideRect } from './geometry'
import { fitToText } from './richtext'
import { layoutCost, routeEdges } from './route'
import type { Flow } from './route'
import type { Doc, NodeEl } from './types'

/** Automatic layout for boards written without positions: a layered
 *  ("Sugiyama-style") flowchart layout. Each section is laid out as its own
 *  block, which then sits in its parent's layout like one big shape, so
 *  sections never overlap. Shapes with no connections go in a side lane. */

export type Direction = 'down' | 'right'

const GAP_MAIN = 80 // between layers
const GAP_CROSS = 60 // between neighbours in a layer
/** Room for one connector running past. */
const LANE = 14
const SECTION_PAD = 40
const SECTION_TOP = 48
/** Room for a section's name tab, which sits above its top edge. */
const TAB = 36

interface Item {
  id: string
  w: number
  h: number
  /** For a section: positions of its contents relative to its top-left. */
  inner?: Map<string, { x: number; y: number }>
}

/** Lays out `doc` in place for every node in `auto`. `parent` maps a node to
 *  the section it was written under. */
export function autoLayout(doc: Doc, auto: Set<string>, parent: Map<string, string>, dir: Direction): Doc {
  const children = new Map<string | undefined, NodeEl[]>()
  for (const n of doc.nodes) {
    if (!auto.has(n.id)) continue
    const p = parent.get(n.id)
    const key = p && auto.has(p) ? p : undefined
    children.set(key, [...(children.get(key) ?? []), n])
  }
  // The direct child of `group` that contains `id` (the node itself or a section around it).
  const liftTo = (id: string, group: string | undefined): string | undefined => {
    let cur: string | undefined = id
    while (cur) {
      const p = parent.get(cur)
      const pk = p && auto.has(p) ? p : undefined
      if (pk === group) return auto.has(cur) ? cur : undefined
      cur = p
    }
    return undefined
  }

  const notes = new Set<string>()
  const layoutGroup = (group: string | undefined): Item & { inner: Map<string, { x: number; y: number }> } => {
    const members = children.get(group) ?? []
    // A section's slot includes its name tab; the section itself sits TAB lower.
    const items: Item[] = members.map((n) => {
      if (n.kind !== 'section') return { id: n.id, w: n.w, h: n.h }
      const it = layoutGroup(n.id)
      return { ...it, id: n.id, h: it.h + TAB }
    })
    const index = new Map(items.map((it, i) => [it.id, i]))
    const out = new Map<number, Set<number>>()
    const inc = new Map<number, Set<number>>()
    const lifted: [number, number, boolean][] = []
    for (const e of doc.edges) {
      if (!e.from.nodeId || !e.to.nodeId) continue
      // An arrow drawn backwards (head only at the start) flows the other way.
      const backwards = e.startHead !== 'none' && e.endHead === 'none'
      const a = liftTo(backwards ? e.to.nodeId : e.from.nodeId, group)
      const b = liftTo(backwards ? e.from.nodeId : e.to.nodeId, group)
      if (!a || !b || a === b) continue
      lifted.push([index.get(a)!, index.get(b)!, e.dashed])
    }
    // A dashed connector is a side note ("tests", "decides") unless it's the
    // only way into what it points at: then it's part of the flow.
    const solidIn = new Set(lifted.filter((x) => !x[2]).map((x) => x[1]))
    for (const [i, j, dashed] of lifted) {
      if (dashed && solidIn.has(j)) continue
      if (!out.has(i)) out.set(i, new Set())
      if (!inc.has(j)) inc.set(j, new Set())
      out.get(i)!.add(j)
      inc.get(j)!.add(i)
    }
    const connected = items.map((_, i) => out.has(i) || inc.has(i))

    // Where things are now (or the order they were written in), so a tidy
    // keeps the board's rough arrangement: which way loops go, what sits left.
    const spread = members.some((n) => n.x !== members[0].x || n.y !== members[0].y)
    const was = members.map((n, i) => (spread ? { m: dir === 'down' ? n.y : n.x, c: dir === 'down' ? n.x : n.y } : { m: i, c: i }))
    const byWas = (a: number, b: number) => was[a].m - was[b].m || was[a].c - was[b].c || a - b

    // Break cycles: drop edges that point back to an item still being visited.
    const state = items.map(() => 0)
    const forward = new Map<number, number[]>()
    const seen: number[] = []
    const visit = (i: number) => {
      state[i] = 1
      seen.push(i)
      for (const j of [...(out.get(i) ?? [])].sort(byWas)) {
        if (state[j] === 1) continue
        forward.set(i, [...(forward.get(i) ?? []), j])
        if (state[j] === 0) visit(j)
      }
      state[i] = 2
    }
    const roots = items.map((_, i) => i).sort(byWas)
    for (const i of roots) if (connected[i] && !inc.has(i) && state[i] === 0) visit(i)
    for (const i of roots) if (connected[i] && state[i] === 0) visit(i)
    const seenAt = new Map(seen.map((i, k) => [i, k]))

    // Longest-path layering.
    const rank = items.map(() => 0)
    const order = items.map((_, i) => i).filter((i) => connected[i])
    for (let pass = 0; pass < items.length; pass++) {
      let changed = false
      for (const i of order)
        for (const j of forward.get(i) ?? [])
          if (rank[j] < rank[i] + 1) {
            rank[j] = rank[i] + 1
            changed = true
          }
      if (!changed) break
    }
    const preds = new Map<number, number[]>()
    for (const [i, js] of forward) for (const j of js) preds.set(j, [...(preds.get(j) ?? []), i])
    // A note: something with no incoming arrows that only points at steps
    // already reached another way. It sits just below what it points to.
    const isNote = new Set<number>()
    for (const i of order) {
      const succ = forward.get(i) ?? []
      if (items[i].inner === undefined && !preds.has(i) && succ.length && succ.every((j) => (preds.get(j) ?? []).some((p) => p !== i && preds.has(p)))) isNote.add(i)
    }
    for (const i of isNote) {
      rank[i] = Math.max(...(forward.get(i) ?? []).map((j) => rank[j])) + 1
      notes.add(items[i].id)
    }
    // Other starting points sit just above the first step they lead to.
    for (const i of order) {
      if (preds.has(i) || isNote.has(i)) continue
      const succ = forward.get(i) ?? []
      if (succ.length) rank[i] = Math.max(rank[i], Math.min(...succ.map((j) => rank[j])) - 1)
    }

    // The layered graph: items, plus a waypoint in every layer a long connector passes.
    const main = (it: Item) => (dir === 'down' ? it.h : it.w)
    const cross = (it: Item) => (dir === 'down' ? it.w : it.h)
    interface V {
      item?: number
      size: number
      key: number
    }
    const vs: V[] = []
    const vOf = new Map<number, number>()
    const maxRank = Math.max(0, ...order.map((i) => rank[i]))
    const layers: number[][] = Array.from({ length: maxRank + 1 }, () => [])
    const key = (i: number) => (spread ? was[i].c : (seenAt.get(i) ?? i))
    for (const i of order) {
      vOf.set(i, vs.length)
      layers[rank[i]].push(vs.length)
      vs.push({ item: i, size: cross(items[i]), key: key(i) })
    }
    const up = vs.map(() => [] as number[])
    const down = vs.map(() => [] as number[])
    const link = (a: number, b: number) => {
      down[a].push(b)
      up[b].push(a)
    }
    for (const [i, js] of forward)
      for (const j of js) {
        // Notes sit below what they point at: the connector runs upwards.
        const [lo, hi] = rank[i] <= rank[j] ? [i, j] : [j, i]
        let prev = vOf.get(lo)!
        for (let r = rank[lo] + 1; r < rank[hi]; r++) {
          const t = (r - rank[lo]) / (rank[hi] - rank[lo])
          const d = vs.length
          vs.push({ size: LANE, key: key(lo) * (1 - t) + key(hi) * t })
          up.push([])
          down.push([])
          layers[r].push(d)
          link(prev, d)
          prev = d
        }
        if (rank[hi] > rank[lo]) link(prev, vOf.get(hi)!)
      }

    // Order each layer to keep connectors from crossing: start from the
    // current arrangement, then sweep with barycenters and swap neighbours.
    for (const l of layers) l.sort((a, b) => vs[a].key - vs[b].key || a - b)
    const posIn = new Array<number>(vs.length).fill(0)
    const index_ = () => layers.forEach((l) => l.forEach((v, k) => (posIn[v] = k)))
    const crossingsBetween = (r: number) => {
      const pairs: [number, number][] = []
      for (const v of layers[r]) for (const w of down[v]) pairs.push([posIn[v], posIn[w]])
      let c = 0
      for (let a = 0; a < pairs.length; a++)
        for (let b = a + 1; b < pairs.length; b++) if ((pairs[a][0] - pairs[b][0]) * (pairs[a][1] - pairs[b][1]) < 0) c++
      return c
    }
    const total = () => {
      index_()
      let c = 0
      for (let r = 0; r < layers.length - 1; r++) c += crossingsBetween(r)
      return c
    }
    let best = layers.map((l) => [...l])
    let bestCount = total()
    for (let iter = 0, still = 0; iter < 24 && still < 4 && bestCount > 0; iter++) {
      const downward = iter % 2 === 0
      const rs = layers.map((_, r) => r)
      if (!downward) rs.reverse()
      for (const r of rs) {
        const nb = downward ? up : down
        const bc = new Map<number, number>()
        for (const v of layers[r]) {
          const ns = nb[v]
          bc.set(v, ns.length ? ns.reduce((s, w) => s + posIn[w], 0) / ns.length : posIn[v])
        }
        layers[r].sort((a, b) => bc.get(a)! - bc.get(b)! || posIn[a] - posIn[b])
        layers[r].forEach((v, k) => (posIn[v] = k))
      }
      // Swap neighbours while that removes crossings.
      for (let r = 0; r < layers.length; r++) {
        const l = layers[r]
        let improved = true
        for (let guard = 0; improved && guard < 8; guard++) {
          improved = false
          for (let k = 0; k + 1 < l.length; k++) {
            const local = () => (r > 0 ? crossingsBetween(r - 1) : 0) + (r < layers.length - 1 ? crossingsBetween(r) : 0)
            const before = local()
            ;[l[k], l[k + 1]] = [l[k + 1], l[k]]
            posIn[l[k]] = k
            posIn[l[k + 1]] = k + 1
            if (local() < before) improved = true
            else {
              ;[l[k], l[k + 1]] = [l[k + 1], l[k]]
              posIn[l[k]] = k
              posIn[l[k + 1]] = k + 1
            }
          }
        }
      }
      const c = total()
      if (c < bestCount) {
        bestCount = c
        best = layers.map((l) => [...l])
        still = 0
      } else still++
    }
    best.forEach((l, r) => (layers[r] = l))
    index_()

    // Positions across the flow: each thing as close as it can get to the
    // middle of what it connects to, in its layer's order, without overlapping.
    const cx = new Array<number>(vs.length).fill(0)
    const gapBetween = (a: number, b: number) => {
      const da = vs[a].item === undefined
      const db = vs[b].item === undefined
      return (vs[a].size + vs[b].size) / 2 + (da && db ? 0 : da || db ? 24 : GAP_CROSS)
    }
    for (const l of layers) {
      let c = 0
      l.forEach((v, k) => {
        if (k) c += gapBetween(l[k - 1], v)
        cx[v] = c
      })
    }
    const settle = (l: number[], want: (v: number) => number | undefined) => {
      if (!l.length) return
      // Least-squares fit under "keep order and spacing" (pool adjacent violators).
      const off: number[] = [0]
      for (let k = 1; k < l.length; k++) off[k] = off[k - 1] + gapBetween(l[k - 1], l[k])
      const blocks: { w: number; s: number; n: number }[] = []
      l.forEach((v, k) => {
        const t = (want(v) ?? cx[v]) - off[k]
        const w = vs[v].item === undefined ? 2 : 1
        blocks.push({ w, s: w * t, n: 1 })
        while (blocks.length > 1 && blocks[blocks.length - 2].s / blocks[blocks.length - 2].w > blocks[blocks.length - 1].s / blocks[blocks.length - 1].w) {
          const b = blocks.pop()!
          const a = blocks[blocks.length - 1]
          a.w += b.w
          a.s += b.s
          a.n += b.n
        }
      })
      let k = 0
      for (const b of blocks) for (let q = 0; q < b.n; q++, k++) cx[l[k]] = b.s / b.w + off[k]
    }
    const mean = (ns: number[]) => (ns.length ? ns.reduce((s, w) => s + cx[w], 0) / ns.length : undefined)
    for (let iter = 0; iter < 10; iter++) {
      for (let r = 1; r < layers.length; r++) settle(layers[r], (v) => mean(up[v]))
      for (let r = layers.length - 2; r >= 0; r--) settle(layers[r], (v) => mean(down[v]))
    }
    for (let iter = 0; iter < 3; iter++) for (const l of layers) settle(l, (v) => mean([...up[v], ...down[v]]))

    // Layers along the flow, with room between them for the connectors that jog sideways.
    const depthOf = layers.map((l) => Math.max(0, ...l.map((v) => (vs[v].item === undefined ? 0 : main(items[vs[v].item!])))))
    const mainAt: number[] = []
    for (let r = 0, m = 0; r < layers.length; r++) {
      mainAt[r] = m
      const jogs: [number, number][] = []
      for (const v of layers[r]) for (const w of down[v]) if (Math.abs(cx[v] - cx[w]) > 3) jogs.push([Math.min(cx[v], cx[w]), Math.max(cx[v], cx[w])])
      let deepest = 0
      for (const [a] of jogs) deepest = Math.max(deepest, jogs.filter(([p, q]) => p <= a && q > a).length)
      m += depthOf[r] + GAP_MAIN + Math.max(0, deepest - 2) * LANE
    }
    const pos = new Map<number, { m: number; c: number }>()
    for (const l of layers)
      for (const v of l) {
        const i = vs[v].item
        if (i === undefined) continue
        pos.set(i, { m: mainAt[rank[i]] + (depthOf[rank[i]] - main(items[i])) / 2, c: Math.round(cx[v] - cross(items[i]) / 2) })
      }
    // Shapes without connections: a lane beside the flow.
    const loose = items.map((_, i) => i).filter((i) => !connected[i])
    if (loose.length) {
      const maxCross = order.length ? Math.max(...order.map((i) => pos.get(i)!.c + cross(items[i]))) + GAP_CROSS * 1.5 : 0
      let lm = 0
      for (const i of loose) {
        pos.set(i, { m: lm, c: maxCross })
        lm += main(items[i]) + GAP_CROSS
      }
    }

    // Normalise to start at 0,0 and convert to x/y.
    const minC = Math.min(...[...pos.values()].map((p) => p.c), 0)
    const inner = new Map<string, { x: number; y: number }>()
    let w = 0
    let h = 0
    items.forEach((it, i) => {
      const p = pos.get(i)
      if (!p) return
      const c = p.c - minC
      const x = dir === 'down' ? c : p.m
      const y = (dir === 'down' ? p.m : c) + (it.inner ? TAB : 0)
      inner.set(it.id, { x, y })
      w = Math.max(w, x + it.w)
      h = Math.max(h, y + it.h - (it.inner ? TAB : 0))
      // A section's contents move with it.
      for (const [id, q] of it.inner ?? []) inner.set(id, { x: x + q.x, y: y + q.y })
    })
    if (group === undefined) return { id: '', w, h, inner }
    const pad = new Map<string, { x: number; y: number }>()
    for (const [id, q] of inner) pad.set(id, { x: q.x + SECTION_PAD, y: q.y + SECTION_TOP })
    return { id: group, w: Math.max(w + SECTION_PAD * 2, 240), h: Math.max(h + SECTION_TOP + SECTION_PAD, 160), inner: pad }
  }

  // Sections' sizes come from their contents.
  const sizes = new Map<string, { w: number; h: number }>()
  const collectSizes = (group: string | undefined) => {
    for (const n of children.get(group) ?? [])
      if (n.kind === 'section') {
        const it = layoutGroup(n.id)
        sizes.set(n.id, { w: it.w, h: it.h })
        collectSizes(n.id)
      }
  }
  collectSizes(undefined)
  const top = layoutGroup(undefined)

  // Put the laid-out block to the right of anything that already had a position.
  const fixed = doc.nodes.filter((n) => !auto.has(n.id))
  const ox = fixed.length ? Math.max(...fixed.map((n) => n.x + n.w)) + 160 : 0
  const oy = fixed.length ? Math.min(...fixed.map((n) => n.y)) : 0
  const nodes = doc.nodes.map((n) => {
    const p = top.inner.get(n.id)
    if (!p) return n
    const size = sizes.get(n.id)
    return { ...n, x: p.x + ox, y: p.y + oy, ...(size ?? {}) }
  })
  // Connectors that loop back against the flow go around the side, so they
  // don't run on top of the forward connectors.
  const placed = new Map(nodes.map((n) => [n.id, n]))
  const edges = doc.edges.map((e) => {
    const a = e.from.nodeId ? placed.get(e.from.nodeId) : undefined
    const b = e.to.nodeId ? placed.get(e.to.nodeId) : undefined
    if (!a || !b || !auto.has(a.id) || !auto.has(b.id) || e.from.side || e.to.side || e.from.textId || e.to.textId) return e
    // Notes point up (or back) at what they describe.
    if (notes.has(a.id)) return { ...e, from: { ...e.from, side: dir === 'down' ? 'top' : 'left' }, to: { ...e.to, side: dir === 'down' ? 'bottom' : 'right' } } as typeof e
    const back = dir === 'down' ? b.y + b.h <= a.y : b.x + b.w <= a.x
    const ahead = dir === 'down' ? b.y >= a.y + a.h : b.x >= a.x + a.w
    // Forward connectors leave the bottom and enter the top, like a tree.
    if (ahead) return { ...e, from: { ...e.from, side: dir === 'down' ? 'bottom' : 'right' }, to: { ...e.to, side: dir === 'down' ? 'top' : 'left' } } as typeof e
    if (!back) return e
    const side = dir === 'down' ? 'right' : 'bottom'
    return { ...e, from: { ...e.from, side }, to: { ...e.to, side } } as typeof e
  })
  return { nodes, edges }
}

/** The smallest section fully containing each shape. */
export function containingSections(nodes: NodeEl[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of nodes) {
    let best: NodeEl | undefined
    for (const s of nodes) {
      if (s.kind !== 'section' || s.id === n.id || !insideRect(s, n)) continue
      if (!best || s.w * s.h < best.w * best.h) best = s
    }
    if (best) out.set(n.id, best.id)
  }
  return out
}

/** Rearrange a whole board into a tidy flowchart, keeping it roughly where it was. */
export function tidyUp(doc: Doc): Doc {
  if (!doc.nodes.length) return doc
  const map = new Map(doc.nodes.map((n) => [n.id, n]))
  // Which way the board already flows: count connectors whose far end sits
  // wholly to the right of the near one, and those wholly below.
  let right = 0
  let below = 0
  for (const e of doc.edges) {
    const a = e.from.nodeId && map.get(e.from.nodeId)
    const b = e.to.nodeId && map.get(e.to.nodeId)
    if (!a || !b) continue
    if (b.x >= a.x + a.w || a.x >= b.x + b.w) right++
    if (b.y >= a.y + a.h || a.y >= b.y + b.h) below++
  }
  const before = { x: Math.min(...doc.nodes.map((n) => n.x)), y: Math.min(...doc.nodes.map((n) => n.y)) }
  // Pinned sides suited the old arrangement; let connectors pick again.
  const unpinned: Doc = {
    // Shapes whose words spill out grow to hold them, so no connector runs over the overflow.
    nodes: doc.nodes.map((n) => (n.kind === 'section' ? n : fitToText(n))),
    edges: doc.edges.map((e) => ({
      ...e,
      points: undefined,
      from: e.from.nodeId ? { ...e.from, side: undefined, at: undefined } : e.from,
      to: e.to.nodeId ? { ...e.to, side: undefined, at: undefined } : e.to,
    })),
  }
  const lay = (dir: Flow) => {
    const laid = autoLayout(unpinned, new Set(doc.nodes.map((n) => n.id)), containingSections(doc.nodes), dir)
    const nodes = laid.nodes.map((n) => ({ ...n, x: Math.round(n.x + before.x), y: Math.round(n.y + before.y) }))
    return routeEdges({ nodes, edges: unpinned.edges }, dir)
  }
  // Lay it out both ways and keep the less tangled one. The way the board
  // already flows wins unless the other is clearly better, so tidying a tidy
  // board doesn't turn it on its side.
  const now: Flow = right > below * 1.3 ? 'right' : 'down'
  const kept = lay(now)
  if (doc.edges.length < 2) return kept
  const other = lay(now === 'right' ? 'down' : 'right')
  return layoutCost(other) < layoutCost(kept) * 0.85 ? other : kept
}
