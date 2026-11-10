import { beforeAll, describe, expect, test } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

beforeAll(() => {
  process.env.GLADOS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'glados-apismoke-')), 'test.db');
  process.env.FUNNEL_PROVIDER = 'seed'; // keep /api/funnel off the live Attio API in tests
  // keep /api/usage off this machine's real transcripts (it reads them on a private instance)
  const emptyUsageDir = mkdtempSync(path.join(tmpdir(), 'glados-usage-'));
  process.env.CLAUDE_PROJECTS_DIR = emptyUsageDir;
  process.env.CODEX_SESSIONS_DIR = emptyUsageDir;
});

type RouteEntry = {
  route: string; // path under app/api, source of truth for coverage
  load: () => Promise<{ GET?: (req: Request, ctx?: any) => unknown }>;
  url: string; // includes any required query params
  params?: Record<string, string>; // for dynamic [param] routes
};

// Every app/api/**/route.ts that exports GET, with valid params so each returns
// a real 200 (not a 400/404 for a missing arg). Live-connector routes
// (connections, social/sync) must still answer 200 with honest state.
const ROUTES: RouteEntry[] = [
  { route: 'agents', load: () => import('@/app/api/agents/route'), url: 'http://localhost/api/agents' },
  // FounderOS merge (fo/data): every new GET answers 200 on a blank install, spending nothing.
  { route: 'trading', load: () => import('@/app/api/trading/route'), url: 'http://localhost/api/trading' },
  { route: 'trading/limits', load: () => import('@/app/api/trading/limits/route'), url: 'http://localhost/api/trading/limits' },
  { route: 'usage', load: () => import('@/app/api/usage/route'), url: 'http://localhost/api/usage' },
  { route: 'approvals', load: () => import('@/app/api/approvals/route'), url: 'http://localhost/api/approvals' },
  { route: 'approvals/tokens', load: () => import('@/app/api/approvals/tokens/route'), url: 'http://localhost/api/approvals/tokens' },
  { route: 'clients', load: () => import('@/app/api/clients/route'), url: 'http://localhost/api/clients' },
  { route: 'lead-magnets', load: () => import('@/app/api/lead-magnets/route'), url: 'http://localhost/api/lead-magnets' },
  { route: 'chats', load: () => import('@/app/api/chats/route'), url: 'http://localhost/api/chats' },
  { route: 'chats/[agentId]', load: () => import('@/app/api/chats/[agentId]/route'), url: 'http://localhost/api/chats/conductor', params: { agentId: 'conductor' } },
  { route: 'comms/digest', load: () => import('@/app/api/comms/digest/route'), url: 'http://localhost/api/comms/digest' },
  { route: 'calls/archive', load: () => import('@/app/api/calls/archive/route'), url: 'http://localhost/api/calls/archive' },
  { route: 'cron/tick', load: () => import('@/app/api/cron/tick/route'), url: 'http://localhost/api/cron/tick' },
  { route: 'trakyo/links', load: () => import('@/app/api/trakyo/links/route'), url: 'http://localhost/api/trakyo/links' },
  { route: 'auth/check', load: () => import('@/app/api/auth/check/route'), url: 'http://localhost/api/auth/check' },
  { route: 'blueprint', load: () => import('@/app/api/blueprint/route'), url: 'http://localhost/api/blueprint' },
  { route: 'database', load: () => import('@/app/api/database/route'), url: 'http://localhost/api/database' },
  { route: 'compute', load: () => import('@/app/api/compute/route'), url: 'http://localhost/api/compute' },
  { route: 'compute/embed', load: () => import('@/app/api/compute/embed/route'), url: 'http://localhost/api/compute/embed?id=00000000-0000' },
  { route: 'settings/modules', load: () => import('@/app/api/settings/modules/route'), url: 'http://localhost/api/settings/modules' },
  { route: 'settings/filming', load: () => import('@/app/api/settings/filming/route'), url: 'http://localhost/api/settings/filming' },
  // Answers 200 with honest state when the rules file is not on this machine.
  { route: 'brand-deals/rules', load: () => import('@/app/api/brand-deals/rules/route'), url: 'http://localhost/api/brand-deals/rules' },
  { route: 'database/file', load: () => import('@/app/api/database/file/route'), url: 'http://localhost/api/database/file?path=TAXONOMY.md' },
  { route: 'wizard/designed', load: () => import('@/app/api/wizard/designed/route'), url: 'http://localhost/api/wizard/designed' },
  { route: 'wizard/crew', load: () => import('@/app/api/wizard/crew/route'), url: 'http://localhost/api/wizard/crew' },
  { route: 'wizard/engine', load: () => import('@/app/api/wizard/engine/route'), url: 'http://localhost/api/wizard/engine' },
  { route: 'wizard/projects', load: () => import('@/app/api/wizard/projects/route'), url: 'http://localhost/api/wizard/projects' },
  { route: 'creative-engine/campaigns', load: () => import('@/app/api/creative-engine/campaigns/route'), url: 'http://localhost/api/creative-engine/campaigns' },
  { route: 'creative-engine/arcads/catalog', load: () => import('@/app/api/creative-engine/arcads/catalog/route'), url: 'http://localhost/api/creative-engine/arcads/catalog' },
  { route: 'creative-engine/arcads/health', load: () => import('@/app/api/creative-engine/arcads/health/route'), url: 'http://localhost/api/creative-engine/arcads/health' },
  { route: 'creative-engine/arcads/setup', load: () => import('@/app/api/creative-engine/arcads/setup/route'), url: 'http://localhost/api/creative-engine/arcads/setup' },
  { route: 'creative-engine/workflows', load: () => import('@/app/api/creative-engine/workflows/route'), url: 'http://localhost/api/creative-engine/workflows' },
  { route: 'creative-engine/arcads/assets', load: () => import('@/app/api/creative-engine/arcads/assets/route'), url: 'http://localhost/api/creative-engine/arcads/assets' },
  { route: 'creative-engine/arcads/presets', load: () => import('@/app/api/creative-engine/arcads/presets/route'), url: 'http://localhost/api/creative-engine/arcads/presets' },
  { route: 'creative-engine/runs', load: () => import('@/app/api/creative-engine/runs/route'), url: 'http://localhost/api/creative-engine/runs' },
  { route: 'creative-engine/presets', load: () => import('@/app/api/creative-engine/presets/route'), url: 'http://localhost/api/creative-engine/presets' },
  { route: 'adscout/saved', load: () => import('@/app/api/adscout/saved/route'), url: 'http://localhost/api/adscout/saved' },
  { route: 'adscout/watchlist', load: () => import('@/app/api/adscout/watchlist/route'), url: 'http://localhost/api/adscout/watchlist' },
  { route: 'agents/activity', load: () => import('@/app/api/agents/activity/route'), url: 'http://localhost/api/agents/activity?limit=5' },
  { route: 'agents/broadcast', load: () => import('@/app/api/agents/broadcast/route'), url: 'http://localhost/api/agents/broadcast' },
  { route: 'agents/work', load: () => import('@/app/api/agents/work/route'), url: 'http://localhost/api/agents/work?agentId=data-agent' },
  { route: 'brain', load: () => import('@/app/api/brain/route'), url: 'http://localhost/api/brain' },
  { route: 'brand-deals', load: () => import('@/app/api/brand-deals/route'), url: 'http://localhost/api/brand-deals' },
  { route: 'brand-deals/draft', load: () => import('@/app/api/brand-deals/draft/route'), url: 'http://localhost/api/brand-deals/draft?id=r123' },
  { route: 'brain/graph', load: () => import('@/app/api/brain/graph/route'), url: 'http://localhost/api/brain/graph' },
  { route: 'brain/overview', load: () => import('@/app/api/brain/overview/route'), url: 'http://localhost/api/brain/overview' },
  { route: 'comms', load: () => import('@/app/api/comms/route'), url: 'http://localhost/api/comms' },
  // FounderOS's own Agents board (founderos/)
  { route: 'board/live', load: () => import('@/app/api/board/live/route'), url: 'http://localhost/api/board/live' },
  { route: 'board/deliverables', load: () => import('@/app/api/board/deliverables/route'), url: 'http://localhost/api/board/deliverables' },
  { route: 'conductor/chat', load: () => import('@/app/api/conductor/chat/route'), url: 'http://localhost/api/conductor/chat' },
  { route: 'conductor/context', load: () => import('@/app/api/conductor/context/route'), url: 'http://localhost/api/conductor/context?path=/agents' },
  { route: 'connections', load: () => import('@/app/api/connections/route'), url: 'http://localhost/api/connections' },
  { route: 'connections/summary', load: () => import('@/app/api/connections/summary/route'), url: 'http://localhost/api/connections/summary' },
  { route: 'contacts/tags', load: () => import('@/app/api/contacts/tags/route'), url: 'http://localhost/api/contacts/tags' },
  { route: 'content/pipelines', load: () => import('@/app/api/content/pipelines/route'), url: 'http://localhost/api/content/pipelines' },
  {
    route: 'content/pipelines/[id]',
    load: () => import('@/app/api/content/pipelines/[id]/route'),
    url: 'http://localhost/api/content/pipelines/pipeline-thumbnail-pack',
    params: { id: 'pipeline-thumbnail-pack' },
  },
  { route: 'content/queue', load: () => import('@/app/api/content/queue/route'), url: 'http://localhost/api/content/queue' },
  { route: 'departments', load: () => import('@/app/api/departments/route'), url: 'http://localhost/api/departments' },
  { route: 'funnel', load: () => import('@/app/api/funnel/route'), url: 'http://localhost/api/funnel' },
  { route: 'funnel/lead-message', load: () => import('@/app/api/funnel/lead-message/route'), url: 'http://localhost/api/funnel/lead-message?name=Smoke%20Test%20Lead' },
  { route: 'keys', load: () => import('@/app/api/keys/route'), url: 'http://localhost/api/keys' },
  { route: 'lab', load: () => import('@/app/api/lab/route'), url: 'http://localhost/api/lab?page=today&sample=1' },
  { route: 'lab/sheet', load: () => import('@/app/api/lab/sheet/route'), url: 'http://localhost/api/lab/sheet?post=fx-p-0001&sample=1' },
  // the fixture world's ids are stable (lib/lab/fixtures.ts FIXTURE_IDS), so the sample answers 200
  { route: 'lab/specimen', load: () => import('@/app/api/lab/specimen/route'), url: 'http://localhost/api/lab/specimen?post=fx-p-0001&sample=1' },
  { route: 'lab/script', load: () => import('@/app/api/lab/script/route'), url: 'http://localhost/api/lab/script?id=fx-script-1&sample=1' },
  { route: 'lab/runs', load: () => import('@/app/api/lab/runs/route'), url: 'http://localhost/api/lab/runs' },
  { route: 'lab/snapshots', load: () => import('@/app/api/lab/snapshots/route'), url: 'http://localhost/api/lab/snapshots' },
  // Content Lab v2 lane S (08.3.1, 09.7): the Setup view (internal) and the Run confirm's priced plan
  { route: 'lab/setup', load: () => import('@/app/api/lab/setup/route'), url: 'http://localhost/api/lab/setup?sample=1' },
  { route: 'lab/run', load: () => import('@/app/api/lab/run/route'), url: 'http://localhost/api/lab/run?sample=1' },
  // 05 (AC-05-34): blank DB answers 200 never_run; the event sheet reads the sample world's fixed id
  { route: 'lab/radar', load: () => import('@/app/api/lab/radar/route'), url: 'http://localhost/api/lab/radar' },
  { route: 'lab/radar/event', load: () => import('@/app/api/lab/radar/event/route'), url: 'http://localhost/api/lab/radar/event?id=fx-ev-e1&sample=1' },
  { route: 'lab/morning-brief', load: () => import('@/app/api/lab/morning-brief/route'), url: 'http://localhost/api/lab/morning-brief' },
  // Content Lab v2 ledger (06, AC-06-49)
  { route: 'lab/ledger', load: () => import('@/app/api/lab/ledger/route'), url: 'http://localhost/api/lab/ledger' },
  { route: 'lab/predictions', load: () => import('@/app/api/lab/predictions/route'), url: 'http://localhost/api/lab/predictions' },
  { route: 'lab/tests', load: () => import('@/app/api/lab/tests/route'), url: 'http://localhost/api/lab/tests' },
  { route: 'lab/tests/[id]', load: () => import('@/app/api/lab/tests/[id]/route'), url: 'http://localhost/api/lab/tests/fx-test-1?sample=1', params: { id: 'fx-test-1' } },
  { route: 'lab/planner', load: () => import('@/app/api/lab/planner/route'), url: 'http://localhost/api/lab/planner' },
  { route: 'lab/retention', load: () => import('@/app/api/lab/retention/route'), url: 'http://localhost/api/lab/retention?post=fx-p-0001&sample=1' },
  // Content Lab v2 lane G (07 7.16): each answers 200 on a blank install (empty rows, installed false, local-hash-v1)
  { route: 'lab/ask', load: () => import('@/app/api/lab/ask/route'), url: 'http://localhost/api/lab/ask?q=results-first%20hooks%20that%20broke%20out' },
  { route: 'lab/comments', load: () => import('@/app/api/lab/comments/route'), url: 'http://localhost/api/lab/comments?postId=fx-p-0001' },
  { route: 'lab/embeddings', load: () => import('@/app/api/lab/embeddings/route'), url: 'http://localhost/api/lab/embeddings' },
  { route: 'lab/rules', load: () => import('@/app/api/lab/rules/route'), url: 'http://localhost/api/lab/rules' },
  { route: 'life/map', load: () => import('@/app/api/life/map/route'), url: 'http://localhost/api/life/map' },
  { route: 'metrics', load: () => import('@/app/api/metrics/route'), url: 'http://localhost/api/metrics' },
  { route: 'roadmap', load: () => import('@/app/api/roadmap/route'), url: 'http://localhost/api/roadmap' },
  { route: 'social', load: () => import('@/app/api/social/route'), url: 'http://localhost/api/social' },
  { route: 'social/[platform]', load: () => import('@/app/api/social/[platform]/route'), url: 'http://localhost/api/social/instagram', params: { platform: 'instagram' } },
  { route: 'social/history', load: () => import('@/app/api/social/history/route'), url: 'http://localhost/api/social/history?limit=6' },
  { route: 'social/posts', load: () => import('@/app/api/social/posts/route'), url: 'http://localhost/api/social/posts' },
  { route: 'social/series', load: () => import('@/app/api/social/series/route'), url: 'http://localhost/api/social/series?metric=audience' },
  { route: 'social/sync', load: () => import('@/app/api/social/sync/route'), url: 'http://localhost/api/social/sync' },
  { route: 'tools', load: () => import('@/app/api/tools/route'), url: 'http://localhost/api/tools' },
  { route: 'ventures', load: () => import('@/app/api/ventures/route'), url: 'http://localhost/api/ventures' },
  { route: 'webhooks/manychat', load: () => import('@/app/api/webhooks/manychat/route'), url: 'http://localhost/api/webhooks/manychat' },
  { route: 'workflows', load: () => import('@/app/api/workflows/route'), url: 'http://localhost/api/workflows' },
  {
    // Answers 200 with an empty list when WhatsApp is absent — honest state, never a 500.
    route: 'whatsapp/thread',
    load: () => import('@/app/api/whatsapp/thread/route'),
    url: 'http://localhost/api/whatsapp/thread?jid=12345678901@lid',
  },
];

