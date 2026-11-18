import type { ReactNode } from 'react'
import type { ShapeKind } from './types'

function Svg({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export const Icons = {
  select: () => (
    <Svg>
      <path d="M5 3.5 18.5 10l-6 1.8L10 18z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  hand: () => (
    <Svg>
      <path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5a1.5 1.5 0 0 1 3 0V11m0-5a1.5 1.5 0 0 1 3 0v6.5c0 4-2.5 7.5-6.5 7.5-2.6 0-4.1-1.3-5.4-3.4L3.7 13a1.5 1.5 0 0 1 2.5-1.7L8 13.5" />
    </Svg>
  ),
  sticky: () => (
    <Svg>
      <path d="M4 4h16v10l-6 6H4z" />
      <path d="M14 20v-6h6" />
    </Svg>
  ),
  text: () => (
    <Svg>
      <path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6" />
    </Svg>
  ),
  connector: () => (
    <Svg>
      <path d="M5 19 C 5 10, 19 14, 19 5" />
      <path d="M14.5 5.5 19 5l.5 4.5" />
    </Svg>
  ),
  undo: () => (
    <Svg>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Svg>
  ),
  redo: () => (
    <Svg>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </Svg>
  ),
  menu: () => (
    <Svg>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  ),
  trash: () => (
    <Svg size={18}>
      <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </Svg>
  ),
  arrowStart: () => (
    <Svg size={18}>
      <path d="M20 12H5M9 7l-5 5 5 5" />
    </Svg>
  ),
  arrowEnd: () => (
    <Svg size={18}>
      <path d="M4 12h15M15 7l5 5-5 5" />
    </Svg>
  ),
  elbow: () => (
    <Svg size={18}>
      <path d="M4 18h7V6h9" />
    </Svg>
  ),
  straight: () => (
    <Svg size={18}>
      <path d="M4 19 20 5" />
    </Svg>
  ),
  curved: () => (
    <Svg size={18}>
      <path d="M4 19C4 9 20 15 20 5" />
    </Svg>
  ),
  dashed: () => (
    <Svg size={18}>
      <path d="M3 12h3M10.5 12h3M18 12h3" />
    </Svg>
  ),
  help: () => (
    <Svg size={18}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01" />
    </Svg>
  ),
  section: () => (
    <Svg>
      <path d="M4 8.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8.5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1z" />
      <path d="M4 5.5V4.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" />
    </Svg>
  ),
  image: () => (
    <Svg>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="m4 18 5.5-5 4 3.5 2.5-2 4.5 4" />
    </Svg>
  ),
  physics: () => (
    <Svg size={18}>
      <circle cx="6" cy="7" r="2.2" />
      <circle cx="18" cy="6" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
      <path d="M8 7.6 15.8 6.4M7.2 9 10.9 16M16.9 8 13.1 16" />
    </Svg>
  ),
  tidy: () => (
    <Svg size={18}>
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <rect x="3" y="17" width="6" height="4" rx="1" />
      <rect x="15" y="17" width="6" height="4" rx="1" />
      <path d="M12 7v5M6 17v-5h12v5" />
    </Svg>
  ),
  jump: () => (
    <Svg size={18}>
      <circle cx="5" cy="17" r="2" />
      <path d="M7 15 15.5 6.5M11 6h5v5" />
      <rect x="14.5" y="14.5" width="6" height="6" rx="1" strokeDasharray="2 2" />
    </Svg>
  ),
  search: () => (
    <Svg size={18}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </Svg>
  ),
  fit: () => (
    <Svg size={18}>
      <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
    </Svg>
  ),
}

export function ShapeIcon({ kind, size = 20 }: { kind: ShapeKind; size?: number }) {
  switch (kind) {
    case 'rect':
      return (
        <Svg size={size}>
          <rect x="3.5" y="6" width="17" height="12" rx="1.5" />
        </Svg>
      )
    case 'rounded':
      return (
        <Svg size={size}>
          <rect x="3" y="7" width="18" height="10" rx="5" />
        </Svg>
      )
    case 'diamond':
      return (
        <Svg size={size}>
          <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />
        </Svg>
      )
    case 'ellipse':
      return (
        <Svg size={size}>
          <ellipse cx="12" cy="12" rx="9" ry="6.5" />
        </Svg>
      )
    case 'parallelogram':
      return (
        <Svg size={size}>
          <path d="M7 6h14l-4 12H3z" />
        </Svg>
      )
    case 'cylinder':
      return (
        <Svg size={size}>
          <ellipse cx="12" cy="6.5" rx="7" ry="2.5" />
          <path d="M5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11" />
        </Svg>
      )
    case 'hexagon':
      return (
        <Svg size={size}>
          <path d="M7 5.5h10l4 6.5-4 6.5H7L3 12z" />
        </Svg>
      )
    case 'sticky':
      return <Icons.sticky />
    case 'text':
      return <Icons.text />
  }
}
