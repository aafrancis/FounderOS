import { renderWithRouter } from './helpers/render-client';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The smoke net renders the GladOS trees, as it did before the client build (the brand tests run as)
// opened on Bennett Legacy (FounderOS ui merge T1). tests/smoke-legacy.test.ts renders under Legacy.
vi.mock('next/headers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/headers')>()),
  cookies: () => {
    const all = [{ name: 'glados-appearance', value: 'glados.ice.dark' }];
    return { get: (n: string) => all.find((c) => c.name === n), getAll: () => all, has: (n: string) => all.some((c) => c.name === n) };
  },
}));

// Pages read the DB path at first access, so point it at a fresh seeded temp DB
// before any page module is imported. FUNNEL_PROVIDER keeps /funnel off the
// live Attio API in tests.
beforeAll(() => {
  process.env.GLADOS_DB = path.join(mkdtempSync(path.join(tmpdir(), 'glados-smoke-')), 'test.db');
  process.env.FUNNEL_PROVIDER = 'seed';
  process.env.GBRAIN_BIN = path.join(tmpdir(), 'glados-no-gbrain-cli');
  // keep /usage off this machine's real transcripts (it reads them on a private instance)
  const emptyUsageDir = mkdtempSync(path.join(tmpdir(), 'glados-usage-'));
  process.env.CLAUDE_PROJECTS_DIR = emptyUsageDir;
  process.env.CODEX_SESSIONS_DIR = emptyUsageDir;
});

type PageEntry = {
  file: string; // path relative to app/, the source of truth for coverage
  // props is `any` so strongly-typed page components (e.g. /org's searchParams)
  // remain assignable to this generic invoker.
  load: () => Promise<{ default: (props?: any) => unknown }>;
  props?: unknown;
  /** client components use hooks and cannot be invoked as plain functions —
      still covered here so the "no page escapes" net stays complete */
  clientOnly?: boolean;
};

