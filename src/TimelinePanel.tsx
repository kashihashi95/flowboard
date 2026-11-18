import { useMemo, useRef, useState } from 'react'
import { diffDocs, withAffected } from './diff'
import { bundleTrunks, docBounds, edgeGeometry, unionRects } from './geometry'
import { EdgeView, ShapeView, SvgDefs } from './render'
import { drawOrder } from './store'
import type { TrackPoint } from './tracks'
import type { Doc } from './types'

const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** The board's history: when tracking started and every track point. Pick
 *  one point to see what changed since then, or two to compare them. */
export function TimelinePanel({
  points,
  now,
  onClose,
  onTrack,
  onDelete,
  onRename,
  onExport,
}: {
  points: TrackPoint[]
  now: Doc
  onClose: () => void
  onTrack: () => void
  onDelete: (id: string) => void
  onRename: (id: string, label: string) => void
  /** Export what's new or edited in `newer` compared to `older`. */
  onExport: (older: Doc, newer: Doc, label: string) => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  // Picked by default: the latest point, so the window opens on "what changed since".
  const [picked, setPicked] = useState<string[]>(() => (points.length ? [points[points.length - 1].id] : []))
  const pick = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)))

  const chosen = points.filter((p) => picked.includes(p.id))
  const older = chosen[0]
  const newer = chosen[1]
  const compare = older ? { from: older, to: newer ? { doc: newer.doc, label: newer.label } : { doc: now, label: 'now' } } : null

  return (
    <div className="chrome backdrop" onPointerDown={onClose}>
      <div className={`dialog timeline${compare ? ' expanded' : ''}`} role="dialog" aria-label="Timeline" onPointerDown={(e) => e.stopPropagation()}>
        <div className="help-head">
          <strong>Timeline</strong>
          <div className="timeline-actions">
            <button className="primary" onClick={onTrack}>
              Start track
            </button>
            <button className="textbtn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <p className="muted">Pick one point to see what changed since then, or two to compare them.</p>
        <ol className="track-line">
          {points.map((p, i) => (
            <li key={p.id} className={picked.includes(p.id) ? 'on' : ''}>
              {renaming === p.id ? (
                <div className="track-dot">
                  <span className="dot" />
                  <input
                    className="track-rename"
                    aria-label="Track point name"
                    defaultValue={p.label}
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') e.currentTarget.blur()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    onBlur={(e) => {
                      const v = e.target.value.trim()
                      if (renaming === p.id && v && v !== p.label) onRename(p.id, v)
                      setRenaming(null)
                    }}
                  />
                  <span className="track-time">{when(p.at)}</span>
                </div>
              ) : (
                <button
                  className="track-dot"
                  aria-pressed={picked.includes(p.id)}
                  title="Click to pick; double-click the name to rename"
                  onClick={() => pick(p.id)}
                  onDoubleClick={(e) => {
                    e.preventDefault()
                    setRenaming(p.id)
                  }}
                >
                  <span className="dot" />
                  <span className="track-label">{p.label}</span>
                  <span className="track-time">{when(p.at)}</span>
                </button>
              )}
              {renaming !== p.id && (
                <button className="track-edit" aria-label={`Rename ${p.label}`} title="Rename" onClick={() => setRenaming(p.id)}>
                  ✎
                </button>
              )}
              {i > 0 && renaming !== p.id && (
                <button className="track-del" aria-label={`Delete ${p.label}`} title="Delete this track point" onClick={() => onDelete(p.id)}>
                  ×
                </button>
              )}
            </li>
          ))}
          <li className="now">
            <span className="track-dot">
              <span className="dot" />
              <span className="track-label">Now</span>
              <span className="track-time">{picked.length === 1 ? 'compared' : ''}</span>
            </span>
          </li>
        </ol>
        {compare && (
          <DiffChart
            older={compare.from.doc}
            newer={compare.to.doc}
            title={`${compare.from.label} → ${compare.to.label}`}
            onExport={() => onExport(compare.from.doc, compare.to.doc, `${compare.from.label} → ${compare.to.label}`)}
          />
        )}
      </div>
    </div>
  )
}

/** The newer board with what changed since the older one marked: new or
 *  edited in green, shapes they connect in amber, removed in red. */
