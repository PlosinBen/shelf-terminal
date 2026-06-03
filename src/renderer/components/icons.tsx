import React from 'react';

// Original hand-authored line icons (no third-party assets / licenses).
// 24x24 viewBox, stroke = currentColor so they inherit the host element's
// text color (hover / active states just change `color`).

type IconProps = { size?: number };

function Svg({ size = 14, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// Left panel — toggles the project list sidebar.
export function PanelLeftIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </Svg>
  );
}

// Speech bubble — PM agent.
export function MessageIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20 4H4a2 2 0 0 0-2 2v15l4-4h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
    </Svg>
  );
}

// Document with text lines — Notes.
export function NoteIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="14 3 14 9 20 9" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </Svg>
  );
}

// Angle brackets — DevTools.
export function CodeIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </Svg>
  );
}
