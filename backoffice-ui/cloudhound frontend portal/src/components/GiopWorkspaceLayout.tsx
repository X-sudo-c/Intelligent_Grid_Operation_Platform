import type { ReactNode } from 'react';

interface GiopWorkspaceLayoutProps {
  children: ReactNode;
  sidePanel: ReactNode | null;
  sideOpen: boolean;
  /** Optional Tailwind width class for the side column (default: min 440px / 44vw). */
  sideWidthClass?: string;
}

export function GiopWorkspaceLayout({
  children,
  sidePanel,
  sideOpen,
  sideWidthClass = 'w-[min(440px,44vw)]',
}: GiopWorkspaceLayoutProps) {
  return (
    <div className="h-full min-h-0 flex">
      <div className={`flex-1 min-w-0 min-h-0 ${sideOpen ? 'overflow-auto' : 'overflow-hidden'}`}>
        {children}
      </div>
      {sideOpen && sidePanel && (
        <div className={`${sideWidthClass} shrink-0 min-h-0 flex flex-col`}>{sidePanel}</div>
      )}
    </div>
  );
}
