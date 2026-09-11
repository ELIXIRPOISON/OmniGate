import * as React from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from '@/lib/api';

interface AdminIdentity {
  id: string;
  email: string;
}

interface AuthValue {
  admin: AdminIdentity | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = React.createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [admin, setAdmin] = React.useState<AdminIdentity | null>(null);
  const [ready, setReady] = React.useState(false);

  const logout = React.useCallback(() => {
    setToken(null);
    setAdmin(null);
  }, []);

  // A 401 from anywhere in the app drops the session rather than leaving a half-signed-in shell.
  React.useEffect(() => {
    setUnauthorizedHandler(() => setAdmin(null));
  }, []);

  // Restore a session left in sessionStorage by verifying it, never by trusting it.
  React.useEffect(() => {
    let cancelled = false;
    if (!getToken()) {
      setReady(true);
      return;
    }
    api<AdminIdentity>('/admin/v1/auth/me')
      .then((me) => !cancelled && setAdmin(me))
      .catch(() => !cancelled && setToken(null))
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const login = React.useCallback(async (email: string, password: string) => {
    const result = await api<{ accessToken: string }>('/admin/v1/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setToken(result.accessToken);
    setAdmin(await api<AdminIdentity>('/admin/v1/auth/me'));
  }, []);

  const value = React.useMemo(() => ({ admin, ready, login, logout }), [admin, ready, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = React.useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
