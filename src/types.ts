export type ContactStatus =
  | 'pending'
  | 'dialing'
  | 'active'
  | 'scheduled'
  | 'completed'
  | 'failed'
  | 'exhausted'
  | 'indeterminate';

export type AttemptStatus =
  | 'reserved'
  | 'dialing'
  | 'active'
  | 'completed'
  | 'failed'
  | 'no_answer'
  | 'indeterminate';

export interface Contact {
  id: string;
  phone_number_normalized: string;
  phone_number_display: string;
  name: string | null;
  external_id: string | null;
  notes: string | null;
  status: ContactStatus;
  attempt_count: number;
  ready_at: string;
  active_attempt_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallAttempt {
  id: string;
  contact_id: string | null;
  attempt_number: number;
  dispatch_token: string;
  retell_call_id: string | null;
  status: AttemptStatus;
  retell_call_status: string | null;
  disconnection_reason: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookEvent {
  id: string;
  dedupe_key: string;
  event_type: string;
  retell_call_id: string | null;
  received_at: string;
  processed_at: string | null;
  processing_error: string | null;
}

export interface SanitizedContact {
  id: string;
  status: ContactStatus;
  phoneMasked: string;
  name: string | null;
  attemptCount: number;
  revision?: number;
  eligibilityReason?: string | null;
  readyAt: string | null;
  latestResult: 'no_answer' | 'completed' | 'failed' | 'indeterminate' | null;
  removalBlockedReason?: string | null;
}

export interface ImportPreviewRow {
  phone: string;
  name: string | null;
  externalId: string | null;
  notes: string | null;
  normalized: string;
  valid: boolean;
  duplicateOf: number | null;
  existing: boolean;
  error: string | null;
  policyWarning?: string | null;
}

export interface ImportPreview {
  token: string;
  rows: ImportPreviewRow[];
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  existingCount: number;
  unknownHeaders: string[];
}

export interface QueueStatus {
  running: boolean;
  activeAttempt: {
    contactId: string;
    attemptNumber: number;
    status: AttemptStatus;
    retellCallId: string | null;
  } | null;
}

export interface AppConfig {
  port: number;
  databasePath: string;
  appBaseUrl: string;
  retellApiKey: string | undefined;
  retellWebhookKey: string | undefined;
  retellFromNumber: string | undefined;
  retellAgentId: string | undefined;
  adminPasswordHash: string | undefined;
  sessionSecret: string | undefined;
  activeCallStaleSeconds: number;
  importMaxBytes: number;
  importMaxRows: number;
  smoke: boolean;
  local?: boolean;
  host?: string;
}

export interface RetellCallCreated {
  call_id: string;
  call_status: string;
}

export interface RetellCallDetails {
  call_id: string;
  call_status: string;
  disconnection_reason: string | null | undefined;
  metadata?: Record<string, unknown>;
}
