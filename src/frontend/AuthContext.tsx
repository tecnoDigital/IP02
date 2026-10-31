import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { readSession, login, logout } from './auth.ts';

type Status = 'loading' | 'authenticated' | 'guest' | 'error';
interface AuthState {
  status: Status;
  refresh: () => void;
  signIn: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
  request: typeof fetch;
}
const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus('loading');
    readSession().then(
      (authenticated) => { if (active) setStatus(authenticated ? 'authenticated' : 'guest'); },
      () => { if (active) setStatus('error'); },
    );
    return () => { active = false; };
  }, [revision]);

  const request: typeof fetch = useCallback(async (input, init) => {
    const response = await fetch(input, { ...init, credentials: 'same-origin' });
    if (response.status === 401) setStatus('guest');
    return response;
  }, []);

  return <AuthContext.Provider value={{
    status, request, refresh: () => setRevision((value) => value + 1),
    signIn: async (password) => { await login(password); setStatus('authenticated'); },
    signOut: async () => { await logout(); setStatus('guest'); },
  }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('AuthProvider is required');
  return auth;
}
