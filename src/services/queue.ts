import { randomUUID } from 'node:crypto';
import type { Database } from '../db.ts';
import type { AppConfig, CallAttempt, Contact, AttemptStatus } from '../types.ts';
import type { RetellClient } from './retell.ts';
import { logCallState, logCreated, logRecovery, logRetellError, logRecoverySuccess } from './retell-logging.ts';

const NONTERMINAL_STATUSES: AttemptStatus[] = ['reserved', 'dialing', 'active', 'indeterminate'];

export interface Queue {
  running: boolean;
  tick(): Promise<void>;
  start(): void;
  pause(): void;
}

export function createQueue(db: Database, retell: RetellClient, config: AppConfig): Queue {
  let ticking = false;
  const queue: Queue = {
    running: false,
    async tick() {
      if (!queue.running || ticking) return;
      ticking = true;
      try { await reconcileAndTick(db, retell, config, () => queue.running); }
      finally { ticking = false; }
    },
    start() {
      queue.running = true;
    },
    pause() {
      queue.running = false;
    },
  };
  return queue;
}

export function isNonterminal(status: AttemptStatus): boolean {
  return NONTERMINAL_STATUSES.includes(status);
}

export function claimNextContact(db: Database): Contact | null {
  if (db.db.prepare("SELECT id FROM contacts WHERE status IN ('dialing','active','indeterminate') OR active_attempt_id IS NOT NULL LIMIT 1").get()) return null;
  db.transaction(() => {
    const now = db.now();
    db.db.prepare("UPDATE contacts SET status='pending', updated_at=? WHERE status='scheduled' AND ready_at<=? AND phone_number_normalized IN (SELECT phone FROM phone_policy WHERE reservations<3 AND retry_not_before<=?)").run(now, now, now);
  });
  const active = db.stmts.getActiveAttempt.all() as unknown as CallAttempt[];
  if (active.length > 0) return null;
  const now = db.now();
  const row = db.stmts.getReadyPendingContact.get(now);
  if (!row) return null;
  return row as unknown as Contact;
}

export function reserveAttempt(db: Database, contact: Contact): CallAttempt {
  return db.transaction(() => {
    // Re-verify contact is still pending and no nonterminal attempt exists.
    const current = db.stmts.getContactById.get(contact.id);
    if (!current || (current as unknown as Contact).status !== 'pending') {
      throw new Error('Contact no longer pending');
    }
    const active = db.stmts.getActiveAttempt.all();
    if (active.length > 0) {
      throw new Error('Active slot occupied');
    }
    if (db.db.prepare("SELECT id FROM contacts WHERE status IN ('dialing','active','indeterminate') OR active_attempt_id IS NOT NULL LIMIT 1").get()) throw new Error('Unresolved contact blocks the active slot');

    const attemptId = db.uuid();
    const dispatchToken = randomUUID();
    const now = db.now();
    const phone = String(current.phone_number_normalized);
    const policy = db.db.prepare('SELECT * FROM phone_policy WHERE phone=?').get(phone);
    if (!policy || Number(policy.reservations) >= 3) throw new Error('Phone reservation budget exhausted');
    if (String(policy.retry_not_before) > now || String(current.ready_at) > now) throw new Error('Phone cooldown not elapsed');
    const attemptNumber = Number(policy.reservations) + 1;
    db.db.prepare('UPDATE phone_policy SET reservations=? WHERE phone=?').run(attemptNumber, phone);

    db.stmts.insertAttempt.run(
      attemptId,
      contact.id,
      attemptNumber,
      dispatchToken,
      null,
      'reserved',
      null,
      null,
      null,
      null,
      now,
      now,
    );

    db.stmts.updateContactStatus.run(
      'dialing',
      Number(current.attempt_count) + 1,
      now,
      attemptId,
      now,
      contact.id,
    );

    return {
      id: attemptId,
      contact_id: contact.id,
      attempt_number: attemptNumber,
      dispatch_token: dispatchToken,
      retell_call_id: null,
      status: 'reserved',
      retell_call_status: null,
      disconnection_reason: null,
      started_at: null,
      ended_at: null,
      created_at: now,
      updated_at: now,
    };
  });
}

