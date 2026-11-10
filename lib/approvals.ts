/**
 * Service layer over the approval queue (lib/db-ext/approvals.ts).
 *
 *  - Arming a grant and releasing the kill switch need the ARMING secret
 *    (GLADOS_ARMING_HASH, same scrypt format as the login hash), which is a
 *    different secret from the login password. Not configured = cannot arm.
 *  - Executors are registered per channel in code. None ship by default, so an
 *    approved proposal on a channel with no executor fails honestly instead of acting.
 *  - Running also needs GLADOS_WRITES=1 (lib/gates.ts), like every other outbound write.
 */
import { verifyPassword } from '@/lib/auth';
import { resolveCred } from '@/lib/creds';
import { writesEnabled } from '@/lib/gates';
import type { Approval, Refusal } from '@/lib/db-ext/approvals';
import { getDb } from '@/lib/data';

export const ARMING_HASH_KEY = 'GLADOS_ARMING_HASH';

/** True when an arming secret has been set up on this instance. */
export function armingConfigured(): boolean {
  return Boolean(resolveCred(ARMING_HASH_KEY, [])?.trim());
}

/** Null = the secret is right; otherwise the reason it was refused. */
export function checkArming(secret: unknown): string | null {
  const stored = resolveCred(ARMING_HASH_KEY, [])?.trim();
  if (!stored) return 'No arming secret is set up on this instance, so grants cannot be armed or released.';
  if (typeof secret !== 'string' || !secret) return 'The arming secret is required.';
  return verifyPassword(secret, stored) ? null : 'Wrong arming secret.';
}

export type Executor = (approval: Approval) => Promise<string>;
const executors = new Map<string, Executor>();

/** Register the code that actually performs a channel's action. Nothing is registered by default. */
export function registerExecutor(channel: string, fn: Executor): void {
  executors.set(channel, fn);
}
export function clearExecutors(): void {
  executors.clear();
}
export function hasExecutor(channel: string): boolean {
  return executors.has(channel);
}

/** Run one approved proposal, once. Never retried: a failure is recorded as failed. */
export async function runApproved(id: string, actor: string, writes: boolean = writesEnabled()): Promise<{ ok: true; approval: Approval } | Refusal> {
  const repo = getDb().approvals;
  const a = repo.approval(id);
  if (!a) return { ok: false, reason: 'No such proposal.' };
  if (!writes) return { ok: false, reason: 'Outbound writes are off on this instance. Set GLADOS_WRITES=1 to allow runs.' };
  const exec = executors.get(a.channel);
  if (!exec) return { ok: false, reason: `No executor is registered for channel "${a.channel}". Nothing was run.` };
  const claimed = repo.claim(id, actor);
  if (!claimed.ok) return claimed;
  try {
    repo.finish(id, actor, { ok: true, result: await exec(claimed.value) });
  } catch (e) {
    repo.finish(id, actor, { ok: false, result: (e as Error).message });
  }
  return { ok: true, approval: repo.approval(id)! };
}
