import {
  Activity,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Route as RouteIcon,
  ScrollText,
  ShieldAlert,
  X,
} from 'lucide-react';
import * as React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Mark } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { useAuth } from '@/features/auth/auth-context';
import { cn } from '@/lib/utils';
import { HealthPill } from './health-pill';

const NAV = [
  { to: '/', label: 'Overview', Icon: LayoutDashboard, end: true },
  { to: '/traffic', label: 'Traffic', Icon: Activity },
  { to: '/anomalies', label: 'Anomalies', Icon: ShieldAlert },
  { to: '/api-keys', label: 'API keys', Icon: KeyRound },
  { to: '/routes', label: 'Routes', Icon: RouteIcon },
  { to: '/logs', label: 'Logs', Icon: ScrollText },
];

/**
 * Two-column shell: a fixed rail of destinations on the left, the page on the right. The rail
 * collapses behind a button below `lg`, which is the only layout change the dashboard makes.
 */
export function AppShell() {
  const { admin, logout } = useAuth();
  const [navOpen, setNavOpen] = React.useState(false);

  // Close the mobile rail on Escape, the same dismissal the reference popover uses.
  React.useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <div className="flex min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-zinc-950/20 backdrop-blur-[2px] lg:hidden dark:bg-black/50"
        />
      )}

      <nav
        aria-label="Sections"
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-[15rem] flex-col border-r border-zinc-950/[0.07] bg-white transition-transform dark:border-white/[0.07] dark:bg-zinc-900',
          'lg:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center justify-between px-3">
          <NavLink
            to="/"
            className="flex items-center gap-2 rounded-md px-1 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/70"
          >
            <Mark className="h-[22px] w-[22px]" />
            <span className="text-[14px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-50">
              Omni<span className="text-brand-600 dark:text-brand-400">Gate</span>
            </span>
          </NavLink>
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <ul className="flex flex-1 flex-col gap-0.5 px-2 py-2">
          {NAV.map(({ to, label, Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                onClick={() => setNavOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-chrome transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/70',
                    isActive
                      ? 'bg-brand-500/[0.10] font-medium text-brand-700 dark:bg-brand-500/[0.16] dark:text-brand-200'
                      : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.05] dark:hover:text-zinc-100',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      className={cn(
                        'h-4 w-4 shrink-0',
                        isActive ? 'text-brand-600 dark:text-brand-400' : 'text-zinc-400 dark:text-zinc-500',
                      )}
                      aria-hidden
                    />
                    {label}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="border-t border-zinc-950/[0.07] p-2 dark:border-white/[0.07]">
          <HealthPill />
          <div className="mt-2 flex items-center justify-between gap-2 px-1">
            <span
              className="min-w-0 truncate text-[12px] text-zinc-500 dark:text-zinc-400"
              title={admin?.email}
            >
              {admin?.email}
            </span>
            <Button variant="ghost" size="icon" onClick={logout} aria-label="Sign out" title="Sign out">
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-[15rem]">
        <div className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-zinc-950/[0.07] bg-zinc-50/85 px-4 backdrop-blur-md lg:hidden dark:border-white/[0.07] dark:bg-zinc-950/85">
          <Button variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
            <Menu className="h-4 w-4" />
          </Button>
          <Mark className="h-5 w-5" />
          <span className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-50">OmniGate</span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * Page frame: title on the left, controls on the right, content below. Every page uses it so the
 * heading rhythm never shifts between sections.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 hidden border-b border-zinc-950/[0.07] bg-zinc-50/85 backdrop-blur-md lg:block dark:border-white/[0.07] dark:bg-zinc-950/85">
      <div className="flex h-14 items-center justify-between gap-4 px-6">
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-50">
            {title}
          </h1>
          {description && (
            <p className="truncate text-[12px] text-zinc-500 dark:text-zinc-400">{description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

/** Mobile equivalent of PageHeader: the topbar already carries the brand, so this only adds context. */
export function MobilePageTitle({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 lg:hidden">
      <h1 className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-50">{title}</h1>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}
