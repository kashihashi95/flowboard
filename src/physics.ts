import type { Doc, Pt } from './types'

/** A force layout in the spirit of Obsidian's graph view: connected shapes
 *  pull toward each other, every shape pushes the others away, and a gentle
 *  pull toward the middle keeps the board from drifting apart. Sections stay
 *  put; pinned shapes (being dragged or edited) push others but don't move. */

export interface Sim {
  vel: Map<string, Pt>
  /** Energy left; forces scale with it and it cools every frame. */
  alpha: number
  /** Point the board is pulled toward (its middle when physics started). */
  anchor: Pt | null
}

export const newSim = (): Sim => ({ vel: new Map(), alpha: 1, anchor: null })

export const reheat = (sim: Sim, to = 0.6) => {
  sim.alpha = Math.max(sim.alpha, to)
}

const REPEL = 90000
const SPRING = 0.035
const GAP = 70
const GRAVITY = 0.0025
const DAMPING = 0.72
const MAX_SPEED = 40
const MARGIN = 18

/** One frame. Returns new top-left positions for shapes that moved, or null when settled. */
export function step(doc: Doc, sim: Sim, pinned: Set<string>): Map<string, Pt> | null {
  const bodies = doc.nodes.filter((n) => n.kind !== 'section')
  if (!bodies.length || sim.alpha < 0.004) return null
  const c = bodies.map((n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 }))
  const r = bodies.map((n) => Math.hypot(n.w, n.h) / 2)
  if (!sim.anchor) sim.anchor = { x: c.reduce((s, p) => s + p.x, 0) / c.length, y: c.reduce((s, p) => s + p.y, 0) / c.length }
  const index = new Map(bodies.map((n, i) => [n.id, i]))
  const f = bodies.map(() => ({ x: 0, y: 0 }))
  const a = sim.alpha

  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      let dx = c[j].x - c[i].x
      let dy = c[j].y - c[i].y
      if (dx === 0 && dy === 0) {
        dx = Math.random() - 0.5
        dy = Math.random() - 0.5
      }
      const d = Math.max(Math.hypot(dx, dy), 1)
      const ux = dx / d
      const uy = dy / d
      // Repulsion falls off with distance, measured between the shapes' edges.
      const gap = Math.max(d - (r[i] + r[j]) * 0.6, 20)
      const rep = (REPEL * a) / (gap * gap)
      f[i].x -= ux * rep
      f[i].y -= uy * rep
      f[j].x += ux * rep
      f[j].y += uy * rep
      // Overlapping boxes are pushed straight apart.
      const ox = (bodies[i].w + bodies[j].w) / 2 + MARGIN - Math.abs(dx)
      const oy = (bodies[i].h + bodies[j].h) / 2 + MARGIN - Math.abs(dy)
      if (ox > 0 && oy > 0) {
        const push = 0.25
        if (ox < oy) {
          const s = Math.sign(dx) * ox * push
          f[i].x -= s
          f[j].x += s
        } else {
          const s = Math.sign(dy) * oy * push
          f[i].y -= s
          f[j].y += s
        }
      }
    }
  }

  for (const e of doc.edges) {
    const i = e.from.nodeId ? index.get(e.from.nodeId) : undefined
    const j = e.to.nodeId ? index.get(e.to.nodeId) : undefined
    if (i === undefined || j === undefined || i === j) continue
    const dx = c[j].x - c[i].x
    const dy = c[j].y - c[i].y
    const d = Math.max(Math.hypot(dx, dy), 1)
    const rest = (r[i] + r[j]) * 0.8 + GAP
    const k = (d - rest) * SPRING * Math.max(a, 0.15)
    f[i].x += (dx / d) * k
    f[i].y += (dy / d) * k
    f[j].x -= (dx / d) * k
    f[j].y -= (dy / d) * k
  }

  const out = new Map<string, Pt>()
  let energy = 0
  bodies.forEach((n, i) => {
    if (pinned.has(n.id)) {
      sim.vel.set(n.id, { x: 0, y: 0 })
      return
    }
    f[i].x += (sim.anchor!.x - c[i].x) * GRAVITY * Math.max(a, 0.2)
    f[i].y += (sim.anchor!.y - c[i].y) * GRAVITY * Math.max(a, 0.2)
    const v = sim.vel.get(n.id) ?? { x: 0, y: 0 }
    let vx = (v.x + f[i].x) * DAMPING
    let vy = (v.y + f[i].y) * DAMPING
    const speed = Math.hypot(vx, vy)
    if (speed > MAX_SPEED) {
      vx *= MAX_SPEED / speed
      vy *= MAX_SPEED / speed
    }
    sim.vel.set(n.id, { x: vx, y: vy })
    energy = Math.max(energy, Math.abs(vx), Math.abs(vy))
    if (Math.abs(vx) + Math.abs(vy) > 0.01) out.set(n.id, { x: n.x + vx, y: n.y + vy })
  })
  sim.alpha *= 0.985
  // Settled: stop until something stirs it again.
  if (energy < 0.03 && sim.alpha < 0.3) sim.alpha = 0
  return out.size ? out : null
}
