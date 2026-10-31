import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';

const PAGE_SIZE = 50;
const MAX_PAGES = 3;
const TIMEOUT_MS = 10_000;

// Current schema: https://docs.retellai.com/api-references/list-calls
// Use REST directly: this diagnostic must never import the app or place calls.
class CheckError extends Error {}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export async function checkRetell(apiKey: string | undefined, request: typeof fetch = fetch) {
  if (!apiKey?.trim()) throw new CheckError('RETELL_API_KEY is required.');
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let calls = 0;
  let durationCalls = 0;
  let durationMs = 0;
  let costCalls = 0;
  let costCents = 0;
  let historyComplete = false;
  let pages = 0;

  for (; pages < MAX_PAGES;) {
    let data: unknown;
    try {
      const response = await request('https://api.retellai.com/v3/list-calls', {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: PAGE_SIZE, sort_order: 'descending', include_total: false,
          ...(cursor === undefined ? {} : { pagination_key: cursor }) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status !== 200) {
        const reason = response.status === 401 ? 'Authentication failed (HTTP 401).'
          : response.status === 403 ? 'History permission denied (HTTP 403).'
          : response.status === 429 ? 'Rate limited (HTTP 429); retry later.'
          : 'Retell returned an unsuccessful HTTP status.';
        // Never read or log error bodies: they may contain sensitive data.
        await response.body?.cancel();
        throw new CheckError(reason);
      }
      data = await response.json();
    } catch (error) {
      if (error instanceof CheckError) throw error;
      // Do not expose exceptions, headers, URLs, credentials, or response bodies.
      throw new CheckError('Retell request failed: network, timeout, or invalid JSON response.');
    }
    if (!object(data) || !Array.isArray(data.items) || typeof data.has_more !== 'boolean'
      || data.items.length > PAGE_SIZE) {
      throw new CheckError('Unexpected Retell history response schema.');
    }
    for (const call of data.items) {
      if (!object(call) || typeof call.call_id !== 'string' || !call.call_id) {
        throw new CheckError('Unexpected Retell call response schema.');
      }
      if (ids.has(call.call_id)) continue;
      ids.add(call.call_id);
      calls++;
      if (nonnegative(call.duration_ms)) {
        durationCalls++;
        durationMs += call.duration_ms;
      }
      if (object(call.call_cost) && nonnegative(call.call_cost.combined_cost)) {
        costCalls++;
        costCents += call.call_cost.combined_cost;
      }
    }
    pages++;
    if (!data.has_more) {
      historyComplete = true;
      break;
    }
    if (typeof data.pagination_key !== 'string' || !data.pagination_key
      || cursors.has(data.pagination_key)) {
      throw new CheckError('Invalid or repeated Retell pagination cursor.');
    }
    cursor = data.pagination_key;
    cursors.add(cursor);
  }
  return {
    api: 'ok',
    usageEvidence: calls > 0 ? 'history_present' : 'no_history_usage_not_proven',
    scope: historyComplete ? 'available_history_exhausted' : 'latest_calls_sample_page_cap_reached',
    note: 'Retained history visible to this key only; not billing, credits, or lifetime usage. No snapshot guarantee.',
    limits: { pageSize: PAGE_SIZE, maxPages: MAX_PAGES, timeoutMs: TIMEOUT_MS, retries: 0 },
    pages,
    calls,
    duration: { knownMinutes: durationCalls ? durationMs / 60_000 : null,
      callsWithDuration: durationCalls, callsWithUnknownDuration: calls - durationCalls },
    cost: { knownSubtotalCents: costCalls ? costCents : null,
      callsWithCost: costCalls, callsWithUnknownCost: calls - costCalls,
      note: 'Missing costs are unknown, not zero. Known subtotal is not an invoice total.' },
  };
}

export async function runCheck(apiKey: string | undefined, request: typeof fetch = fetch,
  output: (message: string) => void = console.log,
  errorOutput: (message: string) => void = console.error): Promise<number> {
  try {
    output(JSON.stringify(await checkRetell(apiKey, request), null, 2));
    return 0;
  } catch (error) {
    errorOutput(error instanceof CheckError ? error.message : 'Retell check failed.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Runtime loading only; never print dotenv's parsed values or errors.
  dotenv.config();
  process.exitCode = await runCheck(process.env.RETELL_API_KEY);
}
