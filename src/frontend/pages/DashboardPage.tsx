import { useState, useEffect, useRef } from 'react';
import type { SanitizedContact } from '../../types.ts';
import { useAuth } from '../AuthContext.tsx';

export default function DashboardPage() {
  const { request } = useAuth();
  const [contacts, setContacts] = useState<SanitizedContact[]>([]);
  const [running, setRunning] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState<Record<string, boolean>>({});
  const [removalErrors, setRemovalErrors] = useState<Record<string, string>>({});
  const contactsRequest = useRef(0);
  const statusRequest = useRef(0);
  const queueUpdating = useRef(false);

  function removalReason(contact: SanitizedContact): string | null {
    if (running === null) return 'Waiting for the backend to confirm the queue is paused.';
    if (running) return 'Pause the queue before removing contacts.';
    return contact.removalBlockedReason ?? null;
  }

  async function removeContact(contact: SanitizedContact) {
    if (removing[contact.id] || removalReason(contact)) return;
    if (!window.confirm(`Remove ${contact.phoneMasked} from operational work? History is kept. Reimport creates a new contact identity, with the same remaining phone allowance and cooldown. Attempts are never reset.`)) return;
    setRemoving((current) => ({ ...current, [contact.id]: true }));
    setRemovalErrors((current) => ({ ...current, [contact.id]: '' }));
    try {
      const res = await request(`/api/contacts/${encodeURIComponent(contact.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: contact.revision }) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(res.status === 409 && typeof body.error === 'string'
          ? body.error : 'Unable to remove contact. Please try again.');
      }
      await fetchContacts();
    } catch (err) {
      setRemovalErrors((current) => ({ ...current, [contact.id]: err instanceof Error ? err.message : 'Unable to remove contact.' }));
      void fetchStatus();
      void fetchContacts();
    } finally {
      setRemoving((current) => ({ ...current, [contact.id]: false }));
    }
  }

  async function fetchStatus() {
    if (queueUpdating.current) return;
    const revision = ++statusRequest.current;
    setRunning(null);
    try {
      const res = await request('/api/queue/status');
      if (!res.ok) throw new Error('Failed to fetch queue status');
      const data = await res.json();
      if (typeof data.running !== 'boolean') throw new Error('Invalid queue status');
      if (revision === statusRequest.current) setRunning(data.running);
    } catch {
      if (revision === statusRequest.current) setError('Unable to load queue status');
    }
  }

  async function fetchContacts() {
    const revision = ++contactsRequest.current;
    setLoading(true);
    try {
      const res = await request('/api/contacts');
      if (!res.ok) throw new Error('Failed to fetch contacts');
      const data = await res.json();
      if (revision !== contactsRequest.current) return;
      setContacts(data.contacts ?? []);
      setError(null);
    } catch {
      if (revision === contactsRequest.current) setError('Unable to load contacts');
    } finally {
      if (revision === contactsRequest.current) setLoading(false);
    }
  }

  async function toggleQueue(start: boolean) {
    if (queueUpdating.current) return;
    queueUpdating.current = true;
    const revision = ++statusRequest.current;
    setRunning(null);
    try {
      const res = await request(`/api/queue/${start ? 'start' : 'pause'}`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to update queue');
      const data = await res.json();
      if (typeof data.running !== 'boolean') throw new Error('Invalid queue status');
      if (revision === statusRequest.current) setRunning(data.running);
    } catch {
      if (revision === statusRequest.current) setError('Unable to update queue');
    } finally {
      queueUpdating.current = false;
    }
  }

  useEffect(() => {
    fetchContacts();
    fetchStatus();
    const id = setInterval(() => {
      void fetchContacts();
      void fetchStatus();
    }, 5000);
    return () => clearInterval(id);
  }, [request]);

  return (
    <div>
      <h1>Dashboard</h1>
      <div className="card">
        <div className="queue-controls">
          <span>Queue: {running === null ? 'Loading / unknown' : running ? 'Running' : 'Paused'}</span>
          <button onClick={() => void toggleQueue(true)} disabled={running !== false}>
            Start
          </button>
          <button className="secondary" onClick={() => void toggleQueue(false)} disabled={running !== true}>
            Pause
          </button>
          <button className="secondary" onClick={() => {
            void fetchContacts();
            void fetchStatus();
          }}>
            Refresh
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <h2>Contacts</h2>
        {loading && contacts.length === 0 ? (
          <p>Loading...</p>
        ) : contacts.length === 0 ? (
          <p>No contacts yet. <a href="/import">Import contacts</a>.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Phone</th>
                <th>Name</th>
                <th>Status</th>
                <th>Phone reservations (max 3)</th>
                <th>Next</th>
                <th>Latest</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.phoneMasked}</td>
                  <td>{c.name ?? '-'}</td>
                  <td>{c.status}{c.eligibilityReason && <p>{c.eligibilityReason}</p>}<a href={`/history?contact=${encodeURIComponent(c.id)}`}>History</a></td>
                  <td>{c.attemptCount}</td>
                  <td>{c.readyAt ? new Date(c.readyAt).toLocaleString() : '-'}</td>
                  <td>{c.latestResult ?? '-'}</td>
                  <td className="contact-actions">
                    <span title={removalReason(c) ?? undefined}>
                      <button
                        type="button"
                        className="remove-contact"
                        aria-label={`Remove ${c.phoneMasked} from list`}
                        title={removalReason(c) || 'Remove from list'}
                        disabled={removing[c.id] || !!removalReason(c)}
                        aria-describedby={removalReason(c) ? `removal-blocked-${c.id}` : undefined}
                        onClick={() => void removeContact(c)}
                      ><span aria-hidden="true">×</span></button>
                    </span>
                    {removalReason(c) && <span className="visually-hidden" id={`removal-blocked-${c.id}`}>{removalReason(c)}</span>}
                    {removing[c.id] && <span role="status">Removing…</span>}
                    {removalErrors[c.id] && <div className="error" role="alert">{removalErrors[c.id]}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
