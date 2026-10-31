import { parsePhoneNumberFromString } from 'libphonenumber-js';

const MEXICO_CALLING_CODE = '52';
const MEXICO_NATIONAL_LENGTH = 10;
// Accept digits, balanced area-code parentheses, and single separators, never arbitrary text.
const PHONE_SYNTAX = /^\+?(?:\d|\(\d+\))(?:\d|[.-]\d|\(\d+\))*$/;

export interface PhoneNormalization {
  valid: boolean;
  normalized: string;
  display: string;
}

function internationalCandidate(compact: string): string | null {
  if (compact.startsWith('+')) return compact;
  if (compact.length === MEXICO_NATIONAL_LENGTH) return `+${MEXICO_CALLING_CODE}${compact}`;
  if (compact.startsWith(MEXICO_CALLING_CODE) && compact.length === MEXICO_CALLING_CODE.length + MEXICO_NATIONAL_LENGTH) {
    return `+${compact}`;
  }
  return null;
}

// Successful results are E.164 and idempotent; invalid input is preserved, never repaired.
export function normalizePhone(raw: string): PhoneNormalization {
  const trimmed = String(raw ?? '').trim();
  const invalid = { valid: false, normalized: trimmed, display: trimmed };
  const withoutWhitespace = trimmed.replace(/\s+/g, '');
  if (!PHONE_SYNTAX.test(withoutWhitespace)) return invalid;
  const candidate = internationalCandidate(withoutWhitespace.replace(/[().-]/g, ''));
  if (!candidate) return invalid;
  if (candidate.startsWith(`+${MEXICO_CALLING_CODE}`) && candidate.length !== 1 + MEXICO_CALLING_CODE.length + MEXICO_NATIONAL_LENGTH) {
    return invalid;
  }
  const parsed = parsePhoneNumberFromString(candidate, { extract: false });
  if (!parsed || !parsed.isValid()) return invalid;
  return {
    valid: true,
    normalized: parsed.format('E.164'),
    display: parsed.formatInternational(),
  };
}

export function maskPhone(normalized: string): string {
  const digits = normalized.replace(/\D/g, '');
  if (digits.length <= 4) return '+' + '*'.repeat(digits.length);
  return '+' + '*'.repeat(digits.length - 4) + digits.slice(-4);
}
