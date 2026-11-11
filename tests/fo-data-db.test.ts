import { afterEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FO_DDL, FO_TABLES, migrateFounderOs, openDb, type GladosDb } from '@/lib/db';
import {
  CallRecordingSchema,
  ClientConfirmationSchema,
  ClientWorkSchema,
  CommsDigestSchema,
  CronRunSchema,
  DeliverableDecisionSchema,
  DigestReadSchema,
  LeadMagnetInputSchema,
  LeadMagnetPatchSchema,
  LeadMagnetSchema,
  PlaudIngestSchema,
  TradeActivitySchema,
  TradeAnalysisSchema,
  TradingAccountSnapshotSchema,
  TradingLimitsSchema,
  TradingOrderSchema,
  TradingPositionSchema,
  TradingPushSchema,
  UsagePushSchema,
  UsageReadingSchema,
} from '@/lib/schemas';
import { DecisionExistsError } from '@/lib/db-ext/agent-ops';

/** FounderOS merge, fo/data: every new table, its migration, schema and repo (SPEC §2.2, AC-11). */

const opened: GladosDb[] = [];
function freshDb(): GladosDb {
  const db = openDb(path.join(mkdtempSync(path.join(tmpdir(), 'glados-fodata-')), 'test.db'));
  opened.push(db);
  return db;
}
afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

const NOW = '2026-10-13T09:00:00.000Z';
const snap = (over: Record<string, unknown> = {}) => ({
  capturedAt: NOW, accountId: 'agentic', accountLabel: 'Agentic', accountValueUsd: 1000, buyingPowerUsd: 400,
  cashUsd: 400, dayPnlUsd: -3, totalPnlUsd: 12, source: 'markets-agent', ...over,
});

describe('tables and migration', () => {
  test('a fresh install has every FO table and no row in any of them (AC-11, T-1)', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'glados-fodata-')), 'fresh.db');
    const db = openDb(file);
    opened.push(db);
    const probe = new Database(file, { readonly: true });
    const names = (probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(FO_TABLES).toHaveLength(21);
    for (const t of FO_TABLES) {
      expect(names, t).toContain(t);
      expect((probe.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(0);
    }
    probe.close();
    expect(FO_DDL).not.toMatch(/INSERT/i); // nothing seeded
    expect(db.trading.isEmpty()).toBe(true);
    expect(db.trading.limits()).toBeNull();
    expect(db.clientConfirmations.all()).toEqual([]);
    expect(db.clientWork.all()).toEqual([]);
    expect(db.leadMagnets.all()).toEqual([]);
    expect(db.usageReadings.count()).toBe(0);
    expect(db.commsDigests.latest()).toBeNull();
    expect(db.callRecordings.count()).toBe(0);
    expect(db.deliverableDecisions.all()).toEqual([]);
    expect(db.cronRuns.recent()).toEqual([]);
  });

  test('migrateFounderOs is idempotent and upgrades the parts-bin shapes in place', () => {
    const raw = new Database(':memory:');
    // the 2026-10-06 parts bin's tables
    raw.exec(`CREATE TABLE cron_runs (id TEXT PRIMARY KEY, cron_id TEXT NOT NULL, agent_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, ok INTEGER NOT NULL, summary TEXT NOT NULL);
      INSERT INTO cron_runs VALUES ('r1','c1','a1','${NOW}','${NOW}',1,'ok');
      CREATE TABLE comms_digests (id TEXT PRIMARY KEY, generated_at TEXT NOT NULL, payload TEXT NOT NULL);
      INSERT INTO comms_digests VALUES ('d1','${NOW}','{}');
      CREATE TABLE digest_reads (key TEXT PRIMARY KEY, read_at TEXT NOT NULL);`);
    migrateFounderOs(raw);
    migrateFounderOs(raw); // twice: no throw, no duplicate work
    const cols = (t: string) => (raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('cron_runs')).toContain('trigger');
    expect((raw.prepare('SELECT trigger FROM cron_runs').get() as { trigger: string }).trigger).toBe('schedule');
    expect(cols('comms_digests')).toContain('body_json');
    expect(cols('digest_reads')).toContain('digest_id');
    // the old rows are kept, not dropped
    expect((raw.prepare('SELECT COUNT(*) AS n FROM comms_digests_v0').get() as { n: number }).n).toBe(1);
    raw.close();
  });

  test('opening the same file twice keeps the rows (the migration is additive)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'glados-fodata-'));
    const a = openDb(path.join(dir, 'x.db'));
    a.leadMagnets.insert({ id: 'm1', name: 'Kit', liveUrl: 'https://example.com/kit', destination: 'email', createdAt: NOW, updatedAt: NOW });
    a.close();
    const b = openDb(path.join(dir, 'x.db'));
    expect(b.leadMagnets.get('m1')?.name).toBe('Kit');
    b.close();
  });
});

