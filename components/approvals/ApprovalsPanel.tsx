'use client';

/**
 * The approval queue screen (SH-0271). Shows what is waiting, lets the operator
 * approve, reject or run one action, arm or disarm a channel, and hit the kill
 * switch. Every control calls the routes under /api/approvals; this file holds
 * no rules of its own (those are lib/approvals.ts and lib/approvals-view.ts).
 *
 * The arming password is typed into a field that is cleared after every send.
 * It is never kept in state beyond the field, never logged, never put in a URL.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  buttonsFor,
  errorText,
  formatCents,
  headline,
  whyNotRunning,
  type RowButton,
  type ViewAction,
  type ViewState,
} from '@/lib/approvals-view';

type Note = { tone: 'ok' | 'err'; text: string } | null;

const TONE: Record<string, string> = {
  bad: 'border-red-500/60 text-red-400',
  warn: 'border-amber-500/60 text-amber-400',
  ok: 'border-emerald-500/60 text-emerald-400',
};

async function post(url: string, body: unknown): Promise<{ ok: boolean; body: unknown }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, body: json };
}

export function ApprovalsPanel() {
  const [state, setState] = useState<ViewState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/approvals', { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setState((await res.json()) as ViewState);
      setLoadError(null);
    } catch (e) {
      setLoadError(`Could not read the queue (${e instanceof Error ? e.message : 'unknown error'}).`);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function run(url: string, body: unknown, done: string) {
    setBusy(true);
    setNote(null);
    try {
      const r = await post(url, body);
      setNote(r.ok ? { tone: 'ok', text: done } : { tone: 'err', text: errorText(r.body, 'That did not go through.') });
    } catch {
      setNote({ tone: 'err', text: 'Could not reach the server.' });
    } finally {
      setBusy(false);
      await load();
    }
  }

  const decide = (a: ViewAction, b: RowButton) =>
    run(`/api/approvals/${encodeURIComponent(a.id)}`, { decision: b }, b === 'approve' ? 'Approved.' : b === 'reject' ? 'Rejected.' : 'Run requested.');

  async function onArm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const body = {
      action: 'arm',
      channel: String(f.get('channel') ?? '').trim(),
      mode: String(f.get('mode') ?? 'ask'),
      dailyCapCount: Number(f.get('count')),
      dailyCapCents: Number(f.get('cents')),
      armSecret: String(f.get('armSecret') ?? ''),
    };
    form.reset();
    await run('/api/approvals/grants', body, `Armed ${body.channel}.`);
  }

  async function onReset(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const armSecret = String(new FormData(form).get('armSecret') ?? '');
    form.reset();
    await run('/api/approvals/kill', { action: 'reset', armSecret }, 'Kill switch lifted. Every channel is still off until you arm it again.');
  }

  if (loadError && !state) return <p className="text-sm text-red-400">{loadError}</p>;
  if (!state) return <p className="text-sm opacity-70">Loading the queue.</p>;

  const head = headline(state);
  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <section className={`flex flex-wrap items-center justify-between gap-4 rounded border p-4 ${TONE[head.tone]}`} aria-live="polite">
        <p className="text-[14px]">{head.text}</p>
        {!state.killed && (
          <button type="button" className="c-btn" disabled={busy} onClick={() => void run('/api/approvals/kill', { action: 'kill' }, 'Kill switch on. Every channel is off.')}>
            Kill switch: stop everything
          </button>
        )}
      </section>

      {note && (
        <p role="status" className={`text-[13px] ${note.tone === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
          {note.text}
        </p>
      )}
      {loadError && <p className="text-[13px] text-amber-400">{loadError} Showing the last good reading.</p>}

      {state.killed && (
        <section>
          <h2 className="mb-2 text-[15px] font-medium">Lift the kill switch</h2>
          <p className="mb-3 text-[13px] opacity-70">Needs the arming password. It re-arms nothing.</p>
          <form onSubmit={onReset} className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[12px]">
              Arming password
              <input name="armSecret" type="password" autoComplete="off" required className="rounded border border-white/20 bg-transparent px-2 py-1 text-[13px]" />
            </label>
            <button type="submit" className="c-btn" disabled={busy}>Lift</button>
          </form>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-[15px] font-medium">Waiting for you ({state.open.length})</h2>
        {state.open.length === 0 && <p className="text-[13px] opacity-70">Nothing is waiting.</p>}
        <ul className="flex flex-col gap-3">
          {state.open.map((a) => {
            const why = whyNotRunning(state, a);
            return (
              <li key={a.id} className="rounded border border-white/15 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[14px] font-medium">{a.title}</span>
                  <span className="text-[12px] opacity-70">{a.channel} · {a.kind} · cost {formatCents(a.costCents)}</span>
                </div>
                <p className="mt-1 text-[12px] opacity-70">To {a.target} · from {a.proposedBy} · {a.status}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-[12px]">Full content</summary>
                  <pre className="mt-1 whitespace-pre-wrap break-words text-[12px]">{a.content}</pre>
                </details>
                {why && <p className="mt-2 text-[12px] text-amber-400">{why}</p>}
                <div className="mt-3 flex gap-2">
                  {buttonsFor(a, state.killed).map((b) => (
                    <button key={b} type="button" className={b === 'reject' ? 'c-btn' : 'c-btn c-btn-primary'} disabled={busy} onClick={() => void decide(a, b)}>
                      {b === 'approve' ? 'Approve' : b === 'reject' ? 'Reject' : 'Run'}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-[15px] font-medium">Channels</h2>
        {state.grants.length === 0 && <p className="text-[13px] opacity-70">No channel has ever been armed.</p>}
        <ul className="flex flex-col gap-2">
          {state.grants.map((g) => (
            <li key={g.channel} className="flex flex-wrap items-center justify-between gap-2 rounded border border-white/15 p-3 text-[13px]">
              <span>
                <strong>{g.channel}</strong> · {g.armed ? 'ARMED' : 'off'} · {g.mode === 'ask' ? 'ask every time' : 'auto-approve'} · {g.dailyCapCount}/day · spend cap {formatCents(g.dailyCapCents)}/day
              </span>
              {g.armed && (
                <button type="button" className="c-btn" disabled={busy} onClick={() => void run('/api/approvals/grants', { action: 'disarm', channel: g.channel }, `Disarmed ${g.channel}.`)}>
                  Turn off
                </button>
              )}
            </li>
          ))}
        </ul>

        {!state.killed && (
          <form onSubmit={onArm} className="mt-4 grid max-w-xl grid-cols-2 gap-3 text-[12px]">
            <label className="flex flex-col gap-1">Channel
              <input name="channel" required pattern="[a-z0-9][a-z0-9._-]{0,63}" placeholder="e.g. zernio-publish" className="rounded border border-white/20 bg-transparent px-2 py-1 text-[13px]" />
            </label>
            <label className="flex flex-col gap-1">Mode
              <select name="mode" defaultValue="ask" className="rounded border border-white/20 bg-transparent px-2 py-1 text-[13px]">
                <option value="ask">Ask me every time</option>
                <option value="auto">Auto-approve inside the cap</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">Actions per day
              <input name="count" type="number" min={1} max={1000} defaultValue={5} required className="rounded border border-white/20 bg-transparent px-2 py-1 text-[13px]" />
            </label>
            <label className="flex flex-col gap-1">Spend cap per day (cents)
              <input name="cents" type="number" min={0} defaultValue={0} required className="rounded border border-white/20 bg-transparent px-2 py-1 text-[13px]" />
            </label>
            <label className="col-span-2 flex flex-col gap-1">Arming password
              <input name="armSecret" type="password" autoComplete="off" required className="rounded border border-white/20 bg-transparent px-2 py-1 text-[13px]" />
            </label>
            <div className="col-span-2">
              <button type="submit" className="c-btn c-btn-primary" disabled={busy || !state.armConfigured}>Arm this channel</button>
              {!state.armConfigured && <span className="ml-3 text-amber-400">Set the arming password first (scripts/hash-arm-secret.mjs).</span>}
            </div>
          </form>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[15px] font-medium">Recent</h2>
        <ul className="flex flex-col gap-1 text-[12px]">
          {state.recent.slice(0, 20).map((a) => (
            <li key={a.id} className="opacity-80">{a.status} · {a.channel} · {a.title} · to {a.target}</li>
          ))}
          {state.recent.length === 0 && <li className="opacity-70">Nothing yet.</li>}
        </ul>
      </section>
    </div>
  );
}
