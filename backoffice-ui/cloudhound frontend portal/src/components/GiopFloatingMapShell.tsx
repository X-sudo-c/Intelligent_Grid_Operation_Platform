import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  clampSideMapFloatRect,
  writeSideMapFloatRect,
  type SideMapFloatRect,
} from '../lib/giopSideMapDock';

interface GiopFloatingMapShellProps {
  children: ReactNode;
  rect: SideMapFloatRect;
  onRectChange: (rect: SideMapFloatRect) => void;
  isLightMode: boolean;
}

type DragKind = 'move' | 'resize';

/**
 * Floating Map preview shell: drag via header (data-giop-float-drag),
 * resize from the bottom-right corner. Persists geometry via onRectChange.
 */
export function GiopFloatingMapShell({
  children,
  rect,
  onRectChange,
  isLightMode,
}: GiopFloatingMapShellProps) {
  const [liveRect, setLiveRect] = useState(rect);
  const liveRectRef = useRef(liveRect);
  liveRectRef.current = liveRect;

  useEffect(() => {
    setLiveRect(rect);
  }, [rect]);

  const dragRef = useRef<{
    kind: DragKind;
    startX: number;
    startY: number;
    origin: SideMapFloatRect;
  } | null>(null);

  const commit = useCallback(
    (next: SideMapFloatRect) => {
      const clamped = clampSideMapFloatRect(next);
      setLiveRect(clamped);
      onRectChange(clamped);
      writeSideMapFloatRect(clamped);
    },
    [onRectChange],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (drag.kind === 'move') {
        setLiveRect(
          clampSideMapFloatRect({
            ...drag.origin,
            x: drag.origin.x + dx,
            y: drag.origin.y + dy,
          }),
        );
      } else {
        setLiveRect(
          clampSideMapFloatRect({
            ...drag.origin,
            width: drag.origin.width + dx,
            height: drag.origin.height + dy,
          }),
        );
      }
    };

    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      commit(liveRectRef.current);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [commit]);

  const startDrag = useCallback((kind: DragKind, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      origin: liveRectRef.current,
    };
  }, []);

  const onHeaderPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('button, a, input, select, textarea, [data-giop-no-drag]')) return;
      if (!target.closest('[data-giop-float-drag]')) return;
      startDrag('move', e);
    },
    [startDrag],
  );

  const shell = isLightMode
    ? 'bg-white border-slate-200 shadow-xl'
    : 'bg-premium-sidebar border-premium-border/80 shadow-2xl shadow-black/40';

  return (
    <div
      className={`fixed z-[60] flex flex-col overflow-hidden rounded-lg border ${shell}`}
      style={{
        left: liveRect.x,
        top: liveRect.y,
        width: liveRect.width,
        height: liveRect.height,
      }}
      onPointerDown={onHeaderPointerDown}
    >
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      <button
        type="button"
        aria-label="Resize map preview"
        data-giop-no-drag
        className={`absolute bottom-0 right-0 h-4 w-4 cursor-se-resize ${
          isLightMode ? 'text-slate-400 hover:text-slate-600' : 'text-premium-muted hover:text-premium-text'
        }`}
        style={{
          background:
            'linear-gradient(135deg, transparent 50%, currentColor 50%)',
          opacity: 0.55,
        }}
        onPointerDown={(e) => startDrag('resize', e)}
      />
    </div>
  );
}