describe('schemas reject what the tables must never hold', () => {
  test('trading', () => {
    expect(TradingAccountSnapshotSchema.safeParse(snap()).success).toBe(true);
    expect(TradingAccountSnapshotSchema.safeParse(snap({ accountValueUsd: Number.NaN })).success).toBe(false);
    expect(TradingPositionSchema.safeParse({ capturedAt: NOW, accountId: 'a', symbol: '', quantity: 1, avgCostUsd: 1, marketValueUsd: 1, unrealizedPnlUsd: 0 }).success).toBe(false);
    expect(TradeActivitySchema.safeParse({ id: 't', at: NOW, accountId: 'a', agent: 'x', action: 'short', symbol: 'S', quantity: 1, priceUsd: 1, rationale: '', status: 'filled' }).success).toBe(false);
    expect(TradeAnalysisSchema.safeParse({ id: 'a', at: NOW, accountId: 'a', agent: 'x', examined: -1, signals: 0, notes: '' }).success).toBe(false);
    expect(TradingOrderSchema.safeParse({ id: 'o', accountId: 'a', symbol: 'S', side: 'buy', type: 'limit', state: 'queued', quantity: 1, filledQuantity: 0, dollarAmountUsd: null, limitPriceUsd: 10, placedAgent: '', createdAt: NOW }).success).toBe(true);
    // limits: nothing defaults except autopilot (O4)
    expect(TradingLimitsSchema.safeParse({}).success).toBe(false);
    expect(TradingLimitsSchema.safeParse({ maxDeployedCapitalUsd: 1, maxNotionalPerTradeUsd: 1, maxPositionPctOfSleeve: 101, maxRiskPctPerTrade: 1, maxConcurrentPositions: 1, maxTradesPerDay: 1, minSleeveValueUsd: 0 }).success).toBe(false);
    // push: at most 200 positions
    const position = { symbol: 'S', quantity: 1, avgCostUsd: 1, marketValueUsd: 1, unrealizedPnlUsd: 0 };
    expect(TradingPushSchema.safeParse({ snapshot: snap(), positions: Array.from({ length: 200 }, () => position) }).success).toBe(true);
    expect(TradingPushSchema.safeParse({ snapshot: snap(), positions: Array.from({ length: 201 }, () => position) }).success).toBe(false);
  });

  test('clients, lead magnets, usage, digest, recordings, decisions, cron runs', () => {
    expect(ClientConfirmationSchema.safeParse({ clientId: 'c', name: '  ', source: 'manual', confirmedAt: NOW }).success).toBe(false);
    expect(ClientWorkSchema.safeParse({ id: 'w', clientId: 'c', brief: 'x', status: 'published', createdAt: NOW }).success).toBe(false);
    // LM-1: https only, name 1-120
    const lm = { name: 'Kit', liveUrl: 'https://example.com/kit', destination: 'email' };
    expect(LeadMagnetInputSchema.safeParse(lm).success).toBe(true);
    expect(LeadMagnetInputSchema.safeParse({ ...lm, liveUrl: 'http://example.com/kit' }).success).toBe(false);
    expect(LeadMagnetInputSchema.safeParse({ ...lm, liveUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(LeadMagnetInputSchema.safeParse({ ...lm, name: '' }).success).toBe(false);
    expect(LeadMagnetInputSchema.safeParse({ ...lm, name: 'x'.repeat(121) }).success).toBe(false);
    expect(LeadMagnetSchema.parse({ ...lm, id: 'm', createdAt: NOW, updatedAt: NOW }).status).toBe('draft');
    expect(LeadMagnetPatchSchema.safeParse({ status: 'deleted' }).success).toBe(false);
    expect(UsageReadingSchema.safeParse({ machine: 'm', plan: 'gemini', day: '2026-10-13', model: 'x', input: 1, output: 1, cacheWrite: 0, pushedAt: NOW }).success).toBe(false);
    expect(UsagePushSchema.safeParse({ machine: 'm', readings: [{ plan: 'claude', day: '13-10-2026', model: 'x', input: 1, output: 1, cacheWrite: 0 }] }).success).toBe(false);
    expect(CommsDigestSchema.safeParse({ id: 'd', date: 'today', body: {}, createdAt: NOW }).success).toBe(false);
    expect(DigestReadSchema.parse({ digestId: 'd', readAt: NOW }).entryKey).toBe('');
    expect(CallRecordingSchema.safeParse({ id: 'r', source: 'zoom', externalId: 'x', title: 't', startedAt: NOW }).success).toBe(false);
    expect(PlaudIngestSchema.safeParse({ recordings: [] }).success).toBe(false);
    expect(DeliverableDecisionSchema.safeParse({ runId: 'r', decision: 'rejected', reason: '', at: NOW }).success).toBe(false);
    expect(DeliverableDecisionSchema.safeParse({ runId: 'r', decision: 'approved', at: NOW }).success).toBe(true);
    expect(CronRunSchema.parse({ id: 'x', cronId: 'c', agentId: 'a', startedAt: NOW, finishedAt: NOW, ok: true, summary: '' }).trigger).toBe('schedule');
  });
});

describe('repositories', () => {
  test('trading: snapshot + positions, latest per account, history, orders replaced wholesale, limits single row', () => {
    const db = freshDb();
    const t = db.trading;
    t.recordSnapshot(snap({ capturedAt: '2026-10-12T09:00:00.000Z', accountValueUsd: 900 }), []);
    t.recordSnapshot(snap(), [{ capturedAt: NOW, accountId: 'agentic', symbol: 'SPY', quantity: 1, avgCostUsd: 560, marketValueUsd: 570, unrealizedPnlUsd: 10 }]);
    t.recordSnapshot(snap({ accountId: 'individual', accountLabel: 'Individual', accountValueUsd: 10_000 }), []);
    expect(t.latestSnapshots().map((s) => s.accountId)).toEqual(['individual', 'agentic']);
    expect(t.history('agentic').map((s) => s.accountValueUsd)).toEqual([900, 1000]);
    expect(t.positions('agentic').map((p) => p.symbol)).toEqual(['SPY']);
    const order = { id: 'o1', accountId: 'agentic', symbol: 'AMD', side: 'buy' as const, type: 'limit', state: 'queued', quantity: 1, filledQuantity: 0, dollarAmountUsd: null, limitPriceUsd: 100, placedAgent: 'Markets', createdAt: NOW };
    t.replaceOpenOrders('agentic', [order]);
    t.replaceOpenOrders('agentic', []);
    expect(t.openOrders()).toEqual([]);
    t.recordAnalysis({ id: 'a1', at: NOW, accountId: 'agentic', agent: 'Markets', examined: 3, signals: 1, notes: 'n', rows: [{ ticker: 'SPY', score: null, verdict: 'skip', reason: 'r' }] });
    t.recordAnalysis({ id: 'a1', at: NOW, accountId: 'agentic', agent: 'Markets', examined: 3, signals: 1, notes: 'n', rows: [] }); // idempotent on id
    expect(t.analyses()).toHaveLength(1);
    t.recordActivity({ id: 'x1', at: NOW, accountId: 'agentic', agent: 'Markets', action: 'buy', symbol: 'SPY', quantity: 1, priceUsd: 560, rationale: '', status: 'filled' });
    expect(t.activity()).toHaveLength(1);
    const limits = { maxDeployedCapitalUsd: 2000, maxNotionalPerTradeUsd: 500, maxPositionPctOfSleeve: 25, maxRiskPctPerTrade: 1, maxConcurrentPositions: 5, maxTradesPerDay: 2, minSleeveValueUsd: 1000, autopilot: false };
    t.saveLimits(limits, NOW);
    t.saveLimits({ ...limits, autopilot: true }, NOW);
    expect(t.limits()).toEqual({ ...limits, autopilot: true, updatedAt: NOW });
    expect(t.isEmpty()).toBe(false);
  });

  test('clients: confirm, edit keeps confirmedAt, unconfirm keeps work; status stamps finishedAt', () => {
    const db = freshDb();
    db.clientConfirmations.upsert({ clientId: 'c1', name: 'Northwind', source: 'attio', confirmedAt: NOW });
    db.clientConfirmations.upsert({ clientId: 'c1', name: 'Northwind Studio', source: 'attio', retainer: true, confirmedAt: '2027-01-01T00:00:00.000Z' });
    const c = db.clientConfirmations.get('c1')!;
    expect(c.name).toBe('Northwind Studio');
    expect(c.retainer).toBe(true);
    expect(c.confirmedAt).toBe(NOW);
    db.clientWork.insert({ id: 'w1', clientId: 'c1', brief: 'Three hooks', status: 'draft', createdAt: NOW });
    expect(db.clientWork.setStatus('w1', 'done', { at: NOW })?.finishedAt).toBe(NOW);
    expect(db.clientWork.setStatus('w1', 'queued')?.finishedAt).toBeNull();
    expect(db.clientWork.setStatus('nope', 'done')).toBeNull();
    db.clientConfirmations.remove('c1');
    expect(db.clientConfirmations.all()).toEqual([]);
    expect(db.clientWork.all('c1')).toHaveLength(1);
  });

  test('lead magnets: insert, filter, patch validated whole, delete', () => {
    const db = freshDb();
    db.leadMagnets.insert({ id: 'm1', name: 'Kit', liveUrl: 'https://example.com/kit', destination: 'email', status: 'live', createdAt: NOW, updatedAt: NOW });
    db.leadMagnets.insert({ id: 'm2', name: 'Call', liveUrl: 'https://example.com/call', destination: 'booking', createdAt: NOW, updatedAt: NOW });
    expect(db.leadMagnets.all('live').map((m) => m.id)).toEqual(['m1']);
    expect(db.leadMagnets.update('m2', { status: 'paused' }, NOW)?.status).toBe('paused');
    expect(() => db.leadMagnets.update('m2', { liveUrl: 'http://insecure' } as never)).toThrow();
    expect(db.leadMagnets.update('nope', { status: 'live' })).toBeNull();
    expect(db.leadMagnets.remove('m1')).toBe(true);
    expect(db.leadMagnets.remove('m1')).toBe(false);
  });

  test('usage readings: a re-push of a day replaces it, never double counts', () => {
    const db = freshDb();
    const r = { plan: 'claude' as const, day: '2026-10-13', model: 'opus', input: 10, output: 5, cacheWrite: 1 };
    db.usageReadings.replaceForMachine('mini', [r], NOW);
    db.usageReadings.replaceForMachine('mini', [{ ...r, input: 20 }], NOW);
    const rows = db.usageReadings.since('2026-10-01');
    expect(rows).toHaveLength(1);
    expect(rows[0].input).toBe(20);
    expect(db.usageReadings.machines()).toEqual([{ machine: 'mini', plan: 'claude', lastPushAt: NOW }]);
  });

  test('digest: store, read marks per digest and per entry, undo', () => {
    const db = freshDb();
    const d = db.commsDigests.insert({ id: 'd1', date: '2026-10-13', body: { entries: [] }, createdAt: NOW });
    expect(db.commsDigests.latest()?.id).toBe(d.id);
    expect(db.commsDigests.isRead('d1')).toBe(false);
    db.commsDigests.reads.mark('d1');
    db.commsDigests.reads.mark('d1', 'email|Dara|2026-10-13T08:00:00.000Z');
    expect(db.commsDigests.isRead('d1')).toBe(true);
    expect(db.commsDigests.reads.clearedKeys()).toEqual(['email|Dara|2026-10-13T08:00:00.000Z']);
    db.commsDigests.reads.unmark('d1');
    expect(db.commsDigests.isRead('d1')).toBe(false);
  });

  test('recordings upsert on (source, external id)', () => {
    const db = freshDb();
    db.callRecordings.upsert({ source: 'plaud', externalId: 'p1', title: 'Walk', startedAt: NOW });
    db.callRecordings.upsert({ source: 'plaud', externalId: 'p1', title: 'Site walk', startedAt: NOW, participants: ['A'] });
    expect(db.callRecordings.count('plaud')).toBe(1);
    expect(db.callRecordings.recent(10)[0]).toMatchObject({ id: 'plaud:p1', title: 'Site walk', participants: ['A'] });
  });

  test('deliverable decisions: one per run (A-1); cron runs: stats per cron', () => {
    const db = freshDb();
    db.deliverableDecisions.record({ runId: 'r1', decision: 'approved' });
    expect(() => db.deliverableDecisions.record({ runId: 'r1', decision: 'rejected', reason: 'late' })).toThrow(DecisionExistsError);
    expect(db.deliverableDecisions.get('r1')?.decision).toBe('approved');
    expect(db.deliverableDecisions.decidedRunIds().has('r1')).toBe(true);
    db.cronRuns.insert({ id: 'x1', cronId: 'c', agentId: 'a', startedAt: '2026-10-13T07:00:00.000Z', finishedAt: NOW, ok: false, summary: 'boom' });
    db.cronRuns.insert({ id: 'x2', cronId: 'c', agentId: 'a', startedAt: '2026-10-13T08:00:00.000Z', finishedAt: NOW, ok: true, summary: 'ok', trigger: 'manual' });
    expect(db.cronRuns.statsByCron().c).toEqual({ runs: 2, ok: 1, lastRunAt: '2026-10-13T08:00:00.000Z', lastOk: true });
    expect(db.cronRuns.byCron('c')[0].trigger).toBe('manual');
  });

  test('agents: failover helpers', () => {
    const db = freshDb();
    expect(db.agents.get('nope')).toBeNull();
    expect(db.agents.setModel('nope', 'x')).toBe(false);
  });
});
