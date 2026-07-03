import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
} from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sun } from 'lucide-react';
import { GIOP_THEME_TRANSITION_MS } from '../lib/giopThemeTransition';

interface GiopThemeToggleProps {
  isLightMode: boolean;
  onThemeChange: (isLightMode: boolean) => void;
}

const TRACK_W = 68;
const KNOB = 22;
const PAD = 3;
/** Space reserved on the knob side so the label never sits underneath it. */
const LABEL_CLEARANCE = KNOB + PAD + 4;
/** Knob slide distance: track − knob − 2×pad. */
const KNOB_TRAVEL_PX = TRACK_W - KNOB - PAD * 2;
const TOGGLE_EASE = [0.33, 0, 0.2, 1] as const;

function knobXForTheme(isLightMode: boolean): number {
  return isLightMode ? KNOB_TRAVEL_PX : 0;
}

function themeForKnobX(x: number): boolean {
  return x > KNOB_TRAVEL_PX / 2;
}

function MoonStarsIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M14.5 3.5a7.5 7.5 0 1 0 7.2 9.8A6.5 6.5 0 1 1 14.5 3.5Z" />
      <circle cx="18.5" cy="5.5" r="0.9" />
      <circle cx="20.2" cy="8.4" r="0.55" />
    </svg>
  );
}