export async function dispatchAttempt(
  db: Database,
  retell: RetellClient,
  attempt: CallAttempt,
  config: AppConfig,
): Promise<void> {
  const contact = db.stmts.getContactById.get(attempt.contact_id) as unknown as Contact | undefined;
  if (!contact) return;

  try {
    if (!config.retellFromNumber || !config.retellApiKey) {
      throw new Error('Retell not configured');
    }

    const created = await retell.createPhoneCall({
      fromNumber: config.retellFromNumber,
      toNumber: contact.phone_number_normalized,
      agentId: config.retellAgentId,
      metadata: { dispatch_token: attempt.dispatch_token },
    });

    logCreated(db, attempt, created.call_id, created.call_status);

    const now = db.now();
    db.transaction(() => {
      const current = db.stmts.getAttemptById.get(attempt.id);
      if (!current) return;
      // A signed final callback may have won the race with create-call's response.
      db.stmts.updateAttemptCallId.run(created.call_id, created.call_status, isNonterminal(current.status as AttemptStatus) ? 'dialing' : String(current.status), now, attempt.id);
    });
  } catch (err) {
    logRetellError(db, attempt, 'create', err);
    const now = db.now();
    setUncertain(db, attempt, null, now);
    throw err;
  }
}

export async function reconcileAndTick(
  db: Database,
  retell: RetellClient,
  config: AppConfig,
  canClaim = () => true,
): Promise<void> {
  // Recovery: reconcile any nonterminal attempts before claiming new work.
  const nonterminal = db.stmts.getNonterminalAttempts.all() as unknown as CallAttempt[];
  for (const attempt of nonterminal) {
    await reconcileAttempt(db, retell, attempt, config);
  }

  if (canClaim() && db.stmts.getNonterminalAttempts.all().length === 0) {
    const contact = claimNextContact(db);
    if (contact) {
      const attempt = reserveAttempt(db, contact);
      await dispatchAttempt(db, retell, attempt, config);
    }
  }
}

export async function reconcileAttempt(
  db: Database,
  retell: RetellClient,
  attempt: CallAttempt,
  config: AppConfig,
): Promise<void> {
  if (!isNonterminal(attempt.status)) return;

  const staleThreshold = new Date(Date.now() - config.activeCallStaleSeconds * 1000).toISOString();

  // If the attempt is reserved without a call_id, check List Calls by dispatch_token.
  if (attempt.status === 'reserved' && !attempt.retell_call_id) {
    try {
      const matches = await retell.listCallsByMetadata('dispatch_token', attempt.dispatch_token);
      logRecoverySuccess(db, attempt, 'list');
      if (matches.length > 0) {
        const match = matches[0];
        const now = db.now();
        const found = db.transaction(() => {
          const current = db.stmts.getAttemptById.get(attempt.id);
          if (!current || !isNonterminal(current.status as AttemptStatus)) return false;
          db.stmts.updateAttemptCallId.run(match.call_id, match.call_status, 'dialing', now, attempt.id);
          return true;
        });
        if (!found) return;
        attempt.retell_call_id = match.call_id;
        attempt.status = 'dialing';
        logRecovery(db, attempt, 'recovery_found');
      } else {
        // Cannot prove non-creation. Block queue.
        const now = db.now();
        setUncertain(db, attempt, null, now);
        logRecovery(db, attempt, 'recovery_unresolved');
        return;
      }
    } catch (err) {
      logRetellError(db, attempt, 'list', err);
      // Leave as-is, will retry next tick.
      return;
    }
  }

  // If we have a call_id, use Get Call for final status.
  if (attempt.retell_call_id) {
    try {
      const details = await retell.retrieveCall(attempt.retell_call_id);
      logRecoverySuccess(db, attempt, 'retrieve');
      const finalReason = details.disconnection_reason;
      const isFinal = ['ended', 'error', 'not_connected'].includes(details.call_status) || finalReason != null;
      if (isFinal && finalReason) {
        finalizeAttempt(db, attempt, details.call_status, finalReason);
      } else if (attempt.updated_at < staleThreshold && ['dialing', 'active'].includes(attempt.status)) {
        const now = db.now();
        setUncertain(db, attempt, details.call_status, now);
        logPersistedAttempt(db, attempt.id, details.call_status, finalReason);
      } else {
        logPersistedAttempt(db, attempt.id, details.call_status, finalReason);
      }
    } catch (err) {
      logRetellError(db, attempt, 'retrieve', err);
      // Leave as-is, will retry next tick.
    }
  }
}