function discoverGetRoutes(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...discoverGetRoutes(path.join(dir, entry.name), rel));
    else if (entry.name === 'route.ts') {
      const src = readFileSync(path.join(dir, entry.name), 'utf8');
      if (/export\s+(async\s+)?function\s+GET/.test(src)) out.push(rel.replace(/\/route\.ts$/, ''));
    }
  }
  return out;
}

describe('platform smoke — every GET API route answers 200 with JSON', () => {
  test.each(ROUTES)('GET /api/$route', async ({ load, url, params }) => {
    const mod = await load();
    expect(mod.GET, 'route should export GET').toBeTypeOf('function');
    const res = (await mod.GET!(new Request(url), { params })) as Response;
    expect(res.status, `GET ${url} should be 200 (honest state, not 500/400)`).toBe(200);
    const body = await res.json();
    expect(body && typeof body === 'object').toBe(true);
  }, 20_000);

  test('the API smoke net covers every GET route under app/api (no route escapes)', () => {
    // skills/[slug] reads the local ~/.claude/skills dir at runtime (404 without
    // a slug on disk), so it is not a 200-required smoke route.
    // These 404 legitimately without on-disk data, and the avatar/media routes
    // serve raw bytes rather than JSON, so none is a 200-required smoke route.
    // tasks/export serves a CSV download; it has its own test in
    // tests/tasks-metrics.test.ts.
    const IGNORE = new Set([
      'skills/[slug]', 'wizard/projects/[id]', 'whatsapp/avatar/[key]', 'whatsapp/media',
      'tasks/export', 'creative-engine/campaigns/[id]', 'creative-engine/workflows/[id]',
      // 404s for an unknown workflow; covered in tests/workflow-versions.test.ts
      'workflows/[id]/versions',
      // 404s for an unknown workflow; covered in tests/creative-engine-workflow-run.test.ts
      'creative-engine/workflows/[id]/versions',
      // answers text/html "No sign-in in progress." with no params; its own test below (AC-08-4)
      'lab/oauth/[provider]/callback',
      // serves the contact sheet image (raw bytes, 404 without a sheet); covered in tests/lab-gen-frames.test.ts
      'lab/frames',
    ]);
    const discovered = discoverGetRoutes(path.join(process.cwd(), 'app', 'api')).filter((r) => !IGNORE.has(r)).sort();
    const covered = ROUTES.map((r) => r.route).sort();
    expect(covered).toEqual(discovered);
  });
});