export function GiopThemeToggle({ isLightMode, onThemeChange }: GiopThemeToggleProps) {
  const reduceMotion = useReducedMotion();
  const x = useMotionValue(knobXForTheme(isLightMode));
  const isDragging = useRef(false);
  const [visualLight, setVisualLight] = useState(isLightMode);

  const slideMs = reduceMotion ? 0.01 : GIOP_THEME_TRANSITION_MS / 1000;
  const fillWidth = useTransform(x, (value) => `${value + KNOB + PAD}px`);
  const fillOpacity = useTransform(
    x,
    [0, KNOB_TRAVEL_PX / 2, KNOB_TRAVEL_PX],
    [0.92, 0.72, 0.92],
  );

  useMotionValueEvent(x, 'change', (latest) => {
    setVisualLight(themeForKnobX(latest));
  });

  const animateKnobTo = useCallback(
    (target: number) => {
      if (reduceMotion) {
        x.set(target);
        return;
      }
      animate(x, target, { duration: slideMs, ease: TOGGLE_EASE });
    },
    [reduceMotion, slideMs, x],
  );

  useEffect(() => {
    if (isDragging.current) return;
    animateKnobTo(knobXForTheme(isLightMode));
  }, [animateKnobTo, isLightMode]);

  const commitThemeFromX = useCallback(
    (value: number) => {
      const nextLight = themeForKnobX(value);
      if (nextLight !== isLightMode) onThemeChange(nextLight);
    },
    [isLightMode, onThemeChange],
  );

  const handleTrackActivate = useCallback(
    (clientX: number, rect: DOMRect) => {
      if (isDragging.current) return;
      const nextLight = (clientX - rect.left) / rect.width > 0.5;
      onThemeChange(nextLight);
    },
    [onThemeChange],
  );

  return (
    <div
      role="switch"
      aria-checked={isLightMode}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onThemeChange(false);
        if (e.key === 'ArrowRight') onThemeChange(true);
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onThemeChange(!isLightMode);
        }
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('.giop-theme-toggle__knob')) return;
        handleTrackActivate(e.clientX, e.currentTarget.getBoundingClientRect());
      }}
      className={`giop-theme-toggle relative h-8 shrink-0 cursor-pointer overflow-hidden rounded-full border p-0 outline-none focus-visible:ring-2 focus-visible:ring-premium-accent/45 focus-visible:ring-offset-1 ${
        visualLight ? 'giop-theme-toggle--light' : 'giop-theme-toggle--dark'
      } ${isLightMode ? 'focus-visible:ring-offset-white' : 'focus-visible:ring-offset-[#1a1a1a]'}`}
      style={{ width: TRACK_W }}
      aria-label={isLightMode ? 'Switch to dark mode' : 'Switch to light mode'}
      title="Drag or tap to change theme"
    >
      <span className="giop-theme-toggle__well pointer-events-none absolute inset-[3px] z-0 rounded-full" aria-hidden />

      <span
        className={`giop-theme-toggle__ambient pointer-events-none absolute inset-0 z-0 ${
          visualLight ? 'giop-theme-toggle__ambient--light' : 'giop-theme-toggle__ambient--dark'
        }`}
        aria-hidden
      />

      <span
        className={`giop-theme-toggle__led giop-theme-toggle__led--left pointer-events-none absolute left-[7px] top-1/2 z-[1] -translate-y-1/2 ${
          !visualLight ? 'giop-theme-toggle__led--on' : ''
        }`}
        aria-hidden
      />
      <span
        className={`giop-theme-toggle__led giop-theme-toggle__led--right pointer-events-none absolute right-[7px] top-1/2 z-[1] -translate-y-1/2 ${
          visualLight ? 'giop-theme-toggle__led--on' : ''
        }`}
        aria-hidden
      />

      <motion.span
        className={`giop-theme-toggle__fill pointer-events-none absolute top-[3px] bottom-[3px] left-[3px] z-[1] rounded-full ${
          visualLight ? 'giop-theme-toggle__fill--warm' : 'giop-theme-toggle__fill--cool'
        }`}
        style={{ width: fillWidth, opacity: fillOpacity }}
      />

      <span className="pointer-events-none absolute inset-0 z-[2]">
        {visualLight ? (
          <span
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[8px] font-semibold uppercase tracking-[0.1em] giop-theme-toggle__label--light"
            style={{ maxWidth: `calc(100% - ${LABEL_CLEARANCE}px)` }}
          >
            Light
          </span>
        ) : (
          <span
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-right text-[8px] font-semibold uppercase tracking-[0.1em] giop-theme-toggle__label--dark"
            style={{ maxWidth: `calc(100% - ${LABEL_CLEARANCE}px)` }}
          >
            Dark
          </span>
        )}
      </span>

      <motion.span
        className={`giop-theme-toggle__knob absolute top-1/2 z-[3] flex cursor-grab items-center justify-center rounded-full active:cursor-grabbing ${
          visualLight ? 'giop-theme-toggle__knob--light' : 'giop-theme-toggle__knob--dark'
        }`}
        style={{
          x,
          y: '-50%',
          width: KNOB,
          height: KNOB,
          left: PAD,
          touchAction: 'none',
        }}
        drag={reduceMotion ? false : 'x'}
        dragConstraints={{ left: 0, right: KNOB_TRAVEL_PX }}
        dragElastic={0.05}
        dragMomentum={false}
        whileDrag={{ scale: 1.05 }}
        onDragStart={() => {
          isDragging.current = true;
        }}
        onDrag={() => {
          commitThemeFromX(x.get());
        }}
        onDragEnd={() => {
          isDragging.current = false;
          const nextLight = themeForKnobX(x.get());
          commitThemeFromX(x.get());
          animateKnobTo(nextLight ? KNOB_TRAVEL_PX : 0);
        }}
      >
        <span className="giop-theme-toggle__knob-shine pointer-events-none absolute inset-0 rounded-full" aria-hidden />
        <span className="giop-theme-toggle__knob-rim pointer-events-none absolute inset-0 rounded-full" aria-hidden />
        <motion.span
          key={visualLight ? 'sun' : 'moon'}
          className="relative z-[1] flex items-center justify-center"
          initial={{ opacity: 0.7, scale: 0.9, rotate: visualLight ? -18 : 18 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          transition={{ duration: reduceMotion ? 0.01 : 0.32, ease: TOGGLE_EASE }}
        >
          {visualLight ? (
            <Sun className="giop-theme-toggle__sun-icon h-3.5 w-3.5" strokeWidth={2.1} />
          ) : (
            <MoonStarsIcon className="h-3.5 w-3.5 text-neutral-500" />
          )}
        </motion.span>
      </motion.span>
    </div>
  );
}
