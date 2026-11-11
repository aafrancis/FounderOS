'use client';

/**
 * The approval queue screen (SH-0271). Shows what is waiting, lets the operator
 * approve, reject or run one action, arm or disarm a channel, and hit the kill
 * switch. Every control calls the routes under /api/approvals; this file holds
 * no rules of its own (those are lib/approvals.ts and lib/approvals-view.ts).
 *
 * The arming password is typed into a field that is cleared after every send.
 * It is never kept in state beyond the field, never logged, never put in a URL.
 *
 * Hard-line actions (SH-0277) sit at the top. Their Approve button asks for the
 * founder's passkey (Face ID on iPhone Safari) and sends the signed assertion to
 * /api/approvals/:id/passkey; there is no plain Approve for them.
 */
import { useCallback, useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  buttonsFor,
  errorText,
  formatCents,
  hardLineDetail,
  headline,
  isHardLineView,
  whyNotRunning,
  type PasskeyView,
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
  const [passkey, setPasskey] = useState<PasskeyView | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/approvals', { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setState((await res.json()) as ViewState);
      setLoadError(null);
      const pk = await fetch('/api/passkey', { cache: 'no-store' }).catch(() => null);
      if (pk?.ok) setPasskey((await pk.json()) as PasskeyView);
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

  /** Hard-line approve: fresh challenge for this action, Face ID, then the signed assertion. */
  async function approveWithPasskey(a: ViewAction) {
    setBusy(true);
    setNote(null);
    const url = `/api/approvals/${encodeURIComponent(a.id)}/passkey`;
    try {
      const start = await post(url, { step: 'options' });
      if (!start.ok) {
        setNote({ tone: 'err', text: errorText(start.body, 'Could not start the passkey prompt.') });
        return;
      }
      const optionsJSON = (start.body as { options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }).options;
      const response = await startAuthentication({ optionsJSON });
      const done = await post(url, { step: 'verify', response });
      setNote(done.ok ? { tone: 'ok', text: 'Approved with your passkey.' } : { tone: 'err', text: errorText(done.body, 'The passkey approval did not go through.') });
    } catch (e) {
      setNote({ tone: 'err', text: `Passkey prompt cancelled or failed (${e instanceof Error ? e.message : 'unknown'}). Nothing was approved.` });
    } finally {
      setBusy(false);
      await load();
    }
  }

  const decide = (a: ViewAction, b: RowButton) =>
    b === 'passkey'
      ? approveWithPasskey(a)
      : run(`/api/approvals/${encodeURIComponent(a.id)}`, { decision: b }, b === 'approve' ? 'Approved.' : b === 'reject' ? (isHardLineView(a) ? 'Denied.' : 'Rejected.') : 'Run requested.');

  /** Enrol this device's passkey. Needs the arming password. */
  async function onRegisterPasskey(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const armSecret = String(f.get('armSecret') ?? '');
    const label = String(f.get('label') ?? '').trim() || 'passkey';
    form.reset();
    setBusy(true);
    setNote(null);
    try {
      const start = await post('/api/passkey', { step: 'options', armSecret });
      if (!start.ok) {
        setNote({ tone: 'err', text: errorText(start.body, 'Could not start passkey registration.') });
        return;
      }
      const optionsJSON = (start.body as { options: Parameters<typeof startRegistration>[0]['optionsJSON'] }).options;
      const response = await startRegistration({ optionsJSON });
      const done = await post('/api/passkey', { step: 'verify', response, label });
      setNote(done.ok ? { tone: 'ok', text: `Passkey "${label}" registered.` } : { tone: 'err', text: errorText(done.body, 'Passkey registration did not go through.') });
    } catch (err) {
      setNote({ tone: 'err', text: `Passkey registration cancelled or failed (${err instanceof Error ? err.message : 'unknown'}).` });
    } finally {
      setBusy(false);
      await load();
    }
  }

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
  const hardLine = state.open.filter(isHardLineView);
  const ordinary = state.open.filter((a) => !isHardLineView(a));
  const buttonLabel = (a: ViewAction, b: RowButton) =>
    b === 'passkey' ? 'Approve with Face ID' : b === 'approve' ? 'Approve' : b === 'reject' ? (isHardLineView(a) ? 'Deny' : 'Reject') : 'Run';
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

      {hardLine.length > 0 && (
        <section role="alertdialog" aria-label="Hard-line approvals" className="rounded border border-amber-500/60 p-4">
          <h2 className="mb-1 text-[15px] font-medium text-amber-400">Hard-line: needs your passkey ({hardLine.length})</h2>
          <p className="mb-3 text-[12px] opacity-70">An agent is asking before a step that is hard to undo. Approve asks for Face ID and approves only this one request.</p>
          <ul className="flex flex-col gap-3">
            {hardLine.map((a) => {
              const d = hardLineDetail(a);
              const why = whyNotRunning(state, a);
              return (
                <li key={a.id} className="rounded border border-white/15 p-3">
                  <p className="text-[14px] font-medium">{d?.summary ?? a.title}</p>
                  <p className="mt-1 text-[12px] opacity-70">From {a.proposedBy} · {a.status}</p>
                  <p className="mt-2 text-[12px] font-medium">Action</p>
                  <pre className="whitespace-pre-wrap break-words text-[12px]">{d?.action ?? a.content}</pre>
                  {d && (
                    <>
                      <p className="mt-2 text-[12px] font-medium">Undo</p>
                      <pre className="whitespace-pre-wrap break-words text-[12px]">{d.undo}</pre>
                    </>
                  )}
                  {why && <p className="mt-2 text-[12px] text-emerald-400">{why}</p>}
                  <div className="mt-3 flex gap-2">
                    {buttonsFor(a, state.killed).map((b) => (
                      <button key={b} type="button" className={b === 'reject' ? 'c-btn' : 'c-btn c-btn-primary'} disabled={busy || (b === 'passkey' && !passkey?.credentials.length)} onClick={() => void decide(a, b)}>
                        {buttonLabel(a, b)}
                      </button>
                    ))}
                  </div>
                  {passkey && !passkey.credentials.length && <p className="mt-2 text-[12px] text-amber-400">Register a passkey below first.</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-[15px] font-medium">Waiting for you ({ordinary.length})</h2>
        {ordinary.length === 0 && <p className="text-[13px] opacity-70">Nothing is waiting.</p>}
        <ul className="flex flex-col gap-3">
          {ordinary.map((a) => {
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
                      {buttonLabel(a, b)}
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
        <h2 className="mb-2 text-[15px] font-medium">Passkey for hard-line approvals</h2>
        {!passkey && <p className="text-[13px] opacity-70">Reading passkey status.</p>}
        {passkey && !passkey.configured && (
          <p className="text-[13px] text-amber-400">Not configured: set GLADOS_PASSKEY_RP_ID and GLADOS_PASSKEY_ORIGIN in .env.local, then restart.</p>
        )}
        {passkey?.configured && (
          <>
            <ul className="mb-3 flex flex-col gap-1 text-[13px]">
              {passkey.credentials.map((c) => (
                <li key={c.id}>{c.label} · added {c.createdAt.slice(0, 10)} · {c.lastUsedAt ? `last used ${c.lastUsedAt.slice(0, 10)}` : 'never used'}</li>
              ))}
              {passkey.credentials.length === 0 && <li className="opacity-70">No passkey yet. Register one on your phone so hard-line requests can be approved.</li>}
            </ul>
            <form onSubmit={onRegisterPasskey} className="flex flex-wrap items-end gap-3 text-[12px]">
              <label className="flex flex-col gap-1">Name for this device
                <input name="label" maxLength={60} placeholder="iPhone" className="rounded border border-white/20 bg-transparent px-2 py-1 text-[13px]" />
              </label>
              <label className="flex flex-col gap-1">Arming password
                <input name="armSecret" type="password" autoComplete="off" required className="rounded border border-white/20 bg-transparent px-2 py-1 text-[13px]" />
              </label>
              <button type="submit" className="c-btn" disabled={busy || !state.armConfigured}>Register this device</button>
            </form>
          </>
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
