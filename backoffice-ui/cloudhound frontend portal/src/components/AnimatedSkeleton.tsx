import { motion } from 'framer-motion';
import { shimmer } from '../lib/motion';

interface AnimatedSkeletonProps {
  className?: string;
  isLightMode?: boolean;
  variant?: 'default' | 'card' | 'text' | 'avatar' | 'metric';
}

/**
 * Premium animated skeleton with shimmer effect.
 * Provides a high-end loading experience instead of static pulses.
 */
export function AnimatedSkeleton({
  className = '',
  isLightMode = false,
  variant = 'default',
}: AnimatedSkeletonProps) {
  const baseClass = isLightMode ? 'bg-slate-200' : 'bg-[#1e2736]';
  const shimmerClass = isLightMode
    ? 'bg-gradient-to-r from-transparent via-slate-100/60 to-transparent'
    : 'bg-gradient-to-r from-transparent via-white/10 to-transparent';

  const variants = {
    default: 'h-4 w-full rounded',
    card: 'h-32 w-full rounded-lg',
    text: 'h-4 w-3/4 rounded',
    avatar: 'h-10 w-10 rounded-full',
    metric: 'h-8 w-20 rounded',
  };

  return (
    <div className={`relative overflow-hidden ${variants[variant]} ${baseClass} ${className}`}>
      <motion.div
        className={`absolute inset-0 ${shimmerClass}`}
        variants={shimmer}
        animate="animate"
        style={{ width: '50%' }}
      />
    </div>
  );
}

interface MetricCardSkeletonProps {
  isLightMode?: boolean;
}

export function MetricCardSkeleton({ isLightMode = false }: MetricCardSkeletonProps) {
  const cardBg = isLightMode ? 'bg-white border-slate-200' : 'bg-[#171e2a] border-[#364258]';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-lg border p-6 ${cardBg}`}
    >
      <AnimatedSkeleton variant="text" className="mb-4 w-20" isLightMode={isLightMode} />
      <AnimatedSkeleton variant="metric" isLightMode={isLightMode} />
    </motion.div>
  );
}

interface TableRowSkeletonProps {
  isLightMode?: boolean;
  columns?: number;
}

export function TableRowSkeleton({ isLightMode = false, columns = 4 }: TableRowSkeletonProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={`flex gap-4 p-4 border-b ${isLightMode ? 'border-slate-200' : 'border-slate-700/50'}`}
    >
      {Array.from({ length: columns }).map((_, i) => (
        <AnimatedSkeleton
          key={i}
          className={i === 0 ? 'flex-1' : 'w-24'}
          isLightMode={isLightMode}
        />
      ))}
    </motion.div>
  );
}
