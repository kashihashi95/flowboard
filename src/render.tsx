import { memo } from 'react'
import { edgeGeometry, headShape, lineHeight, measure, parallelogramSkew, SECTION_TITLE_SIZE, sectionTitleRect } from './geometry'
import { linkRects, nodeLines, textOrigin } from './richtext'
import { FONT, INK, PALETTE, type ArrowHead, type ColorKey, type EdgeEl, type NodeEl, type Pt } from './types'

export const strokeOf = (k: ColorKey) => (k === 'ink' ? INK : PALETTE[k].stroke)

/** Outline color, or undefined for none. Stickies, text and images have no
 *  outline unless one is chosen. */
export function outlineOf(n: NodeEl): string | undefined {
  if (n.outline === 'none') return undefined
  if (n.outline) return strokeOf(n.outline)
  if (n.kind === 'section') return n.color === 'ink' ? 'var(--section-line)' : PALETTE[n.color].stroke
  return n.kind === 'sticky' || n.kind === 'text' || n.kind === 'image' ? undefined : PALETTE[n.color].stroke
}

function ShapeOutline({ n }: { n: NodeEl }) {
  const pal = PALETTE[n.color]
  const sw = n.outlineWidth ?? 2
  const stroke = outlineOf(n) ?? 'none'
  const common = {
    fill: pal.fill,
    stroke,
    strokeWidth: sw,
    strokeLinejoin: 'round' as const,
    strokeDasharray: n.outlineDashed ? `${sw * 4} ${sw * 3}` : undefined,
  }
  const strokeOnly = { fill: 'none', stroke, strokeWidth: sw, strokeDasharray: common.strokeDasharray }
  const { x, y, w, h } = n
  switch (n.kind) {
    case 'rect':
      return <rect x={x} y={y} width={w} height={h} rx={6} {...common} />
    case 'rounded':
      return <rect x={x} y={y} width={w} height={h} rx={Math.min(w, h) / 2} {...common} />
    case 'ellipse':
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />
    case 'diamond':
      return <polygon points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} {...common} />
    case 'parallelogram': {
      const sk = parallelogramSkew(n)
      return <polygon points={`${x + sk},${y} ${x + w},${y} ${x + w - sk},${y + h} ${x},${y + h}`} {...common} />
    }
    case 'hexagon': {
      const k = Math.min(w * 0.2, h * 0.5)
      return (
        <polygon
          points={`${x + k},${y} ${x + w - k},${y} ${x + w},${y + h / 2} ${x + w - k},${y + h} ${x + k},${y + h} ${x},${y + h / 2}`}
          {...common}
        />
      )
    }
    case 'cylinder': {
      const ry = Math.min(h * 0.15, 16)
      const rx = w / 2
      return (
        <g {...common}>
          <path
            d={`M${x},${y + ry} A${rx},${ry} 0 0 1 ${x + w},${y + ry} L${x + w},${y + h - ry} A${rx},${ry} 0 0 1 ${x},${y + h - ry} Z`}
          />
          <path d={`M${x},${y + ry} A${rx},${ry} 0 0 0 ${x + w},${y + ry}`} fill="none" />
        </g>
      )
    }
    case 'sticky':
      return (
        <>
          <rect x={x} y={y} width={w} height={h} rx={2} fill={pal.sticky} filter="url(#fb-sticky-shadow)" />
          {stroke !== 'none' && <rect x={x} y={y} width={w} height={h} rx={2} {...strokeOnly} />}
        </>
      )
    case 'text':
      return <rect x={x} y={y} width={w} height={h} fill="transparent" stroke={stroke} strokeWidth={sw} strokeDasharray={common.strokeDasharray} />
    case 'section':
      return (
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={10}
          fill={n.color === 'ink' ? 'var(--section)' : pal.fill}
          fillOpacity={n.color === 'ink' || n.color === 'black' ? 1 : 0.55}
          stroke={stroke}
          strokeWidth={n.outline ? sw : 1.5}
          strokeDasharray={common.strokeDasharray}
        />
      )
    case 'image':
      return (
        <>
          {n.src ? (
            <image href={n.src} x={x} y={y} width={w} height={h} preserveAspectRatio="none" />
          ) : (
            <rect x={x} y={y} width={w} height={h} fill={pal.fill} />
          )}
          {stroke !== 'none' && <rect x={x} y={y} width={w} height={h} {...strokeOnly} />}
        </>
      )
  }
}

