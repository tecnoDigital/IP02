import { useState } from 'react';
import { Routes, Route, Link, NavLink, Navigate, matchPath, useLocation } from 'react-router-dom';
import ImportPage from './pages/ImportPage.tsx';
import DashboardPage from './pages/DashboardPage.tsx';
import HistoryPage from './pages/HistoryPage.tsx';
import AuthPage from './pages/AuthPage.tsx';
import { AuthProvider, useAuth } from './AuthContext.tsx';
import { signInPath } from './auth.ts';

export default function App() {
  return <AuthProvider><AppContent /></AuthProvider>;
}

function AppContent() {
  const { status, refresh, signOut } = useAuth();
  const location = useLocation();
  const isAuthPage = matchPath('/auth', location.pathname) !== null;
  const destination = `${location.pathname}${location.search}${location.hash}`;
  const signIn = signInPath(destination);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    setSigningOut(true);
    setError(null);
    try { await signOut(); }
    catch { setError('Unable to sign out. Please try again.'); }
    finally { setSigningOut(false); }
  }

  return (
    <div className="app">
      {!isAuthPage && <nav className="nav" aria-label="Main navigation">
        <NavLink className="nav-link" to="/" end>Dashboard</NavLink>
        <NavLink className="nav-link" to="/import">Import</NavLink>
        <NavLink className="nav-link" to="/history">History</NavLink>
        {status === 'authenticated' ? <button className="nav-auth" onClick={() => void handleSignOut()} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button> : status === 'guest' && <Link className="nav-auth button-link" to={signIn}>Sign in</Link>}
      </nav>}
      <main>
        {error && <p role="alert">{error}</p>}
        {status === 'loading' ? <p role="status">Checking your session…</p> : status === 'error' ?
          <section className="card auth-panel"><h1>Session unavailable</h1><p role="alert">Unable to check your session. Please try again.</p><button onClick={refresh}>Try again</button></section> :
        <Routes>
          <Route path="/" element={status === 'authenticated' ? <DashboardPage /> :
            <section className="card auth-panel"><h1>Sequential dashboard</h1><p>Sign in to manage your contacts and call queue.</p><Link className="button-link" to={signIn}>Sign in</Link></section>} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/import" element={status === 'authenticated' ? <ImportPage /> : <Navigate to={signIn} replace />} />
          <Route path="/history" element={status === 'authenticated' ? <HistoryPage /> : <Navigate to={signIn} replace />} />
          <Route path="*" element={<section className="card"><h1>Page not found</h1><Link to="/">Back to dashboard</Link></section>} />
        </Routes>}
      </main>
    </div>
  );
}