function DiffChart({ older, newer, title, onExport }: { older: Doc; newer: Doc; title: string; onExport: () => void }) {
  const data = useMemo(() => {
    const { changed, removed } = diffDocs(older, newer)
    const all = withAffected(newer, changed)
    const nodes = new Map(newer.nodes.map((n) => [n.id, n]))
    const oldNodes = new Map(older.nodes.map((n) => [n.id, n]))
    const trunks = bundleTrunks(newer.edges, nodes)
    const box = unionRects([docBounds(newer), docBounds(removed)].filter((r): r is NonNullable<typeof r> => !!r))
    return { changed, removed, all, nodes, oldNodes, trunks, box }
  }, [older, newer])
  const { changed, removed, all, nodes, oldNodes, trunks, box } = data

  // Pan and zoom by changing the viewBox.
  const fit = box ? { x: box.x - 40, y: box.y - 40, w: box.w + 80, h: box.h + 80 } : { x: 0, y: 0, w: 400, h: 300 }
  const [vb, setVb] = useState(fit)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; vb: typeof vb } | null>(null)
  const [lastFit, setLastFit] = useState(fit)
  if (fit.x !== lastFit.x || fit.y !== lastFit.y || fit.w !== lastFit.w || fit.h !== lastFit.h) {
    setLastFit(fit)
    setVb(fit)
  }
  const scale = () => {
    const r = svgRef.current!.getBoundingClientRect()
    return Math.max(vb.w / r.width, vb.h / r.height)
  }
  const px = (v: number) => v * (svgRef.current ? scale() : vb.w / 800)

  const edited = [...changed].filter((id) => nodes.has(id) || newer.edges.some((e) => e.id === id)).length
  const affected = all.size - changed.size
  const gone = removed.nodes.length + removed.edges.length

  return (
    <div className="diffchart">
      <div className="diffchart-head">
        <strong>{title}</strong>
        <span className="difflegend">
          <i className="sw changed" /> {edited} new or edited
          <i className="sw ctx" /> {affected} affected
          <i className="sw gone" /> {gone} removed
        </span>
        <button className="textbtn" onClick={() => setVb(fit)}>
          Fit
        </button>
        <button className="primary" disabled={!edited} title="Export what's new or edited here, plus the shapes new connectors join" onClick={onExport}>
          Export diff…
        </button>
      </div>
      {!edited && !gone ? (
        <p className="muted">No changes between these two points.</p>
      ) : (
        <svg
          ref={svgRef}
          className="diffchart-canvas"
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          onWheel={(e) => {
            const r = svgRef.current!.getBoundingClientRect()
            const k = Math.exp(e.deltaY * 0.0015)
            const s = scale()
            // Zoom about the pointer (the content is centered in the box).
            const cx = vb.x + vb.w / 2 + (e.clientX - r.left - r.width / 2) * s
            const cy = vb.y + vb.h / 2 + (e.clientY - r.top - r.height / 2) * s
            setVb({ x: cx - (cx - vb.x) * k, y: cy - (cy - vb.y) * k, w: vb.w * k, h: vb.h * k })
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, y: e.clientY, vb }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            const s = scale()
            setVb({ ...d.vb, x: d.vb.x - (e.clientX - d.x) * s, y: d.vb.y - (e.clientY - d.y) * s })
          }}
          onPointerUp={() => (drag.current = null)}
        >
          <SvgDefs />
          {/* What was taken out, faded under the rest. */}
          <g className="diff-gone">
            {removed.nodes.map((n) => (
              <ShapeView key={n.id} n={n} />
            ))}
            {removed.edges.map((e) => (
              <EdgeView key={e.id} e={e} nodes={oldNodes} />
            ))}
          </g>
          {drawOrder(newer.nodes).map((n) => (
            <g key={n.id} opacity={all.has(n.id) ? 1 : 0.25}>
              <ShapeView n={n} />
            </g>
          ))}
          {newer.edges.map((e) => (
            <g key={e.id} opacity={all.has(e.id) ? 1 : 0.25}>
              <EdgeView e={e} nodes={nodes} trunk={trunks.get(e.id)} />
            </g>
          ))}
          {newer.edges
            .filter((e) => changed.has(e.id))
            .map((e) => (
              <path key={`m${e.id}`} className="diff-edge" d={edgeGeometry(e, nodes, trunks.get(e.id) ?? null).d} strokeWidth={Math.max(px(8), e.width + 6)} />
            ))}
          {[...all].map((id) => {
            const n = nodes.get(id)
            if (!n) return null
            const pad = px(6)
            const isNew = changed.has(id)
            return (
              <rect
                key={`m${id}`}
                className={isNew ? 'diff-node' : 'diff-node ctx'}
                x={n.x - pad}
                y={n.y - pad}
                width={n.w + pad * 2}
                height={n.h + pad * 2}
                rx={px(8)}
                strokeWidth={px(3)}
                strokeDasharray={isNew ? undefined : `${px(6)} ${px(4)}`}
              />
            )
          })}
          {removed.nodes.map((n) => {
            const pad = px(6)
            return (
              <rect
                key={`g${n.id}`}
                className="diff-node gone"
                x={n.x - pad}
                y={n.y - pad}
                width={n.w + pad * 2}
                height={n.h + pad * 2}
                rx={px(8)}
                strokeWidth={px(3)}
                strokeDasharray={`${px(6)} ${px(4)}`}
              />
            )
          })}
          {removed.edges.map((e) => (
            <path key={`g${e.id}`} className="diff-edge gone" d={edgeGeometry(e, oldNodes, null).d} strokeWidth={Math.max(px(8), e.width + 6)} />
          ))}
        </svg>
      )}
    </div>
  )
}
