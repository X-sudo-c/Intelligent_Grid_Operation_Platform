import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { GiopPortalTab } from '../lib/giopPortalRouting';
import { giopThemeTokens } from '../lib/giopTheme';
import { AnimatedBadge } from './AnimatedBadge';
import { GiopThemeToggle } from './GiopThemeToggle';
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
  onThemeChange: (isLightMode: boolean) => void;
  title: string;
  subtitle: string;
  statusSlot?: ReactNode;
  navItems?: PortalNavItem[];
  navGroups?: PortalNavGroup[];
  children: ReactNode;
  footerLink?: { href: string; label: string };
}

export function EnhancedPortalShell({
  activeTab,
  onTabChange,
  isLightMode,
  onThemeChange,
  title,
  subtitle,
  statusSlot,
  navItems,
  navGroups,
  children,
  footerLink,
}: EnhancedPortalShellProps) {
  const t = giopThemeTokens(isLightMode);
  const groups: PortalNavGroup[] =
    navGroups ??
    (navItems ? [{ label: 'Navigation', items: navItems }] : []);

  return (
    <div className={`h-screen overflow-hidden flex transition-colors ease-out ${t.app}`} style={{ transitionDuration: 'var(--giop-theme-transition-ms, 650ms)' }}>
      <motion.aside
        initial={{ x: -20, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: ease.smooth }}
        className={`w-64 shrink-0 border-r flex flex-col overflow-hidden transition-colors ease-out ${t.sidebar}`}
        style={{ transitionDuration: 'var(--giop-theme-transition-ms, 650ms)' }}
      >
        <div
          className={`px-6 border-b flex items-center min-h-[74px] transition-colors ease-out ${t.border} bg-inherit`}
          style={{ transitionDuration: 'var(--giop-theme-transition-ms, 650ms)' }}
        >
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <h1 className={`text-lg font-semibold tracking-wide ${t.text}`}>GIOP</h1>
            <p className={`text-xs ${t.muted}`}>Grid Intelligent Operating Platform</p>
          </motion.div>
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto px-6 pt-5 pb-4 space-y-5">
          {groups.map((group, groupIndex) => (
            <motion.div
              key={group.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 * groupIndex + 0.3 }}
            >
              <p className={`text-xs font-medium uppercase tracking-widest mb-2 ${t.mutedDim}`}>
                {group.label}
              </p>
              <div className="space-y-0.5">
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

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className={`px-6 py-3 border-t space-y-1.5 transition-colors ease-out ${t.border}`}
          style={{ transitionDuration: 'var(--giop-theme-transition-ms, 650ms)' }}
        >
          {footerLink && (
            <a
              href={footerLink.href}
              target="_blank"
              rel="noreferrer"
              className={`block px-3 py-1.5 text-sm rounded-md transition ${t.muted} ${
                isLightMode
                  ? 'hover:text-slate-900 hover:bg-slate-100'
                  : 'hover:text-premium-text hover:bg-premium-hover'
              }`}
            >
              {footerLink.label}
            </a>
          )}
        </motion.div>
      </motion.aside>

      <div
        className={`flex-1 min-w-0 flex flex-col transition-colors ease-out ${isLightMode ? 'bg-slate-50' : 'bg-premium-bg'}`}
        style={{ transitionDuration: 'var(--giop-theme-transition-ms, 650ms)' }}
      >
        <motion.header
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: ease.smooth }}
          className={`sticky top-0 z-30 backdrop-blur-md border-b shadow-premium-sm transition-colors ease-out ${t.header}`}
          style={{ transitionDuration: 'var(--giop-theme-transition-ms, 650ms)' }}
        >
          <div className="px-7 pt-3 pb-2">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <motion.div
                key={title}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3 }}
              >
                <h2 className={`text-xl font-light tracking-wide ${t.text}`}>{title}</h2>
                <p className={`text-xs mt-1 ${t.muted}`}>{subtitle}</p>
              </motion.div>
              <div className="flex items-center gap-3">
                {statusSlot}
                <span
                  className={`hidden h-5 w-px sm:block ${isLightMode ? 'bg-slate-200' : 'bg-premium-border/60'}`}
                  aria-hidden="true"
                />
                <GiopThemeToggle isLightMode={isLightMode} onThemeChange={onThemeChange} />
              </div>
            </div>
          </div>
        </motion.header>

        <div
          className={`flex-1 min-h-0 overflow-hidden transition-colors ease-out ${isLightMode ? 'bg-slate-50' : 'bg-premium-bg'}`}
          style={{ transitionDuration: 'var(--giop-theme-transition-ms, 650ms)' }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.main
              key={activeTab}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
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
      className={`group relative block w-full px-3 py-2 text-left text-sm border-l-2 rounded-r transition-colors duration-300 ease-out ${
        isActive
          ? isLightMode
            ? 'text-slate-900 border-premium-accent bg-slate-100'
            : 'text-premium-text border-premium-accent bg-premium-hover'
          : isLightMode
            ? 'text-slate-600 border-transparent hover:text-slate-900 hover:bg-slate-100'
            : 'text-premium-muted border-transparent hover:text-premium-text hover:bg-premium-hover'
      }`}
    >
      <AnimatePresence>
        {isActive && (
          <motion.div
            initial={{ scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            exit={{ scaleY: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className="absolute left-0 top-0 bottom-0 w-0.5 rounded-full origin-top bg-premium-accent"
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
