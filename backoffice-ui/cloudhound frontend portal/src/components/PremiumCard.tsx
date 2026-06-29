import { motion } from 'framer-motion';
import type { HTMLMotionProps } from 'framer-motion';
import type { ReactNode } from 'react';
import { ease } from '../lib/motion';

export interface PremiumCardProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
  children: ReactNode;
  isLightMode?: boolean;
  variant?: 'default' | 'glass' | 'elevated' | 'glow';
  hoverEffect?: 'lift' | 'glow' | 'scale' | 'none';
}

/**
 * Premium card component with sophisticated hover effects.
 * Supports glass morphism, elevation, and glow variants.
 */
export function PremiumCard({
  children,
  isLightMode = false,
  variant = 'default',
  hoverEffect = 'lift',
  className = '',
  ...motionProps
}: PremiumCardProps) {
  const baseStyles = 'rounded-xl border overflow-hidden';

  const variantStyles = {
    default: isLightMode
      ? 'bg-white border-slate-200'
      : 'bg-[#0f141d] border-[#283246]/75',
    glass: isLightMode
      ? 'bg-white/80 backdrop-blur-xl border-white/20 shadow-lg'
      : 'bg-[#0f141d]/80 backdrop-blur-xl border-white/5 shadow-xl',
    elevated: isLightMode
      ? 'bg-white border-slate-200 shadow-lg'
      : 'bg-[#131922] border-[#364258]/50 shadow-2xl',
    glow: isLightMode
      ? 'bg-white border-slate-200 shadow-[0_0_40px_rgba(99,102,241,0.1)]'
      : 'bg-[#0f141d] border-[#4f46e5]/30 shadow-[0_0_40px_rgba(79,70,229,0.15)]',
  };

  const hoverStyles = {
    lift: {
      whileHover: {
        y: -4,
        boxShadow: isLightMode
          ? '0 20px 40px rgba(15,23,42,0.12)'
          : '0 20px 40px rgba(0,0,0,0.4)',
      },
      whileTap: { y: -2, scale: 0.995 },
    },
    glow: {
      whileHover: {
        boxShadow: isLightMode
          ? '0 0 30px rgba(99,102,241,0.2)'
          : '0 0 30px rgba(79,70,229,0.3)',
      },
      whileTap: { scale: 0.995 },
    },
    scale: {
      whileHover: { scale: 1.02 },
      whileTap: { scale: 0.98 },
    },
    none: {},
  };

  const selectedHover = hoverStyles[hoverEffect];

  return (
    <motion.div
      className={`${baseStyles} ${variantStyles[variant]} ${className}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: ease.smooth }}
      {...selectedHover}
      {...motionProps}
    >
      {children}
    </motion.div>
  );
}

interface PremiumMetricCardProps {
  label: string;
  value: string | number;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  isLightMode?: boolean;
  icon?: ReactNode;
  color?: 'default' | 'success' | 'warning' | 'danger' | 'info';
}

export function PremiumMetricCard({
  label,
  value,
  trend,
  trendValue,
  isLightMode = false,
  icon,
  color = 'default',
}: PremiumMetricCardProps) {
  const colorStyles = {
    default: isLightMode ? 'text-slate-700' : 'text-slate-300',
    success: 'text-emerald-500',
    warning: 'text-amber-500',
    danger: 'text-rose-500',
    info: 'text-cyan-500',
  };

  const trendIcons = {
    up: '↑',
    down: '↓',
    neutral: '→',
  };

  return (
    <PremiumCard
      isLightMode={isLightMode}
      variant="elevated"
      hoverEffect="lift"
      className="p-5"
    >
      <div className="flex items-start justify-between">
        <div>
          <p className={`text-xs font-medium uppercase tracking-wider ${isLightMode ? 'text-slate-500' : 'text-slate-400'}`}>
            {label}
          </p>
          <motion.h3
            className={`text-2xl font-semibold mt-1 ${colorStyles[color]}`}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1, type: 'spring', stiffness: 300 }}
          >
            {value}
          </motion.h3>
          {trend && (
            <motion.div
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              className={`flex items-center gap-1 mt-2 text-xs ${
                trend === 'up' ? 'text-emerald-500' : trend === 'down' ? 'text-rose-500' : 'text-slate-500'
              }`}
            >
              <span>{trendIcons[trend]}</span>
              <span>{trendValue}</span>
            </motion.div>
          )}
        </div>
        {icon && (
          <motion.div
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.15, type: 'spring', stiffness: 400 }}
            className={`p-2.5 rounded-lg ${isLightMode ? 'bg-slate-100' : 'bg-slate-800/60'}`}
          >
            {icon}
          </motion.div>
        )}
      </div>
    </PremiumCard>
  );
}

interface StatCardProps {
  title: string;
  value: number;
  max?: number;
  isLightMode?: boolean;
  animate?: boolean;
}

export function StatCard({
  title,
  value,
  max,
  isLightMode = false,
  animate = true,
}: StatCardProps) {
  const percentage = max ? (value / max) * 100 : undefined;

  return (
    <motion.div
      className={`p-4 rounded-lg border ${isLightMode ? 'bg-white border-slate-200' : 'bg-[#131922] border-[#364258]/50'}`}
      whileHover={{ y: -2, transition: { duration: 0.2 } }}
    >
      <p className={`text-xs uppercase tracking-wide ${isLightMode ? 'text-slate-500' : 'text-slate-400'}`}>
        {title}
      </p>
      <div className="flex items-baseline gap-2 mt-1">
        <motion.span
          className={`text-2xl font-semibold ${isLightMode ? 'text-slate-800' : 'text-slate-200'}`}
          initial={animate ? { opacity: 0, y: 10 } : undefined}
          animate={animate ? { opacity: 1, y: 0 } : undefined}
          transition={{ type: 'spring', stiffness: 300 }}
        >
          {value.toLocaleString()}
        </motion.span>
        {max && (
          <span className={`text-sm ${isLightMode ? 'text-slate-400' : 'text-slate-500'}`}>
            / {max.toLocaleString()}
          </span>
        )}
      </div>
      {percentage !== undefined && (
        <div className={`mt-3 h-1.5 rounded-full overflow-hidden ${isLightMode ? 'bg-slate-100' : 'bg-slate-800'}`}>
          <motion.div
            className={`h-full rounded-full ${percentage >= 80 ? 'bg-emerald-500' : percentage >= 50 ? 'bg-amber-500' : 'bg-rose-500'}`}
            initial={{ width: 0 }}
            animate={{ width: `${percentage}%` }}
            transition={{ duration: 0.8, ease: ease.smooth, delay: 0.2 }}
          />
        </div>
      )}
    </motion.div>
  );
}
