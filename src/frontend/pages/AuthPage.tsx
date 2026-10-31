import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext.tsx';
import { safeReturnTo } from '../auth.ts';

export default function AuthPage() {
  const { status, signIn } = useAuth();
  const location = useLocation();
  const returnTo = safeReturnTo(new URLSearchParams(location.search).get('returnTo'));
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'authenticated') return <Navigate to={returnTo} replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await signIn(password);
    } catch (cause) {
      setError(cause instanceof TypeError ? 'Unable to connect. Please try again.' : cause instanceof Error ? cause.message : 'Unable to sign in. Please try again.');
    } finally {
      setPassword('');
      setPending(false);
    }
  }

  return <section className="auth-panel card" aria-labelledby="auth-title">
    <h1 id="auth-title">Sign in</h1>
    <p>Enter your operator password to continue. You will return to your previous page.</p>
    <form onSubmit={(event) => void submit(event)} aria-busy={pending}>
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password"
        required autoFocus value={password} disabled={pending}
        aria-describedby={error ? 'auth-error' : undefined} aria-invalid={!!error}
        onChange={(event) => setPassword(event.target.value)} />
      {error && <p id="auth-error" className="auth-error" role="alert">{error}</p>}
      <button type="submit" disabled={pending || !password}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form>
    <Link to={returnTo}>Back</Link>
  </section>;
}