export function textColorOf(n: NodeEl): string {
  const pal = PALETTE[n.color]
  if (n.kind === 'text') return pal.stroke
  if (n.kind === 'sticky') return n.color === 'black' ? '#ffffff' : '#1e1e1e'
  return pal.text
}

export const ShapeView = memo(function ShapeView({ n, hideText }: { n: NodeEl; hideText?: boolean }) {
  const hasText = !hideText && n.kind !== 'image' && n.kind !== 'section' && (n.text || n.rich)
  return (
    <g data-node={n.id}>
      <ShapeOutline n={n} />
      {hasText && <NodeText n={n} />}
      {n.kind === 'section' && !hideText && <SectionTitle n={n} />}
    </g>
  )
})

function NodeText({ n }: { n: NodeEl }) {
  const size = n.fontSize
  const lh = lineHeight(size)
  const lines = nodeLines(n)
  const color = textColorOf(n)
  const { left, top } = textOrigin(n, lines.length)
  const marks = [...linkRects(n).values()].flat()
  const decorations: { x1: number; x2: number; y: number; color: string }[] = []
  return (
    <g>
      {marks.map((r, i) => (
        <rect key={`l${i}`} x={r.x - 2} y={r.y + lh * 0.08} width={r.w + 4} height={lh * 0.84} rx={Math.min(4, lh / 5)} fill="var(--link-mark)" />
      ))}
      <text fontFamily={FONT} fontSize={size} fill={color} dominantBaseline="central" style={{ whiteSpace: 'pre' }}>
        {lines.map((line, i) => {
          const y = top + i * lh
          return [
            line.marker && (
              <tspan key={`m${i}`} x={left + line.marker.x} y={y}>
                {line.marker.text}
              </tspan>
            ),
            ...line.segs.map((seg, j) => {
              const c = seg.run.color ?? color
              if (seg.run.underline) decorations.push({ x1: left + seg.x, x2: left + seg.x + seg.w, y: y + size * 0.42, color: c })
              if (seg.run.strike) decorations.push({ x1: left + seg.x, x2: left + seg.x + seg.w, y: y + size * 0.04, color: c })
              return (
                <tspan
                  key={`${i}-${j}`}
                  x={left + seg.x}
                  y={y}
                  fontWeight={seg.run.bold ? 700 : undefined}
                  fontStyle={seg.run.italic ? 'italic' : undefined}
                  fill={seg.run.color}
                >
                  {seg.text}
                </tspan>
              )
            }),
          ]
        })}
      </text>
      {decorations.map((d, i) => (
        <line key={i} x1={d.x1} x2={d.x2} y1={d.y} y2={d.y} stroke={d.color} strokeWidth={Math.max(1, size / 14)} />
      ))}
    </g>
  )
}

function SectionTitle({ n }: { n: NodeEl }) {
  const r = sectionTitleRect(n)
  const dark = n.color === 'black'
  return (
    <g>
      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={7} fill={n.color === 'ink' ? 'var(--section-tab)' : dark ? '#2b2b2b' : PALETTE[n.color].stroke} />
      <text
        x={r.x + 10}
        y={r.y + r.h / 2}
        fontFamily={FONT}
        fontSize={SECTION_TITLE_SIZE}
        fontWeight={600}
        fill={n.color === 'ink' ? 'var(--section-tab-text)' : '#ffffff'}
        dominantBaseline="central"
      >
        {fitTitle(n.text || 'Section', r.w - 20)}
      </text>
    </g>
  )
}

