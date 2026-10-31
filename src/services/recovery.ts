import type { Database } from '../db.ts';
import type { AppConfig, CallAttempt } from '../types.ts';
import type { RetellClient } from './retell.ts';
import { reconcileAttempt } from './queue.ts';

export async function runRecovery(
  db: Database,
  retell: RetellClient,
  config: AppConfig,
): Promise<void> {
  const attempts = db.stmts.getNonterminalAttempts.all() as unknown as CallAttempt[];
  for (const attempt of attempts) {
    await reconcileAttempt(db, retell, attempt, config);
  }
}
