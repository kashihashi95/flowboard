export type ShapeKind =
  | 'rect'
  | 'rounded'
  | 'diamond'
  | 'ellipse'
  | 'parallelogram'
  | 'cylinder'
  | 'hexagon'
  | 'sticky'
  | 'text'
  | 'image'
  | 'section'

export type Side = 'top' | 'right' | 'bottom' | 'left'

export type ColorKey = keyof typeof PALETTE

export interface Pt {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** One styled piece of text inside a paragraph. */
export interface TextRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** CSS color; undefined uses the shape's text color. */
  color?: string
  /** Marks the run as a link point connectors can attach to; runs sharing an id form one phrase. */
  link?: string
}

export type TextAlign = 'left' | 'center' | 'right'

export interface Paragraph {
  runs: TextRun[]
  align?: TextAlign
  list?: 'bullet' | 'number'
}

export interface NodeEl extends Rect {
  id: string
  kind: ShapeKind
  /** Plain text, kept in sync with `rich` (used for search and older files). */
  text: string
  /** Formatted text. When absent, `text` is shown with default formatting. */
  rich?: Paragraph[]
  color: ColorKey
  fontSize: number
  /** Outline color; undefined follows the fill color, 'none' hides it. */
  outline?: ColorKey | 'none'
  outlineWidth?: number
  outlineDashed?: boolean
  /** Sized by hand: keep the width and only grow taller to fit the text. */
  fixedSize?: boolean
  /** Image data (a data: URL) for image nodes. */
  src?: string
}

/** One end of a connector. When attached, `nodeId` is set and `side` pins the
 *  anchor (undefined = pick the best side automatically). x/y is the free
 *  position used when the end is not attached. */
export interface EdgeEnd {
  nodeId?: string
  side?: Side
  /** Attach to a highlighted phrase inside the shape (a TextRun `link` id) instead of the shape's outline. */
  textId?: string
  /** With a pinned side: where along it, 0–1 from its top / left end (undefined = the middle). */
  at?: number
  x: number
  y: number
}

export type Route = 'elbow' | 'straight' | 'curved'

export type ArrowHead = 'none' | 'triangle' | 'arrow' | 'triangle-open' | 'circle' | 'circle-open' | 'diamond' | 'bar'

export const ARROW_HEADS: { value: ArrowHead; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'arrow', label: 'Line arrow' },
  { value: 'triangle-open', label: 'Hollow triangle' },
  { value: 'circle', label: 'Circle' },
  { value: 'circle-open', label: 'Hollow circle' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'bar', label: 'Bar' },
]

export interface EdgeEl {
  id: string
  from: EdgeEnd
  to: EdgeEnd
  route: Route
  color: ColorKey
  width: number
  dashed: boolean
  startHead: ArrowHead
  endHead: ArrowHead
  label: string
  /** Where along the line the label sits, 0–1 by length (undefined = the middle). */
  labelAt?: number
  /** A hand-adjusted elbow route: the corner points between the two ends. */
  points?: Pt[]
}

export interface Doc {
  nodes: NodeEl[]
  edges: EdgeEl[]
}

export interface View {
  x: number
  y: number
  zoom: number
}

/** `ink` resolves to a CSS variable so default lines and text stay readable in
 *  dark mode; exports substitute a fixed color. */
export const INK = 'var(--ink)'
export const SHAPE = 'var(--shape)'

export const PALETTE = {
  ink: { fill: SHAPE, stroke: INK, sticky: '#ffffff', text: INK, label: 'Default' },
  gray: { fill: '#ebebeb', stroke: '#757575', sticky: '#e3e3e3', text: '#1e1e1e', label: 'Gray' },
  red: { fill: '#ffe0dc', stroke: '#e03e2d', sticky: '#ffb1a6', text: '#1e1e1e', label: 'Red' },
  orange: { fill: '#ffe8cc', stroke: '#e8590c', sticky: '#ffc78a', text: '#1e1e1e', label: 'Orange' },
  yellow: { fill: '#fff4c2', stroke: '#d4a300', sticky: '#ffe270', text: '#1e1e1e', label: 'Yellow' },
  green: { fill: '#d8f5dc', stroke: '#2f9e44', sticky: '#aee8a8', text: '#1e1e1e', label: 'Green' },
  teal: { fill: '#c9f4ea', stroke: '#0c8599', sticky: '#93e2d6', text: '#1e1e1e', label: 'Teal' },
  blue: { fill: '#d6ebff', stroke: '#1c7ed6', sticky: '#a9d6ff', text: '#1e1e1e', label: 'Blue' },
  violet: { fill: '#e8e0ff', stroke: '#7048e8', sticky: '#cdbcff', text: '#1e1e1e', label: 'Violet' },
  pink: { fill: '#ffe0ec', stroke: '#d6336c', sticky: '#ffb5d2', text: '#1e1e1e', label: 'Pink' },
  black: { fill: '#2b2b2b', stroke: '#111111', sticky: '#3a3a3a', text: '#ffffff', label: 'Black' },
} as const

/** Text colors offered in the rich text toolbar. */
export const TEXT_COLORS = [
  { value: '', label: 'Default' },
  { value: '#757575', label: 'Gray' },
  { value: '#e03e2d', label: 'Red' },
  { value: '#e8590c', label: 'Orange' },
  { value: '#b38600', label: 'Mustard' },
  { value: '#2f9e44', label: 'Green' },
  { value: '#0c8599', label: 'Teal' },
  { value: '#1c7ed6', label: 'Blue' },
  { value: '#7048e8', label: 'Violet' },
  { value: '#d6336c', label: 'Pink' },
  { value: '#ffffff', label: 'White' },
]

export const FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: 'Process',
  rounded: 'Terminal',
  diamond: 'Decision',
  ellipse: 'Ellipse',
  parallelogram: 'Input / Output',
  cylinder: 'Database',
  hexagon: 'Preparation',
  sticky: 'Sticky note',
  text: 'Text',
  image: 'Image',
  section: 'Section',
}

export const FLOW_SHAPES: ShapeKind[] = [
  'rect',
  'rounded',
  'diamond',
  'ellipse',
  'parallelogram',
  'cylinder',
  'hexagon',
]
