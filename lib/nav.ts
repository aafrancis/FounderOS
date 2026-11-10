/**
 * Single source of truth for the app's primary navigation (SPEC S12). The
 * Sidebar renders NAV_GROUPS in order, the CommandPalette's digit shortcuts
 * and view commands derive from the same items, and every "which item is
 * active" question goes through activeHref(). Nothing else may hand-write a
 * list of views, so the sidebar, the palette, the Blueprint and the Wizard's
 * screen title can never drift apart.
 *
 * Grouped by what the operator is doing, not by how it is built:
 * command (untitled), Revenue, Growth, Workforce, Knowledge, System.
 */
import { Home, MessageSquare, MessagesSquare, Share2, Users, ListChecks, Sparkles, Network, Brain, Wallet, Filter, Handshake, Workflow, Map, Plug, BarChart3, Wrench, Waypoints, GitCompareArrows, Crosshair, Wand2, Clapperboard, FolderTree, MonitorSmartphone, FlaskConical, CandlestickChart, Briefcase, Magnet, Gauge, type LucideIcon, ShieldCheck } from 'lucide-react';
import { ENGINE_HREF, ENGINE_KEYWORDS, ENGINE_NAME, LEGACY_ENGINE_HREF } from '@/lib/creative-engine/name';

/** The one Wizard glyph (S08 FR-1, SPEC §5 C31): the nav item, the dock
 *  launcher and the topbar all read it from here. */
export const WizardIcon = Wand2;

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** ⌘K search terms (the label and the group title are searched as well). */
  keywords: string;
  /** Extra path prefixes that highlight this item (activeHref). */
  match?: string[];
  /** G1 class hook: the active pill reads the per-theme --adpilot-accent* tokens. */
  accent?: 'adpilot';
};

export type NavGroupId = 'command' | 'revenue' | 'growth' | 'workforce' | 'knowledge' | 'system';

export type NavGroup = {
  id: NavGroupId;
  /** null = no heading and no divider above the group (the command group). */
  title: string | null;
  /** Accessible group name; equals title except for the untitled top group. */
  label: string;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'command',
    title: null,
    label: 'Command',
    items: [
      { href: '/', label: 'Home', icon: Home, keywords: 'dashboard today overview start operator console' },
      { href: '/wizard', label: 'Wizard', icon: WizardIcon, keywords: 'chat agent conductor ask projects conversations' },
      { href: '/inbox', label: 'Comms', icon: MessageSquare, keywords: 'messages email whatsapp slack inbox unified feed' },
    ],
  },
  {
    id: 'revenue',
    title: 'Revenue',
    label: 'Revenue',
    items: [
      { href: '/funnel', label: 'Funnel', icon: Filter, keywords: 'pipeline leads attio ghl stages crm journeys' },
      {
        href: '/brand-deals',
        label: 'Brand Deals',
        icon: Handshake,
        keywords: 'deals sponsorship brands pipeline bdpilot telegram approval gsend unique journeys',
      },
      { href: '/clients', label: 'Clients', icon: Briefcase, keywords: 'client roster retainer confirmed requests briefs work superset drafts' },
      { href: '/finances', label: 'Finances', icon: Wallet, keywords: 'money revenue processors books stripe payments cash' },
      { href: '/trading', label: 'Trading', icon: CandlestickChart, keywords: 'markets robinhood phantom wallet stocks positions trades agent sleeve limits autopilot' },
    ],
  },
  {
    id: 'growth',
    title: 'Growth',
    label: 'Growth',
    items: [
      { href: '/social', label: 'Social', icon: Share2, keywords: 'instagram tiktok twitter x youtube linkedin followers audience publish zernio' },
      { href: '/adpilot', label: 'AdPilot', icon: Crosshair, keywords: 'paid media ads meta campaigns watchlist signals', accent: 'adpilot' },
      {
        href: ENGINE_HREF,
        label: ENGINE_NAME,
        icon: Clapperboard,
        keywords: ENGINE_KEYWORDS,
        match: [LEGACY_ENGINE_HREF],
        accent: 'adpilot',
      },
      { href: '/analytics', label: 'Analytics', icon: BarChart3, keywords: 'metrics numbers audience share runs outcomes' },
      {
        href: '/lab',
        label: 'Content Lab',
        icon: FlaskConical,
        keywords: 'viral breakouts creators apify scrape trends ideas scripts hooks formats specimens',
      },
      { href: '/lead-magnets', label: 'Lead Magnets', icon: Magnet, keywords: 'landing pages opt-in freebie captures leads email booking campaign' },
    ],
  },
  {
    id: 'workforce',
    title: 'Workforce',
    label: 'Workforce',
    items: [
      { href: '/agents', label: 'Agents', icon: Users, keywords: 'runtime run real roster team', match: ['/org'] },
      { href: '/chats', label: 'Chats', icon: MessagesSquare, keywords: 'chat conversations threads messages direct line talk agent' },
      { href: '/tasks', label: 'Tasks', icon: ListChecks, keywords: 'todo work board assignments' },
      { href: '/workflows', label: 'Workflows', icon: Workflow, keywords: 'automations canvas steps flows' },
      { href: '/skills', label: 'Skills', icon: Sparkles, keywords: 'capabilities skill library abilities' },
      { href: '/compute', label: 'Compute', icon: MonitorSmartphone, keywords: 'cloud computers machines desktops miosa' },
    ],
  },
  {
    id: 'knowledge',
    title: 'Knowledge',
    label: 'Knowledge',
    items: [
      {
        href: '/brain',
        label: 'Optimal Engine',
        icon: Brain,
        keywords: 'brain knowledge core markdown vector pgvector supabase embeddings zeroentropy graph doctor',
      },
      { href: '/database', label: 'Brain Files', icon: FolderTree, keywords: 'brain folder files disk storage treemap database' },
      { href: '/knowledge', label: 'Knowledge Visualizer', icon: Waypoints, keywords: 'graph connections load-bearing analysis' },
      { href: '/drift', label: 'Drift', icon: GitCompareArrows, keywords: 'canon contradictions conflicts resolutions' },
    ],
  },
  {
    id: 'system',
    title: 'System',
    label: 'System',
    items: [
      { href: '/setup', label: 'Settings', icon: Wrench, keywords: 'setup appearance style colour color accent theme mode dark light bring-up onboarding keys connectors wiring checklist install' },
      { href: '/integrations', label: 'Connections', icon: Plug, keywords: 'integrations tools status creds' },
      { href: '/usage', label: 'Usage', icon: Gauge, keywords: 'tokens burn claude codex chatgpt ollama plan limits models machines' },
      { href: '/blueprint', label: 'Blueprint', icon: Network, keywords: 'system map architecture reference model domains' },
      { href: '/roadmap', label: 'Roadmap', icon: Map, keywords: 'plan phases quarters' },
    ],
  },
];

