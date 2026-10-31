import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { Database } from '../db.ts';
import type { AppConfig } from '../types.ts';
import { finalizeAttempt, isNonterminal, logPersistedAttempt } from '../services/queue.ts';
import { rowToAttempt } from '../db.ts';

export function createWebhookRoutes(config: AppConfig, db: Database): Router {
  const router = Router();

  router.post('/retell', (req: Request, res: Response) => {
    if (!config.retellWebhookKey) {
      res.status(503).json({ error: 'Webhook not configured' });
      return;
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      res.status(400).json({ error: 'Empty body' });
      return;
    }

    const signature = req.headers['x-retell-signature'];
    if (typeof signature !== 'string' || !verifySignature(rawBody, signature, config.retellWebhookKey)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }

    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    const event = 'event' in payload ? String(payload.event) : '';
    const call = 'call' in payload && payload.call && typeof payload.call === 'object' ? payload.call : null;
    const callId = call && 'call_id' in call ? String(call.call_id) : null;

    if (!event || !callId) {
      res.status(400).json({ error: 'Missing event or call_id' });
      return;
    }
    if (event.length > 64 || callId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(callId)) {
      res.status(400).json({ error: 'Invalid correlation fields' }); return;
    }

    const dedupeKey = `${event}:${callId}`;
    const now = db.now();
    let changedAttemptId: string | undefined;
    let observedStatus: string | undefined;
    let observedReason: string | null | undefined;

    db.transaction(() => {
      const existing = db.stmts.getWebhookEvent.get(dedupeKey);
      if (existing) {
        // Duplicate is harmless; acknowledge without reprocessing.
        return;
      }

      db.stmts.insertWebhookEvent.run(randomUUID(), dedupeKey, event, callId, now, now, null);
      const observed = db.stmts.getAttemptByCallId.get(callId);
      if (observed) {
        db.db.prepare(`INSERT INTO contact_audit_events(contact_id,phone,name,event,outcome,attempt_id,reservations,actor,occurred_at)
          VALUES(?,?,?,'callback',?,?,?,?,?)`).run(String(observed.origin_contact_id), String(observed.origin_phone), observed.origin_name, String(observed.status), String(observed.id), Number(observed.attempt_number), 'provider', now);
      }

      if (event === 'call_started') {
        const attempt = findAttemptByCallId(db, callId);
        if (attempt && isNonterminal(attempt.status)) {
          const callStatus = call && 'call_status' in call ? String(call.call_status) : null;
          db.stmts.updateAttemptStatus.run('active', callStatus, null, null, now, attempt.id);
          const contact = attempt.contact_id ? db.stmts.getContactById.get(attempt.contact_id) as Record<string, unknown> | undefined : undefined;
          const readyAt = contact ? String(contact.ready_at) : now;
          if (contact) db.stmts.updateContactStatus.run('active', Number(contact.attempt_count), readyAt, attempt.id, now, attempt.contact_id);
          changedAttemptId = attempt.id;
        }
      } else if (event === 'call_ended' || event === 'call_analyzed') {
        const attempt = findAttemptByCallId(db, callId);
        if (attempt) {
          const callStatus = call && 'call_status' in call ? String(call.call_status) : 'ended';
          const reason = call && 'disconnection_reason' in call ? String(call.disconnection_reason) : null;
          if (reason && isNonterminal(attempt.status)) {
            finalizeAttempt(db, attempt, callStatus, reason, false);
          }
          changedAttemptId = attempt.id;
          observedStatus = callStatus;
          observedReason = reason;
        }
      }
    });

    // Emit only after the webhook transaction commits, never for duplicate deliveries.
    if (changedAttemptId) logPersistedAttempt(db, changedAttemptId, observedStatus, observedReason);

    res.status(204).send();
  });

  return router;
}

function verifySignature(rawBody: Buffer, signature: string, key: string): boolean {
  const prefix = 'v=';
  if (!signature.startsWith(prefix)) return false;
  const commaIndex = signature.indexOf(',d=');
  if (commaIndex === -1) return false;
  const timestampStr = signature.slice(prefix.length, commaIndex);
  const digestHex = signature.slice(commaIndex + 3);
  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp)) return false;

  const nowMs = Date.now();
  if (Math.abs(nowMs - timestamp) > 5 * 60 * 1000) return false;

  const expected = createHmac('sha256', key).update(rawBody).update(timestampStr).digest('hex');
  if (expected.length !== digestHex.length) return false;

  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(digestHex, 'hex'));
  } catch {
    return false;
  }
}

function findAttemptByCallId(db: Database, callId: string) {
  const row = db.stmts.getAttemptByCallId.get(callId);
  if (!row) return null;
  return rowToAttempt(row as Record<string, unknown>);
}