export function finalizeAttempt(
  db: Database,
  attempt: CallAttempt,
  callStatus: string,
  disconnectionReason: string,
  log = true,
): void {
  db.transaction(() => {
  const validated = classifyDisconnectionReason(disconnectionReason);
  const now = db.now();

  const current = db.stmts.getAttemptById.get(attempt.id) as unknown as CallAttempt | undefined;
  if (!current || !isNonterminal(current.status)) return;
  const contact = current.contact_id ? db.stmts.getContactById.get(current.contact_id) : undefined;
  const count = Number(db.db.prepare('SELECT count(*) AS count FROM call_attempts WHERE origin_contact_id=?').get(String(db.stmts.getAttemptById.get(current.id)!.origin_contact_id))?.count ?? 0);
  const origin = db.stmts.getAttemptById.get(current.id)!;
  const used = Number(db.db.prepare('SELECT reservations FROM phone_policy WHERE phone=?').get(String(origin.origin_phone))?.reservations ?? current.attempt_number);

  if (validated === 'no_answer') {
    if (used >= 3) {
      db.stmts.updateAttemptStatus.run('no_answer', callStatus, disconnectionReason, now, now, attempt.id);
      if (contact) db.stmts.updateContactStatus.run('exhausted', count, now, null, now, current.contact_id);
    } else {
      const readyAt = new Date(Date.parse(now) + 5 * 60 * 1000).toISOString();
      db.db.prepare('UPDATE phone_policy SET retry_not_before=? WHERE phone=?').run(readyAt, String(origin.origin_phone));
      db.stmts.updateAttemptStatus.run('no_answer', callStatus, disconnectionReason, now, now, attempt.id);
      if (contact) db.stmts.updateContactStatus.run('scheduled', count, readyAt, null, now, current.contact_id);
    }
  } else if (validated === 'completed') {
    db.stmts.updateAttemptStatus.run('completed', callStatus, disconnectionReason, now, now, attempt.id);
    if (contact) db.stmts.updateContactStatus.run('completed', count, now, null, now, current.contact_id);
  } else if (validated === 'failed') {
    db.stmts.updateAttemptStatus.run('failed', callStatus, disconnectionReason, now, now, attempt.id);
    if (contact) db.stmts.updateContactStatus.run('failed', count, now, null, now, current.contact_id);
  } else {
    db.stmts.updateAttemptStatus.run('indeterminate', callStatus, disconnectionReason, now, now, attempt.id);
    if (contact) db.stmts.updateContactStatus.run('indeterminate', count, now, attempt.id, now, current.contact_id);
  }
  });
  if (log) logPersistedAttempt(db, attempt.id);
}

function setUncertain(db: Database, attempt: CallAttempt, status: string | null, now: string): void {
  db.transaction(() => {
    const current = db.stmts.getAttemptById.get(attempt.id);
    if (!current || !isNonterminal(current.status as AttemptStatus)) return;
    db.stmts.updateAttemptStatus.run('indeterminate', status, null, null, now, attempt.id);
    const contact = current.contact_id ? db.stmts.getContactById.get(String(current.contact_id)) : undefined;
    if (contact) db.stmts.updateContactStatus.run('indeterminate', Number(contact.attempt_count), now, attempt.id, now, String(contact.id));
  });
}

export function logPersistedAttempt(db: Database, attemptId: string, callStatus?: string, reason?: string | null): void {
  try {
    const attempt = db.stmts.getAttemptById.get(attemptId) as unknown as CallAttempt | undefined;
    if (!attempt) return;
    const contact = db.stmts.getContactById.get(attempt.contact_id) as unknown as Contact | undefined;
    logCallState(db, attempt, callStatus ?? attempt.retell_call_status,
      reason === undefined ? attempt.disconnection_reason : reason, attempt.status, contact?.status);
  } catch { /* Diagnostics cannot affect committed business state. */ }
}

export const VALIDATED_NO_ANSWER_REASONS = new Set(['dial_no_answer']);

export const VALIDATED_COMPLETED_REASONS = new Set([
  'user_hangup',
  'agent_hangup',
  'call_transfer',
  'voicemail_reached',
  'inactivity',
  'max_duration_reached',
  'ivr_disconnected',
  'voicemail_user_hangup',
  'voicemail_end',
]);

export const VALIDATED_FAILED_REASONS = new Set([
  'dial_busy',
  'dial_failed',
  'invalid_destination',
  'telephony_provider_permission_denied',
  'telephony_provider_unavailable',
  'sip_routing_error',
  'marked_as_spam',
  'user_declined',
  'concurrency_limit_reached',
  'error_unexpected',
  'error_no_audio',
  'error_asr',
]);

export type FinalClassification = 'no_answer' | 'completed' | 'failed' | 'indeterminate';

export function classifyDisconnectionReason(reason: string): FinalClassification {
  if (VALIDATED_NO_ANSWER_REASONS.has(reason)) return 'no_answer';
  if (VALIDATED_COMPLETED_REASONS.has(reason)) return 'completed';
  if (VALIDATED_FAILED_REASONS.has(reason)) return 'failed';
  return 'indeterminate';
}
