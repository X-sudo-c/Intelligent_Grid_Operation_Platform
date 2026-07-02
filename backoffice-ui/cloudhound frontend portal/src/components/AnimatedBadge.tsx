import { motion, AnimatePresence } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

export interface AnimatedBadgeProps {
  count: number;
  isLightMode?: boolean;
  size?: 'sm' | 'md' | 'lg';
  pulse?: boolean;
}

/**
 * Animated badge with spring entrance and pulse effects.
 * Perfect for notification counts, status indicators, and live updates.
 */
export function AnimatedBadge({
  count,
  isLightMode = false,
  size = 'md',
  pulse = false,
}: AnimatedBadgeProps) {
  const [displayCount, setDisplayCount] = useState(count);
  const [hasChanged, setHasChanged] = useState(false);
  const countRef = useRef(count);

  useEffect(() => {
    if (count !== countRef.current) {
      countRef.current = count;
      setHasChanged(true);
      setDisplayCount(count);
      const timer = window.setTimeout(() => setHasChanged(false), 600);
      return () => window.clearTimeout(timer);
    }
  }, [count]);

  if (count <= 0) return null;

  const sizeStyles = {
    sm: 'min-w-[1rem] h-4 px-1 text-[10px]',
    md: 'min-w-[1.25rem] h-5 px-1.5 text-[11px]',
    lg: 'min-w-[1.5rem] h-6 px-2 text-xs',
  };

  const formattedCount = count > 99 ? '99+' : count;

  return (
    <motion.span
      key={displayCount}
      initial={{ scale: 0, y: 8 }}
      animate={{ scale: 1, y: 0 }}
      transition={{
        type: 'spring',
        stiffness: 500,
        damping: 20,
      }}
      className={`inline-flex items-center justify-center rounded-full font-semibold leading-none ${
        isLightMode
          ? 'bg-amber-600 text-white'
          : 'border border-premium-border/60 bg-premium-hover-strong text-premium-text-secondary'
      } ${sizeStyles[size]} ${hasChanged ? 'ring-2 ring-offset-2 ' + (isLightMode ? 'ring-amber-400' : 'ring-premium-border') : ''}`}
    >
      <AnimatePresence mode="wait">
        <motion.span
          key={formattedCount}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.15 }}
        >
          {formattedCount}
        </motion.span>
      </AnimatePresence>
      {pulse && (
        <motion.span
          className={`absolute inset-0 rounded-full ${isLightMode ? 'bg-amber-600' : 'bg-premium-muted-dim'}`}
          animate={{
            scale: [1, 1.4, 1],
            opacity: [0.5, 0, 0.5],
          }}
          transition={{
            duration: 1.5,
            repeat: Infinity,
            ease: 'easeOut',
          }}
        />
      )}
    </motion.span>
  );
}

interface StatusIndicatorProps {
  status: 'online' | 'offline' | 'busy' | 'warning' | 'error';
  size?: 'sm' | 'md' | 'lg';
  pulse?: boolean;
  showLabel?: boolean;
}

const statusConfig = {
  online: { color: 'bg-emerald-500', label: 'Online' },
  offline: { color: 'bg-slate-400', label: 'Offline' },
  busy: { color: 'bg-amber-500', label: 'Busy' },
  warning: { color: 'bg-amber-500', label: 'Warning' },
  error: { color: 'bg-rose-500', label: 'Error' },
};

export function StatusIndicator({
  status,
  size = 'md',
  pulse = true,
  showLabel = false,
}: StatusIndicatorProps) {
  const config = statusConfig[status];

  const sizeStyles = {
    sm: 'w-2 h-2',
    md: 'w-2.5 h-2.5',
    lg: 'w-3 h-3',
  };

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <span className={`block rounded-full ${config.color} ${sizeStyles[size]}`} />
        {pulse && (status === 'online' || status === 'busy' || status === 'warning') && (
          <motion.span
            className={`absolute inset-0 rounded-full ${config.color}`}
            animate={{
              scale: [1, 1.8, 1],
              opacity: [0.6, 0, 0.6],
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: 'easeOut',
            }}
          />
        )}
      </div>
      {showLabel && (
        <span className="text-xs text-slate-400">{config.label}</span>
      )}
    </div>
  );
}

interface LiveIndicatorProps {
  isLive?: boolean;
  label?: string;
}

export function LiveIndicator({ isLive = true, label = 'LIVE' }: LiveIndicatorProps) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative">
        <span className="block w-2 h-2 rounded-full bg-rose-500" />
        {isLive && (
          <>
            <motion.span
              className="absolute inset-0 rounded-full bg-rose-500"
              animate={{
                scale: [1, 2, 1],
                opacity: [0.7, 0, 0.7],
              }}
              transition={{
                duration: 1.2,
                repeat: Infinity,
                ease: 'easeOut',
              }}
            />
            <motion.span
              className="absolute inset-0 rounded-full bg-rose-500"
              animate={{
                scale: [1, 2.5, 1],
                opacity: [0.4, 0, 0.4],
              }}
              transition={{
                duration: 1.2,
                repeat: Infinity,
                ease: 'easeOut',
                delay: 0.3,
              }}
            />
          </>
        )}
      </div>
      <span className="text-[10px] font-semibold tracking-wider text-rose-500">{label}</span>
    </div>
  );
}
