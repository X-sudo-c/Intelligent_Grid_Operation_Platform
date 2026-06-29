import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, AlertCircle, Info, X, Sparkles } from 'lucide-react';
import { toastVariants } from '../lib/motion';

export type ToastType = 'success' | 'error' | 'info' | 'premium';

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

const AUTO_DISMISS_MS = 4000;

const toastIcons: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  premium: Sparkles,
};

// eslint-disable-next-line react-refresh/only-export-components
export function useAnimatedToasts(autoDismissMs = AUTO_DISMISS_MS) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'success', duration?: number) => {
      const trimmed = message.trim();
      if (!trimmed) return;

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const newToast: ToastItem = { id, message: trimmed, type, duration };

      setToasts((prev) => {
        // Prevent duplicate messages
        const isDuplicate = prev.some((t) => t.message === trimmed && t.type === type);
        if (isDuplicate) return prev;
        return [...prev, newToast];
      });

      const timer = window.setTimeout(
        () => dismissToast(id),
        duration ?? autoDismissMs,
      );
      timersRef.current.set(id, timer);

      return id;
    },
    [autoDismissMs, dismissToast],
  );

  const updateToast = useCallback(
    (id: string, message: string, type: ToastType = 'success') => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, message, type } : t)),
      );
    },
    [],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return { toasts, showToast, dismissToast, updateToast };
}

interface AnimatedToastStackProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
  isLightMode?: boolean;
}

export function AnimatedToastStack({
  toasts,
  onDismiss,
  isLightMode = false,
}: AnimatedToastStackProps) {
  if (toasts.length === 0) return null;

  const typeStyles: Record<
    ToastType,
    { container: string; icon: string; glow: string }
  > = {
    success: {
      container: isLightMode
        ? 'border-emerald-200/80 bg-emerald-50/95 text-emerald-800'
        : 'border-emerald-800/60 bg-emerald-950/95 text-emerald-200',
      icon: 'text-emerald-500',
      glow: 'shadow-[0_0_20px_rgba(16,185,129,0.2)]',
    },
    error: {
      container: isLightMode
        ? 'border-rose-200/80 bg-rose-50/95 text-rose-800'
        : 'border-rose-800/60 bg-rose-950/95 text-rose-200',
      icon: 'text-rose-500',
      glow: 'shadow-[0_0_20px_rgba(244,63,94,0.2)]',
    },
    info: {
      container: isLightMode
        ? 'border-sky-200/80 bg-sky-50/95 text-sky-800'
        : 'border-sky-800/60 bg-sky-950/95 text-sky-200',
      icon: 'text-sky-500',
      glow: 'shadow-[0_0_20px_rgba(14,165,233,0.2)]',
    },
    premium: {
      container: isLightMode
        ? 'border-amber-200/80 bg-gradient-to-br from-amber-50/95 to-orange-50/95 text-amber-800'
        : 'border-amber-700/60 bg-gradient-to-br from-amber-950/95 to-orange-950/95 text-amber-200',
      icon: 'text-amber-400',
      glow: 'shadow-[0_0_24px_rgba(245,158,11,0.25)]',
    },
  };

  return (
    <div
      className="pointer-events-none fixed bottom-6 right-6 z-[100] flex w-full max-w-sm flex-col gap-2"
      aria-live="polite"
      aria-relevant="additions"
    >
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => {
          const styles = typeStyles[toast.type];
          const Icon = toastIcons[toast.type];
          const isPremium = toast.type === 'premium';

          return (
            <motion.div
              key={toast.id}
              layout
              variants={toastVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className={`pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3.5 backdrop-blur-md ${styles.container} ${styles.glow} ${isPremium ? 'ring-1 ring-amber-400/20' : ''}`}
              role="status"
            >
              <motion.div
                initial={{ scale: 0, rotate: -45 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{
                  type: 'spring',
                  stiffness: 400,
                  damping: 20,
                  delay: 0.1,
                }}
              >
                <Icon className={`h-5 w-5 shrink-0 ${styles.icon}`} />
              </motion.div>
              <p className="flex-1 text-sm leading-relaxed font-medium">
                {toast.message}
              </p>
              <motion.button
                type="button"
                onClick={() => onDismiss(toast.id)}
                className={`shrink-0 rounded p-1 transition ${isLightMode ? 'hover:bg-black/5' : 'hover:bg-white/10'}`}
                aria-label="Dismiss notification"
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
              >
                <X className="h-4 w-4" />
              </motion.button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