/** Every sidebar item, top to bottom. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Visible top-to-bottom order across all groups. */
export const NAV_ORDER: string[] = NAV_ITEMS.map((i) => i.href);

/** Digit keys 1–9: the first nine views in visible order, minus AdPilot
 *  (reachable through ⌘K). 1 Home … 5 Brand Deals, 6 Clients, 7 Finances, 8 Trading, 9 Social. */
export const DIGIT_VIEWS: string[] = digitViewsFor([]);

/** The digit views with some modules switched off in Settings (lib/modules.ts):
 *  the keys close up over what is left, in the same visible order. */
export function digitViewsFor(off: readonly string[]): string[] {
  return NAV_ORDER.filter((href) => href !== '/adpilot' && !off.includes(href)).slice(0, 9);
}

/** Palette-only views: real pages that are deliberately not in the sidebar. */
export const NAV_EXTRA: NavItem[] = [
  { href: '/approvals', label: 'Approvals', icon: ShieldCheck, keywords: 'approve reject queue grants caps kill switch send spend publish permission arming' },
  { href: '/org', label: 'Org Chart', icon: Users, keywords: 'org chart hierarchy departments tree structure leads specialists' },
];

/** The group an href belongs to. */
export function groupOf(href: string): NavGroup | undefined {
  return NAV_GROUPS.find((g) => g.items.some((i) => i.href === href));
}

/**
 * The one sidebar href to highlight for a pathname, or null. Exact match
 * wins; otherwise the longest item href (or `match` alias) that is a path
 * prefix. `/` matches only `/`. Unknown paths highlight nothing rather than
 * the wrong thing.
 */
export function activeHref(pathname: string): string | null {
  const clean = (pathname.split(/[?#]/)[0] || '/').replace(/(.)\/+$/, '$1');
  let best: { href: string; len: number } | null = null;
  for (const item of NAV_ITEMS) {
    for (const prefix of [item.href, ...(item.match ?? [])]) {
      if (clean === prefix) {
        if (prefix === item.href) return item.href;
        if (!best || prefix.length + 1 > best.len) best = { href: item.href, len: prefix.length + 1 };
      } else if (prefix !== '/' && clean.startsWith(`${prefix}/`) && (!best || prefix.length > best.len)) {
        best = { href: item.href, len: prefix.length };
      }
    }
  }
  return best?.href ?? null;
}

/**
 * What a sidebar tooltip says for an item (SPEC S09 FR-14, S12 §4.4). In the
 * rail the group names are not visible, so the first item of each titled
 * group carries its group ("Revenue · Funnel"); the rest show their label.
 * The digit is the working 1–9 shortcut when the item has one.
 */
export function navTooltip(
  href: string,
  mode: 'rail' | 'full',
  off: readonly string[] = [],
): { group: string | null; label: string; digit: number | null } | null {
  for (const g of NAV_GROUPS) {
    const items = g.items.filter((it) => !off.includes(it.href));
    const i = items.findIndex((it) => it.href === href);
    if (i < 0) continue;
    const d = digitViewsFor(off).indexOf(href);
    return {
      group: mode === 'rail' && i === 0 && g.title ? g.title : null,
      label: items[i].label,
      digit: d >= 0 ? d + 1 : null,
    };
  }
  return null;
}
