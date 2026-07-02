import { motion, AnimatePresence } from 'framer-motion';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { ChevronDown, ChevronUp, ArrowUpDown } from 'lucide-react';
import { staggerContainer, fadeUpItem, ease } from '../lib/motion';

export interface Column<T> {
  key: string;
  header: string;
  width?: string;
  sortable?: boolean;
  render?: (row: T) => ReactNode;
  cellClassName?: string;
}

interface AnimatedDataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  isLightMode?: boolean;
  keyExtractor: (row: T) => string;
  onRowClick?: (row: T) => void;
  isLoading?: boolean;
  emptyMessage?: string;
  className?: string;
}

/**
 * Premium animated data table with:
 * - Staggered row entrance animations
 * - Smooth hover effects with row highlighting
 * - Sortable columns with animated indicators
 * - Empty state animation
 * - Loading skeleton state
 */
export function AnimatedDataTable<T>({
  data,
  columns,
  isLightMode = false,
  keyExtractor,
  onRowClick,
  isLoading = false,
  emptyMessage = 'No data available',
  className = '',
}: AnimatedDataTableProps<T>) {
  const [sortConfig, setSortConfig] = useState<{
    key: string;
    direction: 'asc' | 'desc';
  } | null>(null);
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  const handleSort = (key: string) => {
    if (sortConfig?.key === key) {
      setSortConfig({
        key,
        direction: sortConfig.direction === 'asc' ? 'desc' : 'asc',
      });
    } else {
      setSortConfig({ key, direction: 'asc' });
    }
  };

  const sortedData = [...data].sort((a, b) => {
    if (!sortConfig) return 0;
    const aValue = (a as Record<string, string | number>)[sortConfig.key];
    const bValue = (b as Record<string, string | number>)[sortConfig.key];
    if (aValue == null && bValue == null) return 0;
    if (aValue == null) return sortConfig.direction === 'asc' ? -1 : 1;
    if (bValue == null) return sortConfig.direction === 'asc' ? 1 : -1;
    if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
    if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

  const headerClass = `text-left text-xs font-medium uppercase tracking-wider ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`;
  const rowBaseClass = `transition-colors duration-200 ${isLightMode ? 'hover:bg-slate-50' : 'hover:bg-premium-hover/30'}`;

  if (isLoading) {
    return (
      <div className={`rounded-xl border overflow-hidden ${isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/70 bg-premium-card'} ${className}`}>
        <div className="p-8 space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: i * 0.1 }}
              className="flex gap-4"
            >
              <div className={`h-4 flex-1 rounded ${isLightMode ? 'bg-slate-200' : 'bg-slate-700'}`} />
              <div className={`h-4 w-24 rounded ${isLightMode ? 'bg-slate-200' : 'bg-slate-700'}`} />
              <div className={`h-4 w-24 rounded ${isLightMode ? 'bg-slate-200' : 'bg-slate-700'}`} />
            </motion.div>
          ))}
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className={`flex flex-col items-center justify-center py-16 rounded-xl border ${isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/70 bg-premium-card'} ${className}`}
      >
        <motion.div
          animate={{ y: [0, -8, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 ${isLightMode ? 'bg-slate-100' : 'bg-slate-800'}`}
        >
          <span className={`text-2xl ${isLightMode ? 'text-slate-400' : 'text-slate-500'}`}>📊</span>
        </motion.div>
        <p className={`text-sm ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>{emptyMessage}</p>
      </motion.div>
    );
  }

  return (
    <div className={`rounded-xl border overflow-hidden ${isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/70 bg-premium-card'} ${className}`}>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className={`border-b ${isLightMode ? 'border-slate-200 bg-slate-50/80' : 'border-slate-700 bg-slate-800/50'}`}>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`px-4 py-3 ${headerClass} ${column.width || ''}`}
                  onClick={() => column.sortable && handleSort(column.key)}
                >
                  <div className={`flex items-center gap-1 ${column.sortable ? 'cursor-pointer hover:text-indigo-500 transition-colors' : ''}`}>
                    {column.header}
                    {column.sortable && (
                      <motion.span
                        initial={false}
                        animate={{ rotate: sortConfig?.key === column.key ? (sortConfig.direction === 'asc' ? 0 : 180) : 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        {sortConfig?.key === column.key ? (
                          sortConfig.direction === 'asc' ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        )}
                      </motion.span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <motion.tbody
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
            className="divide-y divide-dashed"
          >
            <AnimatePresence>
              {sortedData.map((row) => {
                const rowKey = keyExtractor(row);
                const isHovered = hoveredRow === rowKey;

                return (
                  <motion.tr
                    key={rowKey}
                    variants={fadeUpItem}
                    layout
                    onClick={() => onRowClick?.(row)}
                    onMouseEnter={() => setHoveredRow(rowKey)}
                    onMouseLeave={() => setHoveredRow(null)}
                    className={`${rowBaseClass} ${onRowClick ? 'cursor-pointer' : ''} ${isLightMode ? 'divide-slate-200' : 'divide-slate-700/50'}`}
                  >
                    {columns.map((column) => {
                      const content = column.render
                        ? column.render(row)
                        : String((row as Record<string, unknown>)[column.key] ?? '-');

                      return (
                        <td
                          key={column.key}
                          className={`px-4 py-3 text-sm ${column.cellClassName || ''}`}
                        >
                          <motion.div
                            initial={false}
                            animate={{ x: isHovered ? 2 : 0 }}
                            transition={{ duration: 0.2, ease: ease.smooth }}
                          >
                            {content}
                          </motion.div>
                        </td>
                      );
                    })}
                  </motion.tr>
                );
              })}
            </AnimatePresence>
          </motion.tbody>
        </table>
      </div>
    </div>
  );
}

interface ActionButtonProps {
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  isLoading?: boolean;
  children: ReactNode;
  isLightMode?: boolean;
}

export function AnimatedActionButton({
  onClick,
  variant = 'secondary',
  size = 'sm',
  isLoading = false,
  children,
  isLightMode = false,
}: ActionButtonProps) {
  const baseClass = `inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all`;
  const sizeClass = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm';

  const variants = {
    primary: isLightMode
      ? 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm'
      : 'bg-indigo-500 text-white hover:bg-indigo-400 shadow-sm shadow-indigo-500/20',
    secondary: isLightMode
      ? 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
      : 'bg-slate-800 border border-slate-600 text-slate-200 hover:bg-slate-700',
    danger: isLightMode
      ? 'bg-rose-600 text-white hover:bg-rose-700'
      : 'bg-rose-500 text-white hover:bg-rose-400',
    ghost: isLightMode
      ? 'text-slate-600 hover:bg-slate-100'
      : 'text-slate-400 hover:bg-premium-hover/50',
  };

  return (
    <motion.button
      onClick={onClick}
      disabled={isLoading}
      whileHover={{ scale: 1.02, y: -1 }}
      whileTap={{ scale: 0.98 }}
      className={`${baseClass} ${sizeClass} ${variants[variant]} ${isLoading ? 'opacity-70 cursor-not-allowed' : ''}`}
    >
      {isLoading ? (
        <motion.span
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
          className="w-4 h-4 border-2 border-current/30 border-t-current rounded-full"
        />
      ) : (
        children
      )}
    </motion.button>
  );
}
