import { Monitor, Moon, Sun } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

type Theme = 'light' | 'dark' | 'system';
const KEY = 'omnigate.theme';

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

export function useTheme() {
  const [theme, setTheme] = React.useState<Theme>(() => {
    try {
      return (localStorage.getItem(KEY) as Theme) || 'system';
    } catch {
      return 'system';
    }
  });

  React.useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* private mode */
    }
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => apply('system');
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, [theme]);

  return { theme, setTheme };
}

const options: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

/** Three-state segmented control: explicit light, explicit dark, or follow the OS. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-md border border-zinc-950/[0.07] bg-zinc-100/70 p-0.5 dark:border-white/[0.07] dark:bg-white/[0.04]"
    >
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded transition-colors active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/70',
            theme === value
              ? 'bg-white text-zinc-900 shadow-sm dark:bg-white/[0.12] dark:text-zinc-50'
              : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100',
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </button>
      ))}
    </div>
  );
}