// Every app/**/page.tsx, with the props each needs to be invoked.
const PAGES: PageEntry[] = [
  { file: 'page.tsx', load: () => import('@/app/page') },
  { file: 'brand-deals/page.tsx', load: () => import('@/app/brand-deals/page') },
  // fo/clients (founderos-ui pages/clients.md, lead-magnets.md)
  { file: 'clients/page.tsx', load: () => import('@/app/clients/page'), props: { searchParams: {} } },
  { file: 'lead-magnets/page.tsx', load: () => import('@/app/lead-magnets/page'), props: { searchParams: {} } },
  { file: 'agents/setup/[id]/page.tsx', load: () => import('@/app/agents/setup/[id]/page'), props: { params: { id: 'crm-pulse' } } },
  { file: 'setup/page.tsx', load: () => import('@/app/setup/page') },
  { file: 'database/page.tsx', load: () => import('@/app/database/page') },
  { file: 'compute/page.tsx', load: () => import('@/app/compute/page') },
  { file: 'usage/page.tsx', load: () => import('@/app/usage/page'), props: { searchParams: {} } },
  { file: 'login/page.tsx', load: () => import('@/app/login/page'), clientOnly: true },
  { file: 'social/page.tsx', load: () => import('@/app/social/page') },
  { file: 'social/[platform]/page.tsx', load: () => import('@/app/social/[platform]/page'), props: { params: { platform: 'instagram' } } },
  { file: 'social/beehiiv/page.tsx', load: () => import('@/app/social/beehiiv/page') },
  { file: 'adpilot/page.tsx', load: () => import('@/app/adpilot/page'), props: { searchParams: {} } },
  { file: 'creative-engine/page.tsx', load: () => import('@/app/creative-engine/page'), props: { searchParams: {} } },
  { file: 'blueprint/page.tsx', load: () => import('@/app/blueprint/page') },
  { file: 'wizard/page.tsx', load: () => import('@/app/wizard/page') },
  { file: 'chats/page.tsx', load: () => import('@/app/chats/page'), props: { searchParams: {} } },
  { file: 'agents/page.tsx', load: () => import('@/app/agents/page') },
  { file: 'tasks/page.tsx', load: () => import('@/app/tasks/page') },
  { file: 'skills/page.tsx', load: () => import('@/app/skills/page') },
  { file: 'approvals/page.tsx', load: () => import('@/app/approvals/page'), props: {} },
  { file: 'org/page.tsx', load: () => import('@/app/org/page'), props: { searchParams: {} } },
  { file: 'brain/page.tsx', load: () => import('@/app/brain/page') },
  { file: 'knowledge/page.tsx', load: () => import('@/app/knowledge/page') },
  { file: 'drift/page.tsx', load: () => import('@/app/drift/page') },
  { file: 'finances/page.tsx', load: () => import('@/app/finances/page') },
  { file: 'trading/page.tsx', load: () => import('@/app/trading/page'), props: { searchParams: {} } },
  { file: 'funnel/page.tsx', load: () => import('@/app/funnel/page'), props: { searchParams: {} } },
  { file: 'inbox/page.tsx', load: () => import('@/app/inbox/page') },
  { file: 'workflows/page.tsx', load: () => import('@/app/workflows/page') },
  { file: 'integrations/page.tsx', load: () => import('@/app/integrations/page') },
  { file: 'integrations/whatsapp/page.tsx', load: () => import('@/app/integrations/whatsapp/page') },
  { file: 'roadmap/page.tsx', load: () => import('@/app/roadmap/page') },
  { file: 'analytics/page.tsx', load: () => import('@/app/analytics/page') },
  { file: 'lab/page.tsx', load: () => import('@/app/lab/page'), props: { searchParams: {} } },
  // Content Lab v2 route shells (S0); lane V replaces each with its page and keeps these entries.
  { file: 'lab/radar/page.tsx', load: () => import('@/app/lab/radar/page'), props: { searchParams: {} } },
  { file: 'lab/breakouts/page.tsx', load: () => import('@/app/lab/breakouts/page'), props: { searchParams: {} } },
  { file: 'lab/playbook/page.tsx', load: () => import('@/app/lab/playbook/page'), props: { searchParams: {} } },
  { file: 'lab/studio/page.tsx', load: () => import('@/app/lab/studio/page'), props: { searchParams: { sample: '1' } } },
  { file: 'lab/ledger/page.tsx', load: () => import('@/app/lab/ledger/page'), props: { searchParams: {} } },
  { file: 'lab/creatorverse/page.tsx', load: () => import('@/app/lab/creatorverse/page'), props: { searchParams: {} } },
  // Content Lab v2 frames gate (02 §16): standalone, no DB. Every state renders in tests/lab-frames-route.test.ts.
  { file: 'lab-frames/[state]/page.tsx', load: () => import('@/app/lab-frames/[state]/page'), props: { params: { state: 'default' } } },
  // Dev-only G kit gallery (lane 1d); notFound() in production, out of the nav.
  { file: 'dev/g-kit/page.tsx', load: () => import('@/app/dev/g-kit/page') },
  { file: 'dev/l-kit/page.tsx', load: () => import('@/app/dev/l-kit/page') },
];

function discoverPages(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...discoverPages(path.join(dir, entry.name), rel));
    else if (entry.name === 'page.tsx') out.push(rel);
  }
  return out;
}

describe('platform smoke — every page renders without throwing', () => {
  // 20s: pages that shell out to the gbrain CLI or distill the brain-store
  // (/, /brain) legitimately exceed vitest's 5s default under a loaded
  // parallel suite — this is a does-it-throw net, not a performance gate.
  test.each(PAGES)('$file renders', async ({ load, props, clientOnly }) => {
    const mod = await load();
    const Page = mod.default;
    if (clientOnly) {
      // module loads and exports a component; rendering needs a DOM
      expect(typeof Page).toBe('function');
      return;
    }
    // Server components run their body (DB reads, data fetch) when invoked;
    // a throw here is exactly the failure we want to catch.
    await expect(Promise.resolve(Page(props))).resolves.toBeTruthy();
  }, 20_000);

  test('the smoke net covers every app/**/page.tsx (no page escapes)', () => {
    const discovered = discoverPages(path.join(process.cwd(), 'app')).sort();
    const covered = PAGES.map((p) => p.file).sort();
    expect(covered).toEqual(discovered);
  });

  // Content Lab v2 lane G (07 AC-07-57): Studio with a script sheet open and Ask with a query
  test.each([
    { name: 'lab/studio?script=', load: () => import('@/app/lab/studio/page'), props: { searchParams: { sample: '1', script: 'fx-script-1' } } },
    { name: 'lab?ask=', load: () => import('@/app/lab/page'), props: { searchParams: { sample: '1', ask: 'results-first hooks that broke out' } } },
  ])('$name renders', async ({ load, props }) => {
    const Page = (await load()).default as (p: unknown) => unknown;
    await expect(Promise.resolve(Page(props))).resolves.toBeTruthy();
  }, 20_000);
});

