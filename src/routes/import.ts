import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db.ts';
import type { AppConfig, ImportPreview } from '../types.ts';
import type { ImportPreviewRow } from '../services/import.ts';
import { HttpError } from '../middleware/error-handler.ts';
import * as importService from '../services/import.ts';
import { maskPhone } from '../services/phone.ts';

export function createImportRoutes(_config: AppConfig, db: Database): Router {
  const router = Router();
  const previewStore = new Map<string, { preview: ImportPreview; expires: number }>();

  router.post('/preview', (req: Request, res: Response) => {
    const { type, rows, filename, contentBase64 } = req.body ?? {};
    let result: { rows: ImportPreviewRow[]; unknownHeaders: string[] };

    const options = {
      maxRows: 10000,
      maxBytes: 1024 * 1024,
    };

    if (type === 'manual' && Array.isArray(rows)) {
      result = importService.parseManual(rows, options);
    } else if (type === 'file') {
      if (typeof contentBase64 !== 'string' || !contentBase64) {
        throw new HttpError(400, 'File content required');
      }
      const buffer = Buffer.from(contentBase64, 'base64');
      if (Buffer.byteLength(buffer) > options.maxBytes) {
        throw new HttpError(400, `File exceeds ${options.maxBytes} bytes`);
      }
      const name = typeof filename === 'string' ? filename.toLowerCase() : '';
      if (name.endsWith('.csv')) {
        result = importService.parseCsv(buffer, options);
      } else if (name.endsWith('.xlsx')) {
        result = importService.parseXlsx(buffer, options);
      } else {
        throw new HttpError(400, 'Unsupported file type; use .csv or .xlsx');
      }
    } else {
      throw new HttpError(400, 'Invalid import type');
    }

    const existingPhones = new Set(
      (db.stmts.listContacts.all() as unknown as { phone_number_normalized: string }[]).map(
        (c) => c.phone_number_normalized,
      ),
    );
    const deduped = importService.detectDuplicateAndExisting(result.rows, existingPhones);
    const token = importService.importPreviewToken();
    const preview = importService.buildPreview(deduped, result.unknownHeaders, token);
    for (const row of preview.rows) {
      const policy = db.db.prepare('SELECT * FROM phone_policy WHERE phone=?').get(row.normalized);
      if (policy) row.policyWarning = `${policy.reservations}/3 reservations already used across lifecycles. Reimport creates new work, not a reset. ${Number(policy.reservations) >= 3 ? 'Saved but non-callable: budget exhausted.' : `Remaining allowance and cooldown (${policy.retry_not_before}) are retained, including previously completed/failed work.`}`;
    }
    for (const [key, entry] of previewStore) if (entry.expires < Date.now()) previewStore.delete(key);
    if (previewStore.size >= 100) previewStore.delete(previewStore.keys().next().value!);
    previewStore.set(token, { preview, expires: Date.now() + 10 * 60_000 });
    res.json({ ...preview, rows: preview.rows.map(row => ({ ...row, phone: maskPhone(row.normalized), normalized: '', notes: null, externalId: null })) });
  });

  router.post('/confirm', (req: Request, res: Response) => {
    const { token } = req.body ?? {};
    if (typeof token !== 'string' || !token) {
      throw new HttpError(400, 'Preview token required');
    }
    const entry = previewStore.get(token);
    if (!entry || entry.expires < Date.now()) {
      throw new HttpError(400, 'Invalid or expired preview token');
    }

    const accepted = entry.preview.rows.filter((r) => r.valid && r.duplicateOf == null && !r.existing);
    const now = db.now();

    db.transaction(() => {
      for (const row of accepted) {
        if (db.stmts.getContactByPhone.get(row.normalized)) throw new HttpError(409, 'A current contact now uses this number. Preview again.');
        const policy = db.db.prepare('SELECT * FROM phone_policy WHERE phone=?').get(row.normalized);
        const used = Number(policy?.reservations ?? 0);
        const readyAt = policy && String(policy.retry_not_before) > now ? String(policy.retry_not_before) : now;
        db.stmts.insertContact.run(
          randomUUID(),
          row.normalized,
          row.phone,
          row.name,
          row.externalId,
          row.notes,
          used >= 3 ? 'exhausted' : readyAt > now ? 'scheduled' : 'pending',
          0,
          readyAt,
          null,
          now,
          now,
        );
      }
    });

    previewStore.delete(token);
    res.json({ inserted: accepted.length });
  });

  return router;
}
