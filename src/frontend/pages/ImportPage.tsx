import { useState } from 'react';
import type { ImportPreview } from '../../types.ts';
import { useAuth } from '../AuthContext.tsx';

export default function ImportPage() {
  const { request } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [manual, setManual] = useState({ phone: '', name: '', externalId: '', notes: '' });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submitFilePreview() {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await request('/api/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'file', filename: file.name, contentBase64 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preview failed');
      setPreview(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setLoading(false);
    }
  }

  async function submitManualPreview() {
    setLoading(true);
    setError(null);
    try {
      const res = await request('/api/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'manual',
          rows: [manual],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preview failed');
      setPreview(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setLoading(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await request('/api/import/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: preview.token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Confirm failed');
      setSuccess(`${data.inserted} contacts imported`);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Confirm failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1>Import Contacts</h1>
      <p>Reimport creates new work only after removal of the current contact. Previous completed/failed work may use its remaining allowance; the phone budget and five-minute cooldown never reset. Exhausted numbers can be saved but cannot be called.</p>
      <div className="card">
        <h2>File Upload</h2>
        <input
          type="file"
          accept=".csv,.xlsx"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button onClick={() => void submitFilePreview()} disabled={!file || loading}>
          Preview File
        </button>
      </div>
      <div className="card">
        <h2>Manual Entry</h2>
        <input
          type="text"
          placeholder="Phone"
          value={manual.phone}
          onChange={(e) => setManual({ ...manual, phone: e.target.value })}
        />
        <input
          type="text"
          placeholder="Name"
          value={manual.name}
          onChange={(e) => setManual({ ...manual, name: e.target.value })}
        />
        <input
          type="text"
          placeholder="External ID"
          value={manual.externalId}
          onChange={(e) => setManual({ ...manual, externalId: e.target.value })}
        />
        <input
          type="text"
          placeholder="Notes"
          value={manual.notes}
          onChange={(e) => setManual({ ...manual, notes: e.target.value })}
        />
        <button onClick={() => void submitManualPreview()} disabled={!manual.phone || loading}>
          Preview Manual
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}
      {preview && (
        <div className="card">
          <h2>Preview</h2>
          <p>Valid: {preview.validCount} | Invalid: {preview.invalidCount} | Duplicates: {preview.duplicateCount} | Existing: {preview.existingCount}</p>
          {preview.unknownHeaders.length > 0 && (
            <p>Unknown headers: {preview.unknownHeaders.join(', ')}</p>
          )}
          <table>
            <thead>
              <tr>
                <th>Phone</th>
                <th>Name</th>
                <th>External ID</th>
                <th>Notes</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, idx) => (
                <tr key={idx}>
                  <td>{row.phone}</td>
                  <td>{row.name ?? '-'}</td>
                  <td>{row.externalId ?? '-'}</td>
                  <td>{row.notes ?? '-'}</td>
                  <td>
                    {!row.valid ? 'Invalid' : row.existing ? 'Existing' : row.duplicateOf != null ? 'Duplicate' : 'Valid'}
                    {!row.valid && row.error && <p role="note">{row.error}</p>}
                    {row.policyWarning && <p role="note">{row.policyWarning}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => void confirm()} disabled={preview.validCount === 0 || loading}>
            Confirm {preview.validCount} Contact{preview.validCount === 1 ? '' : 's'}
          </button>
        </div>
      )}
    </div>
  );
}
