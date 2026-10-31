export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return '/';
  try {
    const url = new URL(value, 'https://app.invalid');
    // Only existing page routes are valid destinations, never auth or API routes.
    if (url.origin !== 'https://app.invalid' || !['/', '/import', '/import/', '/history', '/history/'].includes(url.pathname)) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

export function signInPath(returnTo: string): string {
  return `/auth?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

export async function readSession(request: typeof fetch = fetch): Promise<boolean> {
  const response = await request('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to check your session. Please try again.');
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !('authenticated' in data) || typeof data.authenticated !== 'boolean') {
    throw new Error('Unable to check your session. Please try again.');
  }
  return data.authenticated;
}

export async function login(password: string, request: typeof fetch = fetch): Promise<void> {
  const response = await request('/api/auth/login', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  if (response.status === 401) throw new Error('Incorrect password. Please try again.');
  if (response.status === 503) throw new Error('Sign-in is not configured. Contact your administrator.');
  if (response.status !== 204) throw new Error('Unable to sign in. Please try again.');
  if (!await readSession(request)) throw new Error('Your session could not be established. Please allow cookies and try again.');
}

export async function logout(request: typeof fetch = fetch): Promise<void> {
  const response = await request('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  if (response.status !== 204) throw new Error('Unable to sign out. Please try again.');
}