// AC-01-28: the UI's two reads answer 200 for all six pages and all seven sheet kinds (fixture ids).
describe('Content Lab v2 page and sheet reads (AC-01-28)', () => {
  const PAGES = ['today', 'radar', 'breakouts', 'playbook', 'studio', 'ledger', 'creatorverse'];
  test.each(PAGES)('GET /api/lab?page=%s (sample and blank)', async (page) => {
    const { GET } = await import('@/app/api/lab/route');
    for (const q of [`page=${page}&sample=1`, `page=${page}`]) {
      const res = await GET(new Request(`http://localhost/api/lab?${q}`));
      expect(res.status, q).toBe(200);
      const body = (await res.json()) as { ok: boolean; view: { frame: { page: string } } };
      expect(body.view.frame.page).toBe(page);
    }
  }, 30_000);
  const SHEETS = ['post=fx-p-0001', 'event=fx-ev-e1', 'idea=fx-idea-1', 'script=fx-script-1', 'test=fx-test-1', 'test=new', 'setup=keys', 'ask=breakouts%20this%20month'];
  test.each(SHEETS)('GET /api/lab/sheet?%s', async (q) => {
    const { GET } = await import('@/app/api/lab/sheet/route');
    const res = await GET(new Request(`http://localhost/api/lab/sheet?${q}&sample=1`));
    expect(res.status, q).toBe(200);
    const body = (await res.json()) as { sheet: { kind: string; view: unknown } };
    expect(body.sheet.kind).toBe(q.split('=')[0]);
    expect(body.sheet.view, q).not.toBeNull();
  }, 30_000);
  test('an unknown id answers 200 with view null; no sheet param is a 400', async () => {
    const { GET } = await import('@/app/api/lab/sheet/route');
    const res = await GET(new Request('http://localhost/api/lab/sheet?post=nope&sample=1'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sheet: { view: unknown } }).sheet.view).toBeNull();
    expect((await GET(new Request('http://localhost/api/lab/sheet?sample=1'))).status).toBe(400);
  });
});

describe('Content Lab v2 lane S smoke (AC-08-4, 09.7)', () => {
  test('GET /api/lab/setup without sample answers 200', async () => {
    const { GET } = await import('@/app/api/lab/setup/route');
    expect((await GET(new Request('http://localhost/api/lab/setup'))).status).toBe(200);
  }, 20_000);
  test('GET /api/lab/oauth/youtube/callback with no params answers 200 "No sign-in in progress."', async () => {
    const { GET } = await import('@/app/api/lab/oauth/[provider]/callback/route');
    const res = await GET(new Request('http://localhost/api/lab/oauth/youtube/callback'), { params: { provider: 'youtube' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('No sign-in in progress.');
  });
  test('GET /api/lab/runs?batch=none answers 200 with batch null', async () => {
    const { GET } = await import('@/app/api/lab/runs/route');
    const res = await GET(new Request('http://localhost/api/lab/runs?batch=none'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, batch: null });
  });
});
