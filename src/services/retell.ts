import Retell from 'retell-sdk';
import type { AppConfig, RetellCallCreated, RetellCallDetails } from '../types.ts';

export interface RetellClient {
  createPhoneCall(args: {
    fromNumber: string;
    toNumber: string;
    agentId?: string;
    metadata: Record<string, string>;
  }): Promise<RetellCallCreated>;
  retrieveCall(callId: string): Promise<RetellCallDetails>;
  listCallsByMetadata(key: string, value: string): Promise<RetellCallDetails[]>;
}

export function createRetellClient(config: AppConfig): RetellClient {
  if (!config.retellApiKey) {
    return createMockRetellClient();
  }

  const client = new Retell({
    apiKey: config.retellApiKey,
    maxRetries: 0,
    timeout: 60000,
  });

  return {
    async createPhoneCall({ fromNumber, toNumber, agentId, metadata }) {
      const body: Record<string, unknown> = {
        from_number: fromNumber,
        to_number: toNumber,
        metadata,
      };
      if (agentId) {
        body.override_agent_id = agentId;
      }
      const response = (await client.call.createPhoneCall(body as any)) as {
        call_id: string;
        call_status: string;
      };
      return {
        call_id: response.call_id,
        call_status: response.call_status,
      };
    },

    async retrieveCall(callId: string) {
      const response = (await client.call.retrieve(callId)) as {
        call_id: string;
        call_status: string;
        disconnection_reason?: string | null;
        metadata?: Record<string, unknown>;
      };
      return {
        call_id: response.call_id,
        call_status: response.call_status,
        disconnection_reason: response.disconnection_reason,
        metadata: response.metadata,
      };
    },

    async listCallsByMetadata(key: string, value: string) {
      const response = (await client.call.list({
        filter_criteria: {
          metadata: [
            { key, op: 'eq', value },
          ],
        },
      } as any)) as unknown;
      const calls = Array.isArray((response as { calls?: unknown[] }).calls) ? (response as { calls: unknown[] }).calls : [];
      return calls.map((c: any) => ({
        call_id: String(c.call_id ?? ''),
        call_status: String(c.call_status ?? ''),
        disconnection_reason: c.disconnection_reason,
        metadata: c.metadata && typeof c.metadata === 'object' ? c.metadata : undefined,
      }));
    },
  };
}

export function createMockRetellClient(): RetellClient {
  return {
    async createPhoneCall() {
      throw new Error('RETELL_API_KEY not configured');
    },
    async retrieveCall() {
      throw new Error('RETELL_API_KEY not configured');
    },
    async listCallsByMetadata() {
      throw new Error('RETELL_API_KEY not configured');
    },
  };
}