/** Shorten a section name with an ellipsis so it fits its tab. */
function fitTitle(text: string, maxW: number) {
  if (measure(text, SECTION_TITLE_SIZE, 600) <= maxW) return text
  let t = text
  while (t.length > 1 && measure(`${t}…`, SECTION_TITLE_SIZE, 600) > maxW) t = t.slice(0, -1)
  return `${t}…`
}

function Head({ head, tip, dir, width, color }: { head: ArrowHead; tip: Pt; dir: Pt; width: number; color: string }) {
  const shape = headShape(head, tip, dir, width)
  if (!shape) return null
  return shape.filled ? (
    <path d={shape.d} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />
  ) : (
    <path d={shape.d} fill="none" stroke={color} strokeWidth={width} strokeLinejoin="round" strokeLinecap="round" />
  )
}

/** Small preview of an arrowhead for menus. */
export function HeadIcon({ head, flip }: { head: ArrowHead; flip?: boolean }) {
  const tip = flip ? { x: 4, y: 8 } : { x: 32, y: 8 }
  const dir = flip ? { x: -1, y: 0 } : { x: 1, y: 0 }
  const inset = head === 'none' ? 0 : head === 'triangle' ? 7 : head === 'triangle-open' ? 9 : head === 'diamond' ? 12 : head === 'circle' || head === 'circle-open' ? 7 : 0
  const x1 = flip ? 4 + inset : 4
  const x2 = flip ? 32 : 32 - inset
  return (
    <svg width="36" height="16" viewBox="0 0 36 16" aria-hidden="true">
      <line x1={x1} x2={x2} y1={8} y2={8} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      <Head head={head} tip={tip} dir={dir} width={1.6} color="currentColor" />
    </svg>
  )
}

export const LABEL_FONT = 14

export const EdgeView = memo(function EdgeView({
  e,
  nodes,
  hideLabel,
  color: shownColor,
  trunk,
}: {
  e: EdgeEl
  nodes: Map<string, NodeEl>
  hideLabel?: boolean
  /** Overrides the connector's own color (crossing connectors get their own). */
  color?: string
  /** Where it shares a trunk with its siblings (see bundleTrunks); none when left out. */
  trunk?: number
}) {
  const g = edgeGeometry(e, nodes, trunk ?? null)
  const color = shownColor ?? strokeOf(e.color)
  const lh = lineHeight(LABEL_FONT)
  const labelLines = e.label && !hideLabel ? e.label.split('\n') : []
  const lw = Math.max(...labelLines.map((l) => measure(l, LABEL_FONT)), 0) + 14
  const lhTotal = labelLines.length * lh + 6
  return (
    <g data-edge={e.id}>
      <path d={g.d} fill="none" stroke="transparent" strokeWidth={16} data-hit="" />
      <path
        d={g.d}
        fill="none"
        stroke={color}
        strokeWidth={e.width}
        strokeDasharray={e.dashed ? `${e.width * 4} ${e.width * 3}` : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Head head={e.startHead} tip={g.start} dir={g.startDir} width={e.width} color={color} />
      <Head head={e.endHead} tip={g.end} dir={g.endDir} width={e.width} color={color} />
      {labelLines.length > 0 && (
        <g>
          <rect
            x={g.mid.x - lw / 2}
            y={g.mid.y - lhTotal / 2}
            width={lw}
            height={lhTotal}
            rx={4}
            fill="var(--canvas)"
          />
          <text fontFamily={FONT} fontSize={LABEL_FONT} fill={color} textAnchor="middle" dominantBaseline="central">
            {labelLines.map((l, i) => (
              <tspan key={i} x={g.mid.x} y={g.mid.y - ((labelLines.length - 1) * lh) / 2 + i * lh}>
                {l}
              </tspan>
            ))}
          </text>
        </g>
      )}
    </g>
  )
})

export function SvgDefs() {
  return (
    <defs>
      <filter id="fb-sticky-shadow" x="-10%" y="-10%" width="130%" height="140%">
        <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#000" floodOpacity="0.14" />
      </filter>
    </defs>
  )
}
