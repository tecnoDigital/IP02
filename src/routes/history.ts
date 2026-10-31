import { Router } from 'express';
import type { SQLInputValue } from 'node:sqlite';
import type { Database } from '../db.ts';
import { maskPhone } from '../services/phone.ts';
import { HttpError } from '../middleware/error-handler.ts';

export function createHistoryRoutes(db: Database): Router {
  const router = Router();
  router.get('/', (req, res) => {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [key, column] of [['contact', 'contact_id'], ['event', 'event'], ['outcome', 'outcome']] as const) {
      const value = req.query[key];
      if (value !== undefined) {
        if (typeof value !== 'string' || value.length > 100) throw new HttpError(400, 'Invalid history filter');
        where.push(`${column}=?`); params.push(value);
      }
    }
    for (const [key, operator] of [['from', '>='], ['to', '<=']] as const) {
      const value = req.query[key];
      if (value !== undefined) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new HttpError(400, 'Invalid history date');
        where.push(`occurred_at ${operator} ?`); params.push(`${value}T${key === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`);
      }
    }
    const before = req.query.before;
    if (before !== undefined) {
      if (typeof before !== 'string' || !/^\d{1,15}$/.test(before)) throw new HttpError(400, 'Invalid history cursor');
      where.push('id<?'); params.push(Number(before));
    }
    const rows = db.db.prepare(`SELECT * FROM contact_audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 51`).all(...params);
    const page = rows.slice(0, 50).map(row => ({
      id: Number(row.id), contactId: String(row.contact_id), phoneMasked: maskPhone(String(row.phone)),
      name: row.name, event: row.event, outcome: row.outcome, attemptId: row.attempt_id,
      reservations: row.reservations, readyAt: row.ready_at, actor: row.actor, occurredAt: row.occurred_at,
    }));
    res.json({ events: page, next: rows.length > 50 ? page.at(-1)!.id : null });
  });
  return router;
}
