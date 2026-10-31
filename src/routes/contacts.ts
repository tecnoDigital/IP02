import { Router, type Request, type Response } from 'express';
import type { Database } from '../db.ts';
import type { AppConfig, SanitizedContact } from '../types.ts';
import { maskPhone } from '../services/phone.ts';
import { HttpError } from '../middleware/error-handler.ts';
import type { Queue } from '../services/queue.ts';

const REMOVAL_BLOCKED = 'Cannot remove a contact with an in-progress or unresolved call.';

export function createContactsRoutes(_config: AppConfig, db: Database, queue: Pick<Queue, 'running'>): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const rows = db.stmts.listVisibleContacts.all() as unknown as {
      id: string;
      status: string;
      phone_number_normalized: string;
      name: string | null;
      attempt_count: number;
      ready_at: string;
      active_attempt_id: string | null;
      revision: number;
    }[];

    const contacts: SanitizedContact[] = rows.map((row) => ({
      id: row.id,
      status: row.status as SanitizedContact['status'],
      phoneMasked: maskPhone(row.phone_number_normalized),
      name: row.name,
      attemptCount: Number(db.db.prepare('SELECT reservations FROM phone_policy WHERE phone=?').get(row.phone_number_normalized)?.reservations ?? 0),
      revision: row.revision,
      eligibilityReason: row.status === 'exhausted' ? 'Three reservations used for this number across all lifecycles. No further calls are allowed.' : row.status === 'scheduled' ? 'Retry scheduled by the backend; the five-minute cooldown is retained.' : null,
      readyAt: row.ready_at,
      latestResult: latestResultForContact(row.id, db),
      removalBlockedReason: db.stmts.getContactRemovalBlock.get(row.id) ? REMOVAL_BLOCKED : null,
    }));

    res.json({ contacts });
  });

  router.delete('/:id', (req: Request, res: Response) => {
    db.transaction(() => {
      // The shared queue and this transaction are synchronous: no start/tick can interleave.
      if (queue.running) throw new HttpError(409, 'Pause the queue before removing contacts.');
      const id = String(req.params.id);
      const contact = db.stmts.getContactById.get(id);
      if (!contact) {
        if (db.db.prepare("SELECT id FROM contact_audit_events WHERE contact_id=? AND event='removed'").get(id)) return;
        throw new HttpError(404, 'Contact not found');
      }
      if (db.stmts.getContactRemovalBlock.get(id)) throw new HttpError(409, REMOVAL_BLOCKED);
      if (req.body?.revision !== undefined && req.body.revision !== contact.revision) throw new HttpError(409, 'Contact changed. Refresh and review before removing.');
      db.stmts.deleteContact.run(id);
    });
    res.status(204).end();
  });

  return router;
}

function latestResultForContact(id: string, db: Database): SanitizedContact['latestResult'] {
  const status = db.db.prepare('SELECT status FROM call_attempts WHERE origin_contact_id=? ORDER BY attempt_number DESC LIMIT 1').get(id)?.status;
  return typeof status === 'string' && ['no_answer','completed','failed','indeterminate'].includes(status) ? status as SanitizedContact['latestResult'] : null;
}
