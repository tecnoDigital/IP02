import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import type { ImportPreview, ImportPreviewRow } from '../types.ts';
export type { ImportPreviewRow };
import { normalizePhone, maskPhone } from './phone.ts';

export const KNOWN_HEADERS = ['phone_number', 'name', 'external_id', 'notes'];

export interface ParseOptions {
  maxRows: number;
  maxBytes: number;
}

export function sanitizeName(raw: string | null | undefined): string | null {
  const value = raw == null ? '' : String(raw).trim();
  if (!value) return null;
  if (value.length > 200) return value.slice(0, 200).trim();
  return value;
}

export function sanitizeString(raw: string | null | undefined, maxLength: number): string | null {
  const value = raw == null ? '' : String(raw).trim();
  if (!value) return null;
  if (value.length > maxLength) return value.slice(0, maxLength).trim();
  return value;
}

function canonicalHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_');
}

export function mapHeaders(rawHeaders: string[]): { mapped: Record<string, number>; unknown: string[] } {
  const mapped: Record<string, number> = {};
  const unknown: string[] = [];
  for (let i = 0; i < rawHeaders.length; i++) {
    const canonical = canonicalHeader(rawHeaders[i]);
    if (KNOWN_HEADERS.includes(canonical)) {
      if (canonical in mapped) throw new Error(`Duplicate ${canonical} column; keep only one column for this field`);
      mapped[canonical] = i;
    } else {
      unknown.push(rawHeaders[i].trim());
    }
  }
  return { mapped, unknown };
}

function createRow(
  phone: string,
  name: string | null,
  externalId: string | null,
  notes: string | null,
): ImportPreviewRow {
  const phoneResult = normalizePhone(phone);
  return {
    phone: maskPhone(phoneResult.normalized) || phone.trim(),
    name,
    externalId,
    notes,
    normalized: phoneResult.normalized,
    valid: phoneResult.valid,
    duplicateOf: null,
    existing: false,
    error: phoneResult.valid ? null : 'Invalid phone number. Use 10 Mexican digits (optionally prefixed with 52 or +52), or an international number starting with +.',
  };
}

function validateFileBuffer(buffer: Buffer, options: ParseOptions): void {
  if (Buffer.byteLength(buffer) > options.maxBytes) {
    throw new Error(`File exceeds ${options.maxBytes} bytes`);
  }
}

function createFileRow(values: Record<number, unknown>, mapped: Record<string, number>): ImportPreviewRow {
  const value = (header: string): string => String(values[mapped[header]] ?? '');
  const phone = value('phone_number');
  const name = value('name');
  const row = createRow(phone, sanitizeName(name), sanitizeString(value('external_id'), 200), sanitizeString(value('notes'), 2000));
  if (!row.valid) {
    row.error += ' The phone_number column must contain the phone number.';
    if (/^\p{L}[\p{L}\s.'’\-]*$/u.test(phone.trim()) && normalizePhone(name).valid) {
      row.error += ' The phone_number value looks like a name and the name value is a valid phone number; check for reversed name/phone_number data. Correct the file and preview again.';
    }
  }
  return row;
}

export function parseCsv(buffer: Buffer, options: ParseOptions): { rows: ImportPreviewRow[]; unknownHeaders: string[] } {
  validateFileBuffer(buffer, options);
  const text = stripBom(buffer.toString('utf8'));
  let headerMap = mapHeaders([]);
  const records = parse(text, {
    columns: (headers: string[]) => {
      headerMap = mapHeaders(headers);
      return headers.map((_header, index) => String(index));
    },
    skip_empty_lines: true,
    trim: true,
    bom: false,
  }) as Record<number, string>[];
  if (records.length > options.maxRows) {
    throw new Error(`Too many rows: ${records.length} > ${options.maxRows}`);
  }
  const { mapped, unknown } = headerMap;
  if (!('phone_number' in mapped)) {
    throw new Error('Missing phone_number column');
  }
  const rows = records.map((record) => createFileRow(record, mapped));
  return { rows, unknownHeaders: unknown };
}

export function parseXlsx(buffer: Buffer, options: ParseOptions): { rows: ImportPreviewRow[]; unknownHeaders: string[] } {
  validateFileBuffer(buffer, options);
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellNF: false, cellStyles: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) {
    throw new Error('No worksheet found');
  }
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][];
  if (raw.length === 0) {
    throw new Error('Empty worksheet');
  }
  const headerRow = raw[0].map((h) => String(h));
  const { mapped, unknown } = mapHeaders(headerRow);
  if (!('phone_number' in mapped)) {
    throw new Error('Missing phone_number column');
  }
  const dataRows = raw.slice(1);
  if (dataRows.length > options.maxRows) {
    throw new Error(`Too many rows: ${dataRows.length} > ${options.maxRows}`);
  }
  const rows = dataRows.map((row) => createFileRow(row, mapped));
  return { rows, unknownHeaders: unknown };
}

export function parseManual(rows: { phone: string; name?: string; externalId?: string; notes?: string }[], options: ParseOptions): { rows: ImportPreviewRow[]; unknownHeaders: string[] } {
  if (rows.length > options.maxRows) {
    throw new Error(`Too many rows: ${rows.length} > ${options.maxRows}`);
  }
  const parsed: ImportPreviewRow[] = rows.map((row) => {
    const name = sanitizeName(row.name);
    const externalId = sanitizeString(row.externalId, 200);
    const notes = sanitizeString(row.notes, 2000);
    return createRow(row.phone, name, externalId, notes);
  });
  return { rows: parsed, unknownHeaders: [] };
}

function stripBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

export function detectDuplicateAndExisting(
  rows: ImportPreviewRow[],
  existingPhones: Set<string>,
): ImportPreviewRow[] {
  const seen = new Map<string, number>();
  return rows.map((row, index) => {
    if (!row.valid) return row;
    if (existingPhones.has(row.normalized)) {
      return { ...row, existing: true, error: 'Existing contact' };
    }
    if (seen.has(row.normalized)) {
      return { ...row, duplicateOf: seen.get(row.normalized)! };
    }
    seen.set(row.normalized, index);
    return row;
  });
}

export function buildPreview(
  rows: ImportPreviewRow[],
  unknownHeaders: string[],
  token: string,
): ImportPreview {
  const validCount = rows.filter((r) => r.valid && r.duplicateOf == null && !r.existing).length;
  const invalidCount = rows.filter((r) => !r.valid).length;
  const duplicateCount = rows.filter((r) => r.duplicateOf != null).length;
  const existingCount = rows.filter((r) => r.existing).length;
  return {
    token,
    rows,
    validCount,
    invalidCount,
    duplicateCount,
    existingCount,
    unknownHeaders,
  };
}

export function importPreviewToken(): string {
  return randomUUID();
}

export function bufferFromStream(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      total += Buffer.byteLength(chunk);
      if (total > maxBytes) {
        reject(new Error(`Upload exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
