import { Circle, GitBranch, Ruler, Settings, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';

interface GiopMapToolsMenuProps {
  isLightMode: boolean;
}

export function GiopMapToolsMenu({ isLightMode }: GiopMapToolsMenuProps) {
  const {
    mapMeasureActive,
    setMapMeasureActive,
    mapClearanceActive,
    setMapClearanceActive,
    mapTraceActive,
    setMapTraceActive,
  } = useGiopMapOverlay();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const toolsArmed = mapMeasureActive || mapClearanceActive || mapTraceActive;

  return (
    <>
      <div
        ref={rootRef}
        className={`giop-map-tools-menu ${isLightMode ? 'giop-map-tools-menu--light' : 'giop-map-tools-menu--dark'}${
          open ? ' giop-map-tools-menu--open' : ''
        }${toolsArmed ? ' giop-map-tools-menu--measure' : ''}`}
      >
        <div className="giop-map-tools-fab" role={open ? 'menu' : undefined} aria-label={open ? 'Map tools' : undefined}>
          <button
            type="button"
            className="giop-map-tools-fab__toggle"
            title={open ? 'Close map tools' : 'Map tools'}
            aria-label={open ? 'Close map tools' : 'Map tools'}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((prev) => !prev)}
          >
            <span className="giop-map-tools-fab__icon giop-map-tools-fab__icon--wrench" aria-hidden>
              <Wrench className="h-4 w-4" />
            </span>
            <span className="giop-map-tools-fab__icon giop-map-tools-fab__icon--close" aria-hidden>
              <X className="h-4 w-4" />
            </span>
          </button>

          <div className="giop-map-tools-fab__tray" aria-hidden={!open}>
            <button
              type="button"
              role="menuitem"
              className={`giop-map-tools-fab__item${mapMeasureActive && !mapClearanceActive ? ' giop-map-tools-fab__item--active' : ''}`}
              title="Measure distance — snaps to poles/transformers; left-click add, right-click remove"
              aria-label="Measure distance"
              aria-pressed={mapMeasureActive && !mapClearanceActive}
              tabIndex={open ? 0 : -1}
              onClick={() => {
                if (mapClearanceActive || mapTraceActive) {
                  setMapClearanceActive(false);
                  setMapTraceActive(false);
                  setMapMeasureActive(true);
                } else {
                  setMapMeasureActive(!mapMeasureActive);
                }
              }}
              style={{ '--giop-tools-i': 0 } as CSSProperties}
            >
              <Ruler className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              role="menuitem"
              className={`giop-map-tools-fab__item${mapClearanceActive ? ' giop-map-tools-fab__item--active' : ''}`}
              title="Clearance buffer — draw a path or point, then set radius in the HUD"
              aria-label="Clearance buffer"
              aria-pressed={mapClearanceActive}
              tabIndex={open ? 0 : -1}
              onClick={() => setMapClearanceActive(!mapClearanceActive)}
              style={{ '--giop-tools-i': 1 } as CSSProperties}
            >
              <Circle className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              role="menuitem"
              className={`giop-map-tools-fab__item${mapTraceActive ? ' giop-map-tools-fab__item--active' : ''}`}
              title="Electrical trace — click a pole or transformer to highlight downstream impact"
              aria-label="Electrical trace"
              aria-pressed={mapTraceActive}
              tabIndex={open ? 0 : -1}
              onClick={() => setMapTraceActive(!mapTraceActive)}
              style={{ '--giop-tools-i': 2 } as CSSProperties}
            >
              <GitBranch className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        className="giop-map-spotlight__filter-btn"
        title="Map settings"
        aria-label="Map settings"
      >
        <Settings className="h-4 w-4" aria-hidden />
      </button>
    </>
  );
}
