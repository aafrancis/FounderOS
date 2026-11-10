/**
 * What the approvals screen shows and which buttons it offers (SH-0271).
 * Pure functions over the payload of GET /api/approvals, so the rules are
 * testable without a browser. Nothing here talks to the network.
 */

export type ViewAction = {
  id: string;
  channel: string;
  kind: string;
  title: string;
  content: string;
  target: string;
  costCents: number;
  status: 'proposed' | 'approved' | 'rejected' | 'executing' | 'executed' | 'failed' | 'expired';
  proposedBy: string;
  proposedAt: string;
  result?: string | null;
};

export type ViewGrant = {
  channel: string;
  mode: 'ask' | 'auto';
  armed: boolean;
  dailyCapCount: number;
  dailyCapCents: number;
};

export type ViewState = {
  killed: boolean;
  writesEnabled: boolean;
  armConfigured: boolean;
  grants: ViewGrant[];
  open: ViewAction[];
  recent: ViewAction[];
};

/** Minor units as a plain number with two decimals. The currency is the channel's, so none is printed. */
export function formatCents(cents: number): string {
  const n = Number.isFinite(cents) ? Math.max(0, Math.trunc(cents)) : 0;
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

export type RowButton = 'approve' | 'reject' | 'run';

/** Buttons for one queued action. Nothing at all while the kill switch is on. */
export function buttonsFor(action: Pick<ViewAction, 'status'>, killed: boolean): RowButton[] {
  if (killed) return [];
  if (action.status === 'proposed') return ['approve', 'reject'];
  if (action.status === 'approved') return ['run'];
  return [];
}

/** One plain sentence on why an approved action has not run, or null when nothing is stuck. */
export function whyNotRunning(state: Pick<ViewState, 'killed' | 'writesEnabled'>, action: Pick<ViewAction, 'status'>): string | null {
  if (action.status !== 'approved') return null;
  if (state.killed) return 'The kill switch is on.';
  if (!state.writesEnabled) return 'Outbound writes are off on this instance (GLADOS_WRITES), so it waits.';
  return 'Approved and ready: press Run once an executor exists for this kind of action.';
}

export type Headline = { tone: 'bad' | 'warn' | 'ok'; text: string };

/** The one line at the top: is anything able to act right now. */
export function headline(state: ViewState): Headline {
  if (state.killed) return { tone: 'bad', text: 'Kill switch ON. Nothing can be proposed, approved or run.' };
  const armed = state.grants.filter((g) => g.armed).length;
  if (!state.armConfigured) return { tone: 'warn', text: 'No arming secret is set, so no channel can be armed.' };
  if (armed === 0) return { tone: 'ok', text: 'No channel is armed. Nothing can act.' };
  return { tone: 'warn', text: `${armed} channel${armed === 1 ? '' : 's'} armed.` };
}

/** Turn an error body from the API into the sentence shown to the operator. */
export function errorText(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return fallback;
}
