import { DatabaseSync, StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { AppConfig, Contact, CallAttempt, WebhookEvent } from './types.ts';

export interface PreparedStatements {
  insertContact: StatementSync;
  insertAttempt: StatementSync;
  getContactByPhone: StatementSync;
  getContactById: StatementSync;
  listContacts: StatementSync;
  listVisibleContacts: StatementSync;
  getContactRemovalBlock: StatementSync;
  deleteContact: StatementSync;
  updateContactStatus: StatementSync;
  updateContactActiveAttempt: StatementSync;
  updateAttemptStatus: StatementSync;
  updateAttemptCallId: StatementSync;
  getAttemptByCallId: StatementSync;
  getAttemptByToken: StatementSync;
  getAttemptById: StatementSync;
  getNonterminalAttempts: StatementSync;
  getReadyPendingContact: StatementSync;
  insertWebhookEvent: StatementSync;
  getWebhookEvent: StatementSync;
  listWebhookEventsForCall: StatementSync;
  getActiveAttempt: StatementSync;
}

function defaultDatabasePath(): string {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const dir = join(localAppData, 'ip2');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'ip2.db');
}

export function resolveDatabasePath(configPath?: string): string {
  if (configPath) return resolve(configPath);
  return defaultDatabasePath();
}

export class Database {
  readonly db: DatabaseSync;
  readonly stmts: PreparedStatements;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    try {
      this.initializeSchema();
      this.stmts = this.prepareStatements();
    } catch (error) { this.db.close(); throw error; }
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
  }

  static fromConfig(config: AppConfig): Database {
    return new Database(config.databasePath);
  }

  private initializeSchema(): void {
    const objects = this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (objects.length || version !== 0) {
      const required = ['contacts', 'call_attempts', 'phone_policy', 'contact_audit_events', 'webhook_events',
        'audit_no_update', 'audit_no_delete', 'attempt_origin_immutable', 'contact_created', 'contact_changed',
        'contact_removed', 'attempt_created', 'attempt_changed'];
      const contactColumns = this.db.prepare('PRAGMA table_info(contacts)').all();
      const attemptColumns = this.db.prepare('PRAGMA table_info(call_attempts)').all();
      const foreignKeys = this.db.prepare('PRAGMA foreign_key_list(call_attempts)').all();
      if (version !== 2 || required.some(name => !objects.some(row => row.name === name))
        || !contactColumns.some(column => column.name === 'revision') || contactColumns.some(column => column.name === 'deleted_at')
        || ['origin_contact_id','origin_phone','origin_name'].some(name => !attemptColumns.some(column => column.name === name))
        || !foreignKeys.some(key => key.from === 'contact_id' && key.table === 'contacts' && key.on_delete === 'SET NULL')) {
        throw new Error('Incompatible database schema. No migration or reset was performed. Configure DATABASE_PATH to an explicit clean new database; keep the existing database unchanged.');
      }
      return;
    }
    this.transaction(() => {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        phone_number_normalized TEXT NOT NULL UNIQUE,
        phone_number_display TEXT NOT NULL,
        name TEXT,
        external_id TEXT,
        notes TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','dialing','active','scheduled','completed','failed','exhausted','indeterminate')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 3),
        ready_at TEXT NOT NULL,
        active_attempt_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_contacts_ready ON contacts(status, ready_at, attempt_count);
      CREATE INDEX IF NOT EXISTS idx_contacts_active ON contacts(active_attempt_id);

      CREATE TABLE IF NOT EXISTS call_attempts (
        id TEXT PRIMARY KEY,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        origin_contact_id TEXT NOT NULL,
        origin_phone TEXT NOT NULL,
        origin_name TEXT,
        attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1 AND attempt_number <= 3),
        dispatch_token TEXT NOT NULL UNIQUE,
        retell_call_id TEXT UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('reserved','dialing','active','completed','failed','no_answer','indeterminate')),
        retell_call_status TEXT,
        disconnection_reason TEXT,
        started_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(origin_phone, attempt_number)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_attempts_call_id ON call_attempts(retell_call_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_token ON call_attempts(dispatch_token);
      CREATE INDEX IF NOT EXISTS idx_attempts_status ON call_attempts(status);

      CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        retell_call_id TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        processing_error TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_webhook_call ON webhook_events(retell_call_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_dedupe ON webhook_events(dedupe_key);
      CREATE TABLE phone_policy (
        phone TEXT PRIMARY KEY,
        reservations INTEGER NOT NULL DEFAULT 0 CHECK(reservations BETWEEN 0 AND 3),
        retry_not_before TEXT NOT NULL
      ) STRICT;
      CREATE TABLE contact_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        name TEXT,
        event TEXT NOT NULL,
        outcome TEXT,
        attempt_id TEXT,
        reservations INTEGER NOT NULL,
        ready_at TEXT,
        actor TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX audit_lifecycle ON contact_audit_events(contact_id, id);
      CREATE TRIGGER audit_no_update BEFORE UPDATE ON contact_audit_events BEGIN SELECT RAISE(ABORT, 'History is append-only'); END;
      CREATE TRIGGER audit_no_delete BEFORE DELETE ON contact_audit_events BEGIN SELECT RAISE(ABORT, 'History is append-only'); END;
      CREATE TRIGGER attempt_origin_immutable BEFORE UPDATE OF origin_contact_id, origin_phone, origin_name, attempt_number, dispatch_token ON call_attempts
      BEGIN SELECT RAISE(ABORT, 'Attempt attribution is immutable'); END;
      CREATE TRIGGER contact_created AFTER INSERT ON contacts BEGIN
        INSERT OR IGNORE INTO phone_policy VALUES(NEW.phone_number_normalized, 0, NEW.ready_at);
        INSERT INTO contact_audit_events(contact_id,phone,name,event,outcome,reservations,ready_at,actor,occurred_at)
        VALUES(NEW.id,NEW.phone_number_normalized,NEW.name,'created',NEW.status,(SELECT reservations FROM phone_policy WHERE phone=NEW.phone_number_normalized),NEW.ready_at,'operator',NEW.created_at);
      END;
      CREATE TRIGGER contact_changed AFTER UPDATE ON contacts
      WHEN NEW.status IS NOT OLD.status OR NEW.active_attempt_id IS NOT OLD.active_attempt_id OR NEW.ready_at IS NOT OLD.ready_at BEGIN
        UPDATE contacts SET revision=OLD.revision+1 WHERE id=NEW.id;
        INSERT INTO contact_audit_events(contact_id,phone,name,event,outcome,attempt_id,reservations,ready_at,actor,occurred_at)
        VALUES(NEW.id,NEW.phone_number_normalized,NEW.name,'state',NEW.status,NEW.active_attempt_id,(SELECT reservations FROM phone_policy WHERE phone=NEW.phone_number_normalized),NEW.ready_at,'backend',NEW.updated_at);
      END;
      CREATE TRIGGER contact_removed BEFORE DELETE ON contacts BEGIN
        INSERT INTO contact_audit_events(contact_id,phone,name,event,outcome,attempt_id,reservations,ready_at,actor,occurred_at)
        VALUES(OLD.id,OLD.phone_number_normalized,OLD.name,'removed',OLD.status,(SELECT id FROM call_attempts WHERE origin_contact_id=OLD.id ORDER BY attempt_number DESC LIMIT 1),(SELECT reservations FROM phone_policy WHERE phone=OLD.phone_number_normalized),OLD.ready_at,'operator',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER attempt_created AFTER INSERT ON call_attempts BEGIN
        UPDATE phone_policy SET reservations=max(reservations,NEW.attempt_number) WHERE phone=NEW.origin_phone;
        INSERT INTO contact_audit_events(contact_id,phone,name,event,outcome,attempt_id,reservations,actor,occurred_at)
        VALUES(NEW.origin_contact_id,NEW.origin_phone,NEW.origin_name,'reservation',NEW.status,NEW.id,NEW.attempt_number,'backend',NEW.created_at);
      END;
      CREATE TRIGGER attempt_changed AFTER UPDATE ON call_attempts WHEN NEW.status IS NOT OLD.status OR NEW.retell_call_id IS NOT OLD.retell_call_id BEGIN
        INSERT INTO contact_audit_events(contact_id,phone,name,event,outcome,attempt_id,reservations,actor,occurred_at)
        VALUES(NEW.origin_contact_id,NEW.origin_phone,NEW.origin_name,'attempt',NEW.status,NEW.id,NEW.attempt_number,'backend',NEW.updated_at);
      END;
      PRAGMA user_version=2;
    `);
    });
  }

  private prepareStatements(): PreparedStatements {
    return {
      insertContact: this.db.prepare(
        `INSERT INTO contacts (id, phone_number_normalized, phone_number_display, name, external_id, notes, status, attempt_count, ready_at, active_attempt_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      insertAttempt: this.db.prepare(
        `WITH input(id,contact_id,num,token,call_id,status,call_status,reason,started,ended,created,updated) AS (VALUES(?,?,?,?,?,?,?,?,?,?,?,?))
         INSERT INTO call_attempts (id, contact_id, attempt_number, dispatch_token, retell_call_id, status, retell_call_status, disconnection_reason, started_at, ended_at, created_at, updated_at, origin_contact_id, origin_phone, origin_name)
         SELECT i.*,c.id,c.phone_number_normalized,c.name FROM input i JOIN contacts c ON c.id=i.contact_id`
      ),
      getContactByPhone: this.db.prepare('SELECT * FROM contacts WHERE phone_number_normalized = ?'),
      getContactById: this.db.prepare('SELECT * FROM contacts WHERE id = ?'),
      listContacts: this.db.prepare('SELECT * FROM contacts ORDER BY created_at DESC'),
      listVisibleContacts: this.db.prepare('SELECT * FROM contacts ORDER BY created_at DESC'),
      getContactRemovalBlock: this.db.prepare(
        `SELECT id FROM contacts WHERE id = ? AND (
          EXISTS (SELECT 1 FROM contacts WHERE status IN ('dialing','active','indeterminate') OR active_attempt_id IS NOT NULL) OR EXISTS (
            SELECT 1 FROM call_attempts WHERE status IN ('reserved','dialing','active','indeterminate')
          )
        )`
      ),
      deleteContact: this.db.prepare('DELETE FROM contacts WHERE id = ?'),
      updateContactStatus: this.db.prepare(
        `UPDATE contacts SET status = ?, attempt_count = ?, ready_at = ?, active_attempt_id = ?, updated_at = ? WHERE id = ?`
      ),
      updateContactActiveAttempt: this.db.prepare(
        `UPDATE contacts SET active_attempt_id = ?, updated_at = ? WHERE id = ?`
      ),
      updateAttemptStatus: this.db.prepare(
        `UPDATE call_attempts SET status = ?, retell_call_status = ?, disconnection_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?`
      ),
      updateAttemptCallId: this.db.prepare(
        `UPDATE call_attempts SET retell_call_id = ?, retell_call_status = ?, status = ?, updated_at = ? WHERE id = ?`
      ),
      getAttemptByCallId: this.db.prepare('SELECT * FROM call_attempts WHERE retell_call_id = ?'),
      getAttemptByToken: this.db.prepare('SELECT * FROM call_attempts WHERE dispatch_token = ?'),
      getAttemptById: this.db.prepare('SELECT * FROM call_attempts WHERE id = ?'),
      getNonterminalAttempts: this.db.prepare(
        `SELECT * FROM call_attempts WHERE status IN ('reserved','dialing','active','indeterminate') ORDER BY created_at`
      ),
      getReadyPendingContact: this.db.prepare(
        `SELECT * FROM contacts
         WHERE status = 'pending'
           AND attempt_count < 3
           AND ready_at <= ?
         ORDER BY ready_at ASC, created_at ASC
         LIMIT 1`
      ),
      insertWebhookEvent: this.db.prepare(
        `INSERT INTO webhook_events (id, dedupe_key, event_type, retell_call_id, received_at, processed_at, processing_error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      getWebhookEvent: this.db.prepare('SELECT * FROM webhook_events WHERE dedupe_key = ?'),
      listWebhookEventsForCall: this.db.prepare(
        'SELECT * FROM webhook_events WHERE retell_call_id = ? ORDER BY received_at'
      ),
      getActiveAttempt: this.db.prepare(
        `SELECT ca.* FROM call_attempts ca
         WHERE ca.status IN ('reserved','dialing','active','indeterminate')`
      ),
    };
  }

  now(): string {
    return new Date().toISOString();
  }

  uuid(): string {
    return randomUUID();
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function rowToContact(row: Record<string, unknown>): Contact {
  return {
    id: String(row.id),
    phone_number_normalized: String(row.phone_number_normalized),
    phone_number_display: String(row.phone_number_display),
    name: row.name == null ? null : String(row.name),
    external_id: row.external_id == null ? null : String(row.external_id),
    notes: row.notes == null ? null : String(row.notes),
    status: String(row.status) as Contact['status'],
    attempt_count: Number(row.attempt_count),
    ready_at: String(row.ready_at),
    active_attempt_id: row.active_attempt_id == null ? null : String(row.active_attempt_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function rowToAttempt(row: Record<string, unknown>): CallAttempt {
  return {
    id: String(row.id),
    contact_id: row.contact_id == null ? null : String(row.contact_id),
    attempt_number: Number(row.attempt_number),
    dispatch_token: String(row.dispatch_token),
    retell_call_id: row.retell_call_id == null ? null : String(row.retell_call_id),
    status: String(row.status) as CallAttempt['status'],
    retell_call_status: row.retell_call_status == null ? null : String(row.retell_call_status),
    disconnection_reason: row.disconnection_reason == null ? null : String(row.disconnection_reason),
    started_at: row.started_at == null ? null : String(row.started_at),
    ended_at: row.ended_at == null ? null : String(row.ended_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function rowToWebhookEvent(row: Record<string, unknown>): WebhookEvent {
  return {
    id: String(row.id),
    dedupe_key: String(row.dedupe_key),
    event_type: String(row.event_type),
    retell_call_id: row.retell_call_id == null ? null : String(row.retell_call_id),
    received_at: String(row.received_at),
    processed_at: row.processed_at == null ? null : String(row.processed_at),
    processing_error: row.processing_error == null ? null : String(row.processing_error),
  };
}
