import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { emit, Events } from '../events';

const CLOSE_DELAY_MS = 300;
const VIEWPORT_MARGIN = 16;
const ANCHOR_GAP = 8;

export function WorktreeScanWarning({ projectId }: { projectId: string }) {
  const { worktreeScans } = useStore();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const host = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const popoverId = useId();
  const scan = worktreeScans[projectId];
  const cancelClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  };
  const show = () => { cancelClose(); setOpen(true); };
  const close = () => { cancelClose(); setOpen(false); };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!scan?.error) close();
  }, [scan?.error]);
  useLayoutEffect(() => {
    if (!open || !scan?.error) return;
    const place = () => {
      if (!trigger.current || !popover.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const panel = popover.current.getBoundingClientRect();
      const right = anchor.right + ANCHOR_GAP;
      const left = right + panel.width <= window.innerWidth - VIEWPORT_MARGIN
        ? right : anchor.left - panel.width - ANCHOR_GAP;
      setPosition({
        left: Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - panel.width - VIEWPORT_MARGIN)),
        top: Math.max(VIEWPORT_MARGIN, Math.min(anchor.top, window.innerHeight - panel.height - VIEWPORT_MARGIN)),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, scan?.error]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !host.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      // Return keyboard users to the warning before removing its focused content.
      if (popover.current?.contains(document.activeElement)) trigger.current?.focus();
      close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  if (!scan?.error) return null;
  return <span ref={host} className="worktree-scan-warning"
    onMouseEnter={show} onMouseLeave={scheduleClose} onFocus={show}
    onBlur={event => {
      // Disabling Rescan blurs it; keep details open while the pointer is inside.
      if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) scheduleClose();
    }}
    onClick={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    <button ref={trigger} aria-label="Worktree scan failed" aria-expanded={open} aria-controls={open ? popoverId : undefined} onClick={show}>⚠</button>
    {open && <span ref={popover} id={popoverId} className="worktree-scan-popover" role="region" aria-label="Worktree scan error" style={position}
      onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
      <span>{scan.error}</span>
      <button disabled={scan.running} onClick={() => emit(Events.WORKTREE_RESCAN, projectId)}>{scan.running ? 'Scanning…' : 'Rescan project worktrees'}</button>
      <button onClick={close}>Close</button>
    </span>}
  </span>;
}
