import * as React from 'react';
import { Wordmark } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { ProblemAlert } from '@/components/ui/problem-alert';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { useAuth } from '@/features/auth/auth-context';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <div className="flex justify-end p-4">
        <ThemeToggle />
      </div>

      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh]">
        <div className="w-full max-w-[22rem]">
          <div className="flex flex-col items-center gap-3 text-center">
            <Wordmark />
            <p className="text-chrome text-zinc-500 dark:text-zinc-400">
              Sign in to the gateway control plane
            </p>
          </div>

          <form onSubmit={submit} className="surface mt-6 flex flex-col gap-3 p-4">
            {error != null && <ProblemAlert error={error} />}

            <Field
              id="email"
              label="Email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={setEmail}
              autoFocus
            />
            <Field
              id="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={setPassword}
            />

            <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-3 text-center text-[12px] text-zinc-400 dark:text-zinc-500">
            Credentials come from ADMIN_EMAIL and ADMIN_PASSWORD, set when the gateway was seeded.
          </p>
        </div>
      </main>
    </div>
  );
}

function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  autoFocus,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12px] font-medium text-zinc-600 dark:text-zinc-400">
        {label}
      </label>
      <input
        id={id}
        type={type}
        required
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-zinc-950/[0.09] bg-white px-2.5 text-chrome text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus-visible:border-brand-500/60 focus-visible:ring-2 focus-visible:ring-brand-500/30 dark:border-white/[0.09] dark:bg-white/[0.04] dark:text-zinc-100"
      />
    </div>
  );
}
