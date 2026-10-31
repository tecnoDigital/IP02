import Retell from 'retell-sdk';
import type { Database } from '../db.ts';
import type { CallAttempt } from '../types.ts';

// Log only explicit schema values, never provider text or error messages.
const statuses = new Set(['registered', 'not_connected', 'ongoing', 'ended', 'error']);
const reasons = new Set([
  'user_hangup', 'agent_hangup', 'call_transfer', 'voicemail_reached', 'ivr_reached',
  'inactivity', 'max_duration_reached', 'concurrency_limit_reached', 'no_concurrency_fallback',
  'no_valid_payment', 'scam_detected', 'dial_busy', 'dial_failed', 'dial_no_answer',
  'invalid_destination', 'telephony_provider_permission_denied', 'telephony_provider_unavailable',
  'sip_routing_error', 'marked_as_spam', 'user_declined', 'error_llm_websocket_open',
  'error_llm_websocket_lost_connection', 'error_llm_websocket_runtime',
  'error_llm_websocket_corrupt_payload', 'error_no_audio_received', 'error_asr',
  'error_retell', 'error_unknown', 'error_user_not_joined', 'registered_call_timeout',
  'transfer_bridged', 'transfer_cancelled', 'manual_stopped', 'call_take_over',
]);
const outcomes = new Set([
  'reserved', 'dialing', 'active', 'indeterminate', 'no_answer', 'completed', 'failed',
  'pending', 'scheduled', 'exhausted',
]);
type Event = 'created' | 'creation_uncertain' | 'lifecycle' | 'recovery_found'
  | 'recovery_unresolved' | 'recovery_error' | 'recovery_resolved';
type Operation = 'create' | 'list' | 'retrieve';
const history = new WeakMap<Database, Map<string, string>>();

function allowed(value: unknown, values: Set<string>): string {
  return value == null ? 'unknown' : typeof value === 'string' && values.has(value) ? value : 'unknown';
}

function safeId(value: unknown): string {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)
    ? value : typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : 'unknown';
}

function cache(db: Database): Map<string, string> {
  let entries = history.get(db);
  if (!entries) { entries = new Map(); history.set(db, entries); }
  return entries;
}

function emit(db: Database, attempt: CallAttempt, channel: string, event: Event, fields: object): void {
  // Console failures must never change call state or escape into business error handling.
  try {
    const entries = cache(db);
    const key = `${attempt.id}:${channel}`;
    const line = JSON.stringify({ event: `retell.${event}`, attempt_id: safeId(attempt.id),
      call_id: safeId(attempt.retell_call_id), ...fields });
    if (entries.get(key) === line) return;
    console.log(line);
    entries.delete(key);
    entries.set(key, line);
    if (entries.size > 1024) entries.delete(entries.keys().next().value!);
  } catch { /* Best-effort diagnostics only. */ }
}

export function logCallState(
  db: Database, attempt: CallAttempt, callStatus: unknown, reason: unknown,
  outcome: unknown = attempt.status, contactOutcome?: unknown,
): void {
  emit(db, attempt, 'state', 'lifecycle', {
    call_status: allowed(callStatus, statuses),
    disconnection_reason: reason == null ? null : allowed(reason, reasons),
    outcome: allowed(outcome, outcomes),
    ...(contactOutcome === undefined ? {} : { contact_outcome: allowed(contactOutcome, outcomes) }),
  });
}

export function logCreated(db: Database, attempt: CallAttempt, callId: string, status: string): void {
  emit(db, { ...attempt, retell_call_id: callId }, 'create', 'created', {
    call_status: allowed(status, statuses),
  });
}

export function logRecovery(
  db: Database, attempt: CallAttempt, event: 'recovery_found' | 'recovery_unresolved',
): void {
  emit(db, attempt, 'recovery', event, {});
}

export function logRetellError(db: Database, attempt: CallAttempt, operation: Operation, err: unknown): void {
  try {
    const raw = err && typeof err === 'object' && 'status' in err ? err.status : undefined;
    const status = typeof raw === 'number' && Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : null;
    const classification = status !== null ? (status >= 500 ? 'server_error' : 'http_error')
      : err instanceof Retell.APIConnectionTimeoutError ? 'timeout'
      : err instanceof Retell.APIConnectionError ? 'connection_error' : 'unknown_error';
    emit(db, attempt, `error:${operation}`, operation === 'create' ? 'creation_uncertain' : 'recovery_error', {
      operation, http_status: status, classification,
    });
  } catch { /* Do not inspect arbitrary error properties further. */ }
}

export function logRecoverySuccess(db: Database, attempt: CallAttempt, operation: 'list' | 'retrieve'): void {
  try {
    if (!cache(db).delete(`${attempt.id}:error:${operation}`)) return;
    // Reset after each successful recovery so a later error/resolution is visible again.
    cache(db).delete(`${attempt.id}:resolved:${operation}`);
    emit(db, attempt, `resolved:${operation}`, 'recovery_resolved', { operation });
  } catch { /* Best-effort diagnostics only. */ }
}
