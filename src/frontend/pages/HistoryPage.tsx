import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../AuthContext.tsx';

interface HistoryEvent {
  id: number; contactId: string; phoneMasked: string; name: string | null;
  event: string; outcome: string | null; attemptId: string | null; reservations: number;
  readyAt: string | null; actor: string; occurredAt: string;
}

export default function HistoryPage() {
  const { request } = useAuth();
  const [params, setParams] = useSearchParams();
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const query = params.toString();
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    void request(`/api/history?${query}`).then(async response => {
      if (!response.ok) throw new Error('Unable to load history. Review filters and try again.');
      const body = await response.json();
      if (!cancelled) { setEvents(body.events); setNext(body.next); }
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : 'Unable to load history.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, request, refresh]);
  function filter(key: string, value: string) {
    const updated = new URLSearchParams(params);
    updated.delete('before');
    if (value) updated.set(key, value); else updated.delete(key);
    setParams(updated);
  }
  return <section>
    <h1>History</h1>
    <p>Read-only lifecycle history. Removing a contact does not remove history or restore its three-reservation phone allowance. Numbers are masked.</p>
    <div className="card history-filters">
      <label>Lifecycle ID <input value={params.get('contact') ?? ''} onChange={e => filter('contact', e.target.value)} /></label>
      <label>Event <select value={params.get('event') ?? ''} onChange={e => filter('event', e.target.value)}>
        <option value="">All events</option>{['created','reservation','state','attempt','callback','removed'].map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label>Outcome <select value={params.get('outcome') ?? ''} onChange={e => filter('outcome', e.target.value)}>
        <option value="">All outcomes</option>{['pending','reserved','dialing','active','no_answer','scheduled','completed','failed','exhausted','indeterminate'].map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label>From <input type="date" value={params.get('from') ?? ''} onChange={e => filter('from', e.target.value)} /></label>
      <label>To <input type="date" value={params.get('to') ?? ''} onChange={e => filter('to', e.target.value)} /></label>
      <button onClick={() => setParams({})}>Clear filters / newest</button>
      <button onClick={() => setRefresh(value => value + 1)}>Refresh history</button>
    </div>
    {loading ? <p role="status">Loading history…</p> : error ? <p role="alert">{error} <button onClick={() => setRefresh(value => value + 1)}>Try again</button></p> : <>
      {!events.length ? <p>No history matches these filters.</p> : <div className="card"><table>
        <thead><tr><th>When</th><th>Contact</th><th>Event</th><th>Outcome</th><th>Details</th></tr></thead>
        <tbody>{events.map(event => <tr key={event.id}>
          <td>{new Date(event.occurredAt).toLocaleString()}</td><td>{event.phoneMasked}<br />{event.name ?? 'Unnamed'}</td>
          <td>{event.event}</td><td>{event.outcome ?? 'Not available'}</td>
          <td><details><summary>Event {event.id}</summary>
            <p>Lifecycle: <a href={`/history?contact=${encodeURIComponent(event.contactId)}`}>{event.contactId}</a></p>
            <p>Attempt: {event.attemptId ?? 'Not applicable'}</p><p>Actor: {event.actor}</p>
            <p>Phone reservations at event: {event.reservations}/3</p>
            <p>Ready at: {event.readyAt ? new Date(event.readyAt).toLocaleString() : 'Not applicable'}</p>
            <p>Sanitized outcome: {event.outcome ?? 'Not available'}. Provider payloads, recordings and transcripts are not stored in history.</p>
          </details></td>
        </tr>)}</tbody>
      </table></div>}
      {next !== null && <button onClick={() => { const updated = new URLSearchParams(params); updated.set('before', String(next)); setParams(updated); }}>Older events (50 per page)</button>}
    </>}
  </section>;
}
