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

// Paper plane — PM agent (Telegram-driven remote control / watcher).
export function PaperPlaneIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22 11 13 2 9z" />
    </Svg>
  );
}

// Pencil — Notes (user-authored scratch; paired with the Skills "book" the
// agent reads, the pencil reads as "what I write").
export function NoteIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
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

// Closed book — Skills (a reusable capability playbook the agent reads).
export function SkillIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </Svg>
  );
}

// Closed padlock — a skill locked against agent edits.
export function LockIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Svg>
  );
}

// Open padlock — an unlocked skill (the shackle springs open on one side).
export function UnlockIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </Svg>
  );
}
