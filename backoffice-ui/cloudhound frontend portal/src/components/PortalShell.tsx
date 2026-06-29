import type { ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';
import type { GiopPortalTab } from '../lib/giopPortalRouting';

export interface PortalNavItem {
  id: GiopPortalTab;
  label: string;
  badge?: number;
}

export interface PortalNavGroup {
  label: string;
  items: PortalNavItem[];
}

interface PortalShellProps {
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

export function PortalShell({
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
}: PortalShellProps) {
  const groups: PortalNavGroup[] =
    navGroups ??
    (navItems ? [{ label: 'Navigation', items: navItems }] : []);

  const navButtonClass = (active: boolean) =>
    `block w-full px-3 py-1.5 text-left text-sm font-light border-l-2 rounded-r transition-colors ${
      active
        ? isLightMode
          ? 'text-slate-900 border-slate-700 bg-slate-100'
          : 'text-[#f2f6fd] border-[#526482] bg-[#1a2230]'
        : isLightMode
          ? 'text-slate-700 border-transparent hover:text-slate-900 hover:bg-slate-100'
          : 'text-[#a7b4ca] border-transparent hover:text-[#f2f6fd] hover:bg-[#1a2230]'
    }`;

  return (
    <div className={`h-screen overflow-hidden flex ${isLightMode ? 'bg-slate-50 text-slate-900' : 'bg-[#0a0f18] text-[#e8edf6]'}`}>
      <div className={`w-64 shrink-0 border-r flex flex-col overflow-hidden ${isLightMode ? 'border-slate-200 bg-white' : 'border-[#283246]/75 bg-[#0f141d]'}`}>
        <div className={`px-6 border-b flex items-center min-h-[74px] ${isLightMode ? 'border-slate-200 bg-white' : 'border-[#283246]/75 bg-[#0b111b]'}`}>
          <div>
            <h1 className={`text-lg font-semibold tracking-wide ${isLightMode ? 'text-slate-900' : 'text-[#eaf0fa]'}`}>GIOP</h1>
            <p className={`text-xs ${isLightMode ? 'text-slate-500' : 'text-[#93a0b8]'}`}>Grid Intelligent Operating Platform</p>
          </div>
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto px-6 pt-5 pb-4 space-y-5">
          {groups.map((group) => (
            <div key={group.label}>
              <p
                className={`text-xs font-light uppercase tracking-widest mb-2 ${isLightMode ? 'text-slate-500' : 'text-[#93a0b8]'}`}
              >
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onTabChange(item.id)}
                    className={navButtonClass(activeTab === item.id)}
                  >
                    <span className="flex items-center justify-between gap-2 w-full">
                      <span>{item.label}</span>
                      {item.badge != null && item.badge > 0 && (
                        <span
                          className={`min-w-[1.25rem] px-1.5 py-0.5 text-[10px] font-semibold rounded-full text-center leading-none ${
                            isLightMode ? 'bg-amber-600 text-white' : 'bg-amber-500 text-slate-950'
                          }`}
                          aria-label={`${item.badge} items need attention`}
                        >
                          {item.badge > 99 ? '99+' : item.badge}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className={`px-6 py-3 border-t space-y-1.5 ${isLightMode ? 'border-slate-200' : 'border-[#283246]/75'}`}>
          {footerLink && (
            <a
              href={footerLink.href}
              target="_blank"
              rel="noreferrer"
              className={`block px-3 py-1.5 text-sm font-light rounded transition-colors ${isLightMode ? 'text-slate-600 hover:text-slate-900 hover:bg-slate-100' : 'text-[#a7b4ca] hover:text-[#f2f6fd] hover:bg-[#1a2230]'}`}
            >
              {footerLink.label}
            </a>
          )}
        </div>
      </div>

      <div className={`flex-1 min-w-0 flex flex-col ${isLightMode ? 'bg-slate-50' : 'bg-[#0a0f18]'}`}>
        <div className={`sticky top-0 z-30 backdrop-blur-sm border-b ${isLightMode ? 'bg-slate-100/95 border-slate-200 shadow-[0_8px_20px_rgba(15,23,42,0.06)]' : 'bg-[#0f141d]/95 border-[#2a3447]/75 shadow-[0_8px_20px_rgba(0,0,0,0.32)]'}`}>
          <div className="px-7 pt-3 pb-2">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className={`text-xl font-light tracking-wide ${isLightMode ? 'text-slate-900' : 'text-[#eaf0fa]'}`}>{title}</h2>
                <p className={`text-xs mt-1 ${isLightMode ? 'text-slate-500' : 'text-[#a8b4ca]'}`}>{subtitle}</p>
              </div>
              <div className="flex items-center gap-4">
                {statusSlot}
                <button
                  type="button"
                  onClick={onToggleTheme}
                  className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border transition ${isLightMode ? 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100' : 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800'}`}
                  aria-label={isLightMode ? 'Switch to dark mode' : 'Switch to light mode'}
                >
                  {isLightMode ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className={`flex-1 min-h-0 overflow-hidden ${isLightMode ? 'bg-slate-50' : 'bg-[#0a0f18]'}`}>
          {children}
        </div>
      </div>
    </div>
  );
}
