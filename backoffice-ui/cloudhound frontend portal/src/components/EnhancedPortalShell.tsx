import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Moon, Sun } from 'lucide-react';
import type { GiopPortalTab } from '../lib/giopPortalRouting';
import { AnimatedBadge } from './AnimatedBadge';
import { fadeInLeft, ease } from '../lib/motion';

export interface PortalNavItem {
  id: GiopPortalTab;
  label: string;
  badge?: number;
}

export interface PortalNavGroup {
  label: string;
  items: PortalNavItem[];
}

interface EnhancedPortalShellProps {
  activeTab: GiopPortalTab;
  onTabChange: (tab: GiopPortalTab) => void;
  isLightMode: boolean;
  onToggleTheme: () => void;
  title: string;
  subtitle: string;
  statusSlot?: ReactNode;
  navItems?: PortalNavItem[];
  navGroups?: PortalNavGroup[];
  children: ReactNode;
  footerLink?: { href: string; label: string };
}

/**
 * Enhanced Portal Shell with premium animations:
 * - Animated active tab indicator with smooth sliding
 * - Spring-animated badge counts
 * - Staggered entrance animations for nav items
 * - Smooth page transitions
 * - Glass-morphism header with blur effects
 */
export function EnhancedPortalShell({
  activeTab,
  onTabChange,
  isLightMode,
  onToggleTheme,
  title,
  subtitle,
  statusSlot,
  navItems,
  navGroups,
  children,
  footerLink,
}: EnhancedPortalShellProps) {
  const groups: PortalNavGroup[] =
    navGroups ??
    (navItems ? [{ label: 'Navigation', items: navItems }] : []);

  return (
    <div
      className={`h-screen overflow-hidden flex ${isLightMode ? 'bg-slate-50 text-slate-900' : 'bg-[#0a0f18] text-[#e8edf6]'}`}
    >
      {/* Sidebar */}
      <motion.aside
        initial={{ x: -20, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: ease.smooth }}
        className={`w-64 shrink-0 border-r flex flex-col overflow-hidden ${isLightMode ? 'border-slate-200 bg-white' : 'border-[#283246]/75 bg-[#0f141d]'}`}
      >
        {/* Header */}
        <div
          className={`px-6 border-b flex items-center min-h-[74px] ${isLightMode ? 'border-slate-200 bg-white' : 'border-[#283246]/75 bg-[#0b111b]'}`}
        >
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <h1 className={`text-lg font-semibold tracking-wide ${isLightMode ? 'text-slate-900' : 'text-[#eaf0fa]'}`}>
              GIOP
            </h1>
            <p className={`text-xs ${isLightMode ? 'text-slate-500' : 'text-[#93a0b8]'}`}>
              Grid Intelligent Operating Platform
            </p>
          </motion.div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 min-h-0 overflow-y-auto px-6 pt-5 pb-4 space-y-5">
          {groups.map((group, groupIndex) => (
            <motion.div
              key={group.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 * groupIndex + 0.3 }}
            >
              <p
                className={`text-xs font-light uppercase tracking-widest mb-2 ${isLightMode ? 'text-slate-500' : 'text-[#93a0b8]'}`}
              >
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map((item, itemIndex) => (
                  <NavButton
                    key={item.id}
                    item={item}
                    isActive={activeTab === item.id}
                    isLightMode={isLightMode}
                    onClick={() => onTabChange(item.id)}
                    index={itemIndex}
                  />
                ))}
              </div>
            </motion.div>
          ))}
        </nav>

        {/* Footer */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className={`px-6 py-3 border-t space-y-1.5 ${isLightMode ? 'border-slate-200' : 'border-[#283246]/75'}`}
        >
          {footerLink && (
            <a
              href={footerLink.href}
              target="_blank"
              rel="noreferrer"
              className={`block px-3 py-1.5 text-sm font-light rounded transition ${isLightMode ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100' : 'text-[#a7b4ca] hover:text-[#f2f6fd] hover:bg-[#1a2230]'}`}
            >
              {footerLink.label}
            </a>
          )}
        </motion.div>
      </motion.aside>

      {/* Main Content */}
      <div className={`flex-1 min-w-0 flex flex-col ${isLightMode ? 'bg-slate-50' : 'bg-[#0a0f18]'}`}>
        {/* Header */}
        <motion.header
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: ease.smooth }}
          className={`sticky top-0 z-30 backdrop-blur-md border-b ${isLightMode ? 'bg-slate-100/90 border-slate-200 shadow-[0_8px_20px_rgba(15,23,42,0.06)]' : 'bg-[#0f141d]/90 border-[#2a3447]/75 shadow-[0_8px_20px_rgba(0,0,0,0.32)]'}`}
        >
          <div className="px-7 pt-3 pb-2">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <motion.div
                key={title}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3 }}
              >
                <h2 className={`text-xl font-light tracking-wide ${isLightMode ? 'text-slate-900' : 'text-[#eaf0fa]'}`}>
                  {title}
                </h2>
                <p className={`text-xs mt-1 ${isLightMode ? 'text-slate-500' : 'text-[#a8b4ca]'}`}>{subtitle}</p>
              </motion.div>
              <div className="flex items-center gap-4">
                {statusSlot}
                <motion.button
                  type="button"
                  onClick={onToggleTheme}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border transition ${isLightMode ? 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100' : 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800'}`}
                  aria-label={isLightMode ? 'Switch to dark mode' : 'Switch to light mode'}
                >
                  <motion.div
                    key={isLightMode ? 'light' : 'dark'}
                    initial={{ rotate: -90, opacity: 0 }}
                    animate={{ rotate: 0, opacity: 1 }}
                    exit={{ rotate: 90, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    {isLightMode ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                  </motion.div>
                </motion.button>
              </div>
            </div>
          </div>
        </motion.header>

        {/* Content Area with Page Transitions */}
        <div className={`flex-1 min-h-0 overflow-hidden ${isLightMode ? 'bg-slate-50' : 'bg-[#0a0f18]'}`}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.main
              key={activeTab}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2, ease: ease.smooth }}
              className="h-full overflow-auto"
            >
              {children}
            </motion.main>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

interface NavButtonProps {
  item: PortalNavItem;
  isActive: boolean;
  isLightMode: boolean;
  onClick: () => void;
  index: number;
}

function NavButton({ item, isActive, isLightMode, onClick, index }: NavButtonProps) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      variants={fadeInLeft}
      initial="hidden"
      animate="visible"
      transition={{ delay: index * 0.05 }}
      whileHover={{ x: 2 }}
      whileTap={{ scale: 0.98 }}
      className={`group relative block w-full px-3 py-2 text-left text-sm font-light border-l-2 rounded-r transition-colors ${
        isActive
          ? isLightMode
            ? 'text-slate-900 border-indigo-500 bg-slate-100'
            : 'text-[#f2f6fd] border-indigo-400 bg-[#1a2230]'
          : isLightMode
            ? 'text-slate-700 border-transparent hover:text-slate-900 hover:bg-slate-100'
            : 'text-[#a7b4ca] border-transparent hover:text-[#f2f6fd] hover:bg-[#1a2230]'
      }`}
    >
      {/* Active Indicator Bar - per button with animate presence */}
      <AnimatePresence>
        {isActive && (
          <motion.div
            initial={{ scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            exit={{ scaleY: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className={`absolute left-0 top-0 bottom-0 w-0.5 rounded-full origin-top ${isLightMode ? 'bg-indigo-500' : 'bg-indigo-400'}`}
          />
        )}
      </AnimatePresence>

      <span className="flex items-center justify-between gap-2 w-full">
        <span>{item.label}</span>
        {item.badge != null && item.badge > 0 && (
          <AnimatedBadge count={item.badge} isLightMode={isLightMode} size="sm" pulse={isActive} />
        )}
      </span>
    </motion.button>
  );
}
