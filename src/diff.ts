import { linkGroups } from './mdformat'
import { paragraphsOf } from './richtext'
import type { Doc, EdgeEl, NodeEl } from './types'

/** How a newer board differs from an older one. */
export interface DocDiff {
  /** Shapes and connectors in the newer board that are new or edited. */
  changed: Set<string>
  /** Shapes and connectors of the older board that are gone. */
  removed: Doc
}

/** A shape's content and style, without its id, place or size (link ids are random, so only whether a run is a link counts). */
function nodeSig(n: NodeEl): string {
  const rich = n.rich?.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, link: !!r.link })) }))
  return JSON.stringify([n.kind, n.text, rich ?? null, n.color, n.fontSize, n.outline ?? null, n.outlineWidth ?? null, !!n.outlineDashed, n.src ?? null])
}

/** Pairs each newer shape with the older shape it stands for: the same id, or
 *  (for boards reopened from Markdown, which get fresh ids) the same content,
 *  or failing that the same kind in the same place, meaning its text was edited. */
function matchNodes(older: Doc, newer: Doc): Map<string, string> {
  const out = new Map<string, string>()
  const free = new Map(older.nodes.map((n) => [n.id, n]))
  const pending: NodeEl[] = []
  for (const n of newer.nodes) {
    if (free.has(n.id)) {
      out.set(n.id, n.id)
      free.delete(n.id)
    } else pending.push(n)
  }
  const near = (a: NodeEl, b: NodeEl) => Math.hypot(a.x - b.x, a.y - b.y)
  const rest: NodeEl[] = []
  for (const n of pending) {
    const sig = nodeSig(n)
    let best: NodeEl | undefined
    for (const o of free.values()) if (nodeSig(o) === sig && (!best || near(o, n) < near(best, n))) best = o
    if (best) {
      out.set(n.id, best.id)
      free.delete(best.id)
    } else rest.push(n)
  }
  for (const n of rest) {
    for (const o of free.values()) {
      if (o.kind === n.kind && near(o, n) < 4) {
        out.set(n.id, o.id)
        free.delete(o.id)
        break
      }
    }
  }
  return out
}

export function diffDocs(older: Doc, newer: Doc): DocDiff {
  const match = matchNodes(older, newer)
  const oldNodes = new Map(older.nodes.map((n) => [n.id, n]))
  const changed = new Set<string>()
  for (const n of newer.nodes) {
    const o = oldNodes.get(match.get(n.id) ?? '')
    if (!o || nodeSig(o) !== nodeSig(n)) changed.add(n.id)
  }
  const matchedOld = new Set(match.values())

  const phrase = (doc: Map<string, NodeEl>, nodeId?: string, textId?: string) => {
    const n = nodeId && textId ? doc.get(nodeId) : undefined
    return n ? (linkGroups(paragraphsOf(n)).find((g) => g.id === textId)?.phrase ?? null) : null
  }
  const newNodes = new Map(newer.nodes.map((n) => [n.id, n]))
  // A connector is the same when it joins the same shapes (and phrases) with the same style and label.
  const edgeSig = (e: EdgeEl, nodes: Map<string, NodeEl>, mapId: (id?: string) => string | null) => {
    const end = (p: EdgeEl['from']) => (p.nodeId ? [mapId(p.nodeId), phrase(nodes, p.nodeId, p.textId)] : [Math.round(p.x), Math.round(p.y)])
    return JSON.stringify([end(e.from), end(e.to), e.route, e.color, e.width, e.dashed, e.startHead, e.endHead, e.label])
  }
  const oldSigs = new Map<string, EdgeEl[]>()
  for (const e of older.edges) {
    const sig = edgeSig(e, oldNodes, (id) => id ?? null)
    oldSigs.set(sig, [...(oldSigs.get(sig) ?? []), e])
  }
  const usedOld = new Set<string>()
  for (const e of newer.edges) {
    const sig = edgeSig(e, newNodes, (id) => (id ? (match.get(id) ?? `new:${id}`) : null))
    const hit = oldSigs.get(sig)?.find((o) => !usedOld.has(o.id))
    if (hit) usedOld.add(hit.id)
    else changed.add(e.id)
  }
  const removed: Doc = {
    nodes: older.nodes.filter((n) => !matchedOld.has(n.id)),
    edges: older.edges.filter((e) => !usedOld.has(e.id)),
  }
  return { changed, removed }
}

/** The changes plus the existing shapes that new or edited connectors join. */
export function withAffected(doc: Doc, changed: Set<string>): Set<string> {
  const all = new Set(changed)
  for (const e of doc.edges) if (changed.has(e.id)) for (const end of [e.from, e.to]) if (end.nodeId) all.add(end.nodeId)
  return all
}

/** The newer board with its ids changed to the older board's wherever a shape
 *  or connector stands for the same thing, so the two can be stored as a
 *  small delta even when the newer one was reopened from Markdown (fresh ids). */
export function alignIds(older: Doc, newer: Doc): Doc {
  const match = matchNodes(older, newer)
  const taken = new Set(match.values())
  const rename = new Map<string, string>()
  for (const n of newer.nodes) {
    const to = match.get(n.id)
    // Keep an unmatched shape's own id unless it collides with an older one.
    rename.set(n.id, to ?? (taken.has(n.id) ? `${n.id}~` : n.id))
  }
  const end = (p: EdgeEl['from']) => (p.nodeId ? { ...p, nodeId: rename.get(p.nodeId) ?? p.nodeId } : p)
  const nodes = newer.nodes.map((n) => ({ ...n, id: rename.get(n.id)! }))
  const body = (e: EdgeEl) => JSON.stringify({ ...e, id: '' })
  const free = new Map<string, string[]>()
  for (const e of older.edges) free.set(body(e), [...(free.get(body(e)) ?? []), e.id])
  const moved = newer.edges.map((e) => ({ ...e, from: end(e.from), to: end(e.to) }))
  const ids = moved.map((e) => free.get(body(e))?.shift())
  const used = new Set(ids.filter(Boolean))
  const edges = moved.map((e, i) => ({ ...e, id: ids[i] ?? (used.has(e.id) ? `${e.id}~` : e.id) }))
  return { nodes, edges }
}