/**
 * Content Lab v2 (01 AC-01-2): the six routes render to markup on the real empty install and on the
 * sample world, with a sheet open, so a throw in a page body or the frame fails here.
 */
describe('Content Lab v2 routes render', () => {
  const realError = console.error;
  const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { if (!String(a[0]).includes('useLayoutEffect does nothing on the server')) realError(...a); });
  afterAll(() => spy.mockRestore());
  const ROUTES = [
    ['today', () => import('@/app/lab/page')],
    ['radar', () => import('@/app/lab/radar/page')],
    ['breakouts', () => import('@/app/lab/breakouts/page')],
    ['playbook', () => import('@/app/lab/playbook/page')],
    ['studio', () => import('@/app/lab/studio/page')],
    ['ledger', () => import('@/app/lab/ledger/page')],
    ['creatorverse', () => import('@/app/lab/creatorverse/page')],
  ] as const;
  test.each(ROUTES)('/lab %s: blank and sample', async (_id, load) => {
    const { default: Page } = await load();
    for (const searchParams of [{}, { sample: '1' }, { sample: '1', post: 'fx-p-0001' }]) {
      const html = renderWithRouter((await Page({ searchParams })) as ReactElement);
      expect(html).toContain('data-lab-root');
      expect(html).toContain('Content Lab');
    }
  }, 60_000);
});

/**
 * Phase 4 (SPEC §10): the Creative Engine states the page-level net above
 * does not reach. Each renders to markup (client components included), so a
 * throw in the Dashboard body fails here, not only in a browser.
 */
describe('Creative Engine states render', () => {
  // Static markup skips layout effects by design; React's SSR warning about them is noise here.
  const realError = console.error;
  const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { if (!String(a[0]).includes('useLayoutEffect does nothing on the server')) realError(...a); });
  afterAll(() => spy.mockRestore());
  const render = async (searchParams: Record<string, string>) => {
    const { default: Page } = await import('@/app/creative-engine/page');
    return renderToStaticMarkup((await Page({ searchParams })) as ReactElement);
  };
  const withEmptyStores = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'glados-smoke-ce-'));
    const keys = ['CREATIVE_ENGINE_STORE_DIR', 'CREATIVE_ENGINE_ASSET_DIR', 'ADSCOUT_STORE_DIR'] as const;
    const prev = keys.map((k) => process.env[k]);
    process.env.CREATIVE_ENGINE_STORE_DIR = path.join(dir, 'creative-engine');
    process.env.CREATIVE_ENGINE_ASSET_DIR = path.join(dir, 'assets');
    process.env.ADSCOUT_STORE_DIR = path.join(dir, 'ad-intel');
    try {
      return await fn();
    } finally {
      keys.forEach((k, i) => (prev[i] === undefined ? delete process.env[k] : (process.env[k] = prev[i])));
    }
  };

  test('empty campaigns: the pill reads New concept and nothing pretends to be loaded', async () => {
    const html = await withEmptyStores(() => render({}));
    expect(html).toContain('data-creative-engine');
    expect(html).toContain('Creative engine');
    expect(html).toContain('New concept');
    expect(html).not.toContain('Sample data');
  }, 20_000);

  test('?sample=1: the badged fictional preview', async () => {
    const html = await withEmptyStores(() => render({ sample: '1' }));
    expect(html).toContain('Sample data');
    expect(html).toContain('Lumen Desk');
  }, 20_000);

  test('/adpilot?ad= with an id that is nowhere still renders (the toast is client-side)', async () => {
    const { default: Page } = await import('@/app/adpilot/page');
    const html = await withEmptyStores(async () => renderToStaticMarkup(Page({ searchParams: { ad: 'not-stored' } }) as ReactElement));
    // Classic renders the [data-adpilot] deck, the GladOS style its .ap-g page (lib/g-ready.ts)
    expect(html).toMatch(/data-adpilot|class="g-page ap-g"/);
  }, 20_000);
});
