import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { backdropVariants, scaleFade, ease } from '../lib/motion';

export interface AnimatedModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  isLightMode?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  showCloseButton?: boolean;
  footer?: ReactNode;
}

/**
 * Premium animated modal with backdrop blur, scale entrance, and smooth exit.
 * Uses createPortal for proper z-index handling.
 */
export function AnimatedModal({
  open,
  onClose,
  title,
  children,
  isLightMode = false,
  size = 'md',
  showCloseButton = true,
  footer,
}: AnimatedModalProps) {
  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const sizeClasses = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-full mx-4',
  };

  const overlayClass = isLightMode ? 'bg-slate-900/60' : 'bg-black/70';
  const panelClass = isLightMode
    ? 'bg-white border-slate-200 text-slate-900'
    : 'bg-slate-900 border-slate-700 text-slate-100';

  if (!open) return null;

  const modal = (
    <AnimatePresence>
      {open && (
        <motion.div
          initial="hidden"
          animate="visible"
          exit="exit"
          variants={backdropVariants}
          className={`fixed inset-0 z-[9999] flex items-center justify-center p-4 backdrop-blur-sm ${overlayClass}`}
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? 'modal-title' : undefined}
        >
          <motion.div
            variants={scaleFade}
            initial="hidden"
            animate="visible"
            exit="exit"
            className={`w-full ${sizeClasses[size]} rounded-2xl border shadow-2xl overflow-hidden ${panelClass}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            {(title || showCloseButton) && (
              <div className={`flex items-start justify-between gap-3 p-5 border-b ${isLightMode ? 'border-slate-200' : 'border-slate-700/50'}`}>
                {title && (
                  <motion.h2
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1, ease: ease.smooth }}
                    id="modal-title"
                    className="text-lg font-semibold"
                  >
                    {title}
                  </motion.h2>
                )}
                {showCloseButton && (
                  <motion.button
                    type="button"
                    onClick={onClose}
                    whileHover={{ scale: 1.1, rotate: 90 }}
                    whileTap={{ scale: 0.9 }}
                    className={`p-2 rounded-full transition ${isLightMode ? 'hover:bg-slate-100' : 'hover:bg-slate-800'}`}
                    aria-label="Close"
                  >
                    <X className="w-4 h-4" />
                  </motion.button>
                )}
              </div>
            )}

            {/* Content */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, ease: ease.smooth }}
              className={`p-5 max-h-[70vh] overflow-y-auto ${!title && !showCloseButton ? 'pt-6' : ''}`}
            >
              {children}
            </motion.div>

            {/* Footer */}
            {footer && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className={`p-5 border-t ${isLightMode ? 'border-slate-200' : 'border-slate-700/50'}`}
              >
                {footer}
              </motion.div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return createPortal(modal, document.body);
}

interface ConfirmModalProps extends Omit<AnimatedModalProps, 'children' | 'footer'> {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  variant?: 'danger' | 'warning' | 'info';
  isLoading?: boolean;
}

export function ConfirmModal({
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onClose,
  variant = 'warning',
  isLoading = false,
  isLightMode = false,
  ...props
}: ConfirmModalProps) {
  const variantStyles = {
    danger: {
      button: 'bg-rose-600 hover:bg-rose-500 text-white',
      icon: 'text-rose-500',
    },
    warning: {
      button: 'bg-amber-600 hover:bg-amber-500 text-white',
      icon: 'text-amber-500',
    },
    info: {
      button: 'bg-cyan-600 hover:bg-cyan-500 text-white',
      icon: 'text-cyan-500',
    },
  };

  const styles = variantStyles[variant];

  return (
    <AnimatedModal
      {...props}
      onClose={onClose}
      isLightMode={isLightMode}
      footer={
        <div className="flex justify-end gap-3">
          <motion.button
            type="button"
            onClick={onClose}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              isLightMode
                ? 'border border-slate-300 hover:bg-slate-100'
                : 'border border-slate-600 hover:bg-slate-800'
            }`}
          >
            {cancelLabel}
          </motion.button>
          <motion.button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${styles.button} ${isLoading ? 'opacity-70 cursor-not-allowed' : ''}`}
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <motion.span
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                  className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full"
                />
                Processing...
              </span>
            ) : (
              confirmLabel
            )}
          </motion.button>
        </div>
      }
    >
      <p className={`text-sm ${isLightMode ? 'text-slate-600' : 'text-slate-300'}`}>{message}</p>
    </AnimatedModal>
  );
}
