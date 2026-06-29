/**
 * Premium Animation Components for GIOP Portal
 * 
 * These components provide a high-end, polished feel to the application
 * through carefully crafted animations and micro-interactions.
 * 
 * All animations respect prefers-reduced-motion for accessibility.
 */

// Core motion library
export {
  ease,
  duration,
  staggerContainer,
  fadeUpItem,
  fadeInLeft,
  scaleFade,
  slideUp,
  slideInRight,
  pulse,
  shimmer,
  hoverScale,
  springBadge,
  badgeBounce,
  toastVariants,
  backdropVariants,
  pageTransition,
  card3D,
  navIndicator,
  glowPulse,
  progressFill,
} from '../../lib/motion';

// Animated components
export {
  AnimatedSkeleton,
  MetricCardSkeleton,
  TableRowSkeleton,
} from '../AnimatedSkeleton';

export {
  useAnimatedToasts,
  AnimatedToastStack,
  type ToastType,
  type ToastItem,
} from '../AnimatedToast';

export {
  PremiumCard,
  PremiumMetricCard,
  StatCard,
  type PremiumCardProps,
} from '../PremiumCard';

export {
  AnimatedBadge,
  StatusIndicator,
  LiveIndicator,
  type AnimatedBadgeProps,
} from '../AnimatedBadge';

export {
  AnimatedModal,
  ConfirmModal,
  type AnimatedModalProps,
} from '../AnimatedModal';

export {
  EnhancedPortalShell,
  type PortalNavItem,
  type PortalNavGroup,
} from '../EnhancedPortalShell';

export {
  EnhancedCopilotPanel,
} from '../EnhancedCopilotPanel';

export {
  AnimatedDataTable,
  AnimatedActionButton,
  type Column,
} from '../AnimatedDataTable';
