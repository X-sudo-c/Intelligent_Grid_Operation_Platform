/**
 * Premium motion presets and variants for the GIOP Portal.
 * These provide a consistent, high-end feel across the application.
 */

import type { Variants } from 'framer-motion';

// Custom easing curves for premium feel
export const ease = {
  smooth: [0.22, 1, 0.36, 1] as const,
  bounce: [0.68, -0.55, 0.265, 1.55] as const,
  spring: { type: 'spring', stiffness: 400, damping: 30 } as const,
  gentle: [0.4, 0, 0.2, 1] as const,
};

// Duration presets
export const duration = {
  fast: 0.15,
  normal: 0.3,
  slow: 0.5,
  xslow: 0.8,
};

// Stagger children variants for lists
export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.1,
    },
  },
};

// Fade up animation for list items
export const fadeUpItem: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: duration.normal,
      ease: ease.smooth,
    },
  },
};

// Fade in from left (for navigation items)
export const fadeInLeft: Variants = {
  hidden: { opacity: 0, x: -12 },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      duration: duration.normal,
      ease: ease.smooth,
    },
  },
};

// Scale fade for cards and modals
export const scaleFade: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      duration: duration.slow,
      ease: ease.smooth,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.98,
    transition: {
      duration: duration.fast,
      ease: ease.gentle,
    },
  },
};

// Slide up from bottom (for panels and toasts)
export const slideUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: duration.normal,
      ease: ease.smooth,
    },
  },
  exit: {
    opacity: 0,
    y: 16,
    transition: {
      duration: duration.fast,
      ease: ease.gentle,
    },
  },
};

// Slide in from right (for side panels)
export const slideInRight: Variants = {
  hidden: { opacity: 0, x: 48 },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      duration: duration.slow,
      ease: ease.smooth,
    },
  },
  exit: {
    opacity: 0,
    x: 24,
    transition: {
      duration: duration.fast,
      ease: ease.gentle,
    },
  },
};

// Pulse animation for loading states
export const pulse: Variants = {
  animate: {
    opacity: [0.5, 1, 0.5],
    transition: {
      duration: 1.5,
      repeat: Infinity,
      ease: 'easeInOut',
    },
  },
};

// Shimmer animation for skeletons
export const shimmer: Variants = {
  animate: {
    x: ['-100%', '100%'],
    transition: {
      duration: 1.2,
      repeat: Infinity,
      ease: 'linear',
    },
  },
};

// Hover scale effect for interactive cards
export const hoverScale = {
  whileHover: { scale: 1.02, y: -2 },
  whileTap: { scale: 0.98 },
  transition: { duration: 0.2, ease: ease.smooth },
};

// Spring config for badges and small elements
export const springBadge = {
  initial: { scale: 0 },
  animate: { scale: 1 },
  transition: { type: 'spring', stiffness: 500, damping: 25 },
};

// Badge bounce animation
export const badgeBounce: Variants = {
  initial: { scale: 0, y: 8 },
  animate: {
    scale: 1,
    y: 0,
    transition: {
      type: 'spring',
      stiffness: 500,
      damping: 20,
    },
  },
};

// Toast animation variants
export const toastVariants: Variants = {
  initial: { opacity: 0, x: 24, scale: 0.9 },
  animate: {
    opacity: 1,
    x: 0,
    scale: 1,
    transition: {
      duration: duration.normal,
      ease: ease.smooth,
    },
  },
  exit: {
    opacity: 0,
    x: 16,
    scale: 0.95,
    transition: {
      duration: duration.fast,
      ease: ease.gentle,
    },
  },
};

// Modal backdrop animation
export const backdropVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: duration.fast },
  },
  exit: {
    opacity: 0,
    transition: { duration: duration.fast },
  },
};

// Page transition for tab switching
export const pageTransition: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: duration.normal,
      ease: ease.smooth,
    },
  },
  exit: {
    opacity: 0,
    y: -8,
    transition: {
      duration: duration.fast,
      ease: ease.gentle,
    },
  },
};

// Animated number counter
export const countUp = (_value: number) => ({
  initial: { opacity: 0 },
  animate: {
    opacity: 1,
    transition: { duration: 0.3 },
  },
});

// Card 3D hover transform
export const card3D = {
  whileHover: {
    y: -4,
    scale: 1.01,
    boxShadow: '0 20px 40px rgba(0,0,0,0.15)',
    transition: { duration: 0.3, ease: ease.smooth },
  },
};

// Nav item active indicator
export const navIndicator: Variants = {
  inactive: {
    scaleX: 0,
    opacity: 0,
  },
  active: {
    scaleX: 1,
    opacity: 1,
    transition: {
      duration: duration.normal,
      ease: ease.smooth,
    },
  },
};

// Glow pulse for AI/active states
export const glowPulse: Variants = {
  animate: {
    boxShadow: [
      '0 0 0 0 rgba(6, 182, 212, 0)',
      '0 0 20px 2px rgba(6, 182, 212, 0.3)',
      '0 0 0 0 rgba(6, 182, 212, 0)',
    ],
    transition: {
      duration: 2,
      repeat: Infinity,
      ease: 'easeInOut',
    },
  },
};

// Progress bar fill animation
export const progressFill: Variants = {
  initial: { scaleX: 0, originX: 0 },
  animate: (progress: number) => ({
    scaleX: progress / 100,
    transition: {
      duration: 0.6,
      ease: ease.smooth,
    },
  }),
};
