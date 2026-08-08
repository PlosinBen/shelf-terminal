import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

export const RIGHT_PANEL_WIDTH = {
  min: 280,
  max: 700,
  defaults: {
    mcp: 440,
    notes: 380,
    pm: 380,
    skills: 480,
    devtools: 320,
    backup: 400,
  },
} as const;

type RightPanelProps = Omit<ComponentPropsWithoutRef<'aside'>, 'style' | 'children'> & {
  defaultWidth: number;
  header: ReactNode;
  children: ReactNode;
  'aria-label': string;
};

function clampWidth(width: number): number {
  return Math.min(RIGHT_PANEL_WIDTH.max, Math.max(RIGHT_PANEL_WIDTH.min, width));
}

export function RightPanel({
  defaultWidth,
  header,
  children,
  className,
  ...rest
}: RightPanelProps) {
  const [width, setWidth] = useState(defaultWidth);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const endDrag = useCallback(() => {
    dragCleanupRef.current?.();
  }, []);

  useEffect(() => endDrag, [endDrag]);

  const onDragStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    endDrag();

    const startX = event.clientX;
    const startWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    let cleanedUp = false;

    const onMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      setWidth(clampWidth(startWidth + delta));
    };

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', cleanup);
      window.removeEventListener('blur', cleanup);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', cleanup);
    window.addEventListener('blur', cleanup);
    dragCleanupRef.current = cleanup;
  }, [endDrag, width]);

  const rootClassName = ['right-panel', className].filter(Boolean).join(' ');

  return (
    <aside {...rest} className={rootClassName} style={{ width }}>
      <div className="right-panel-resize-handle" onMouseDown={onDragStart} />
      <div className="right-panel-header">{header}</div>
      {children}
    </aside>
  );
}
