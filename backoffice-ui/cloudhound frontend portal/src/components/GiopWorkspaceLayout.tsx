import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { clampSideMapDockWidth, writeSideMapDockWidth } from '../lib/giopSideMapDock';

interface GiopWorkspaceLayoutProps {
  children: ReactNode;
  sidePanel: ReactNode | null;
  sideOpen: boolean;
  /**
   * When true, the side panel is rendered as a floating overlay (caller owns
   * the float shell). The main column then uses the full width.
   */
  sideFloating?: boolean;
  /** Docked rail width in px (resizable via the left edge handle). */
  sideWidth?: number;
  onSideWidthChange?: (width: number) => void;
  isLightMode?: boolean;
}

export function GiopWorkspaceLayout({
  children,
  sidePanel,
  sideOpen,
  sideFloating = false,
  sideWidth = 440,
  onSideWidthChange,
  isLightMode = false,
}: GiopWorkspaceLayoutProps) {
  const dockedOpen = sideOpen && !sideFloating;
  const [liveWidth, setLiveWidth] = useState(() => clampSideMapDockWidth(sideWidth));
  const liveWidthRef = useRef(liveWidth);
  liveWidthRef.current = liveWidth;
  const dragRef = useRef<{ startX: number; originW: number } | null>(null);

  useEffect(() => {
    setLiveWidth(clampSideMapDockWidth(sideWidth));
  }, [sideWidth]);

  useEffect(() => {
    const onResize = () => {
      setLiveWidth((w) => clampSideMapDockWidth(w));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const commitWidth = useCallback(
    (width: number) => {
      const next = clampSideMapDockWidth(width);
      setLiveWidth(next);
      onSideWidthChange?.(next);
      writeSideMapDockWidth(next);
    },
    [onSideWidthChange],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Dragging the left edge: move left → wider panel.
      const next = clampSideMapDockWidth(drag.originW - (e.clientX - drag.startX));
      setLiveWidth(next);
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      commitWidth(liveWidthRef.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [commitWidth]);

  const onHandlePointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, originW: liveWidthRef.current };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleIdle = isLightMode
    ? 'bg-slate-200/80 hover:bg-cyan-400/70'
    : 'bg-premium-border/60 hover:bg-cyan-400/50';

  return (
    <div className="h-full min-h-0 flex">
      <div className={`flex-1 min-w-0 min-h-0 ${dockedOpen ? 'overflow-auto' : 'overflow-hidden'}`}>
        {children}
      </div>
      {dockedOpen && sidePanel ? (
        <div className="relative shrink-0 min-h-0 flex flex-col" style={{ width: liveWidth }}>
          <button
            type="button"
            aria-label="Resize map preview"
            title="Drag to resize"
            className={`absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize border-0 p-0 transition-colors ${handleIdle}`}
            onPointerDown={onHandlePointerDown}
          />
          {sidePanel}
        </div>
      ) : null}
    </div>
  );
}
