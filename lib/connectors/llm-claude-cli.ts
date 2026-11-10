/**
 * claude-cli LLM provider: runs agent and Wizard chat on the operator's Claude
 * subscription by spawning the local `claude` CLI in print mode, so no metered
 * API key is ever used (founder rule 2026-11-08: subscriptions only).
 *
 * Select it with LLM_PROVIDER=claude-cli. Honest limits:
 *   - Text only. The CLI is started with every tool disabled, so the in-process
 *     tool specs a caller passes are NOT callable here. A reply never carries
 *     tool calls. Anything that must act (send, spend, publish) goes through
 *     the approval queue, never through a model-chosen tool.
 *   - It uses the CLI's own login. ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN
 *     are stripped from the child environment so a stray key can never turn a
 *     subscription call into a metered one.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmChatRequest, LlmChatResult, LlmProvider } from '@/lib/connectors/llm';

export type ClaudeCliRun = (args: string[], stdin: string, opts: { timeoutMs: number }) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 120_000;
/** Env vars that would make the CLI bill an API key instead of the subscription. */
const METERED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const;

export function claudeBin(): string {
  return process.env.CLAUDE_BIN?.trim() || 'claude';
}

/** The child's environment with every metered-billing variable removed. */
export function subscriptionEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of METERED_ENV) delete env[k];
  return env;
}

/**
 * Gateway-style ids ("anthropic/claude-sonnet-5") become the CLI's aliases.
 * Anything unrecognised is passed through so a full model id still works.
 */
export function cliModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const id = model.replace(/^anthropic\//, '');
  if (/opus/i.test(id)) return 'opus';
  if (/sonnet/i.test(id)) return 'sonnet';
  if (/haiku/i.test(id)) return 'haiku';
  return id;
}

/** Flatten the chat into one prompt; the system text travels separately. */
export function renderTranscript(req: LlmChatRequest): string {
  const turns = req.messages.filter((m) => m.role !== 'tool');
  if (turns.length === 1 && turns[0].role === 'user') return turns[0].content;
  return turns.map((m) => `${m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User'}: ${m.content}`).join('\n\n');
}

export function buildArgs(req: LlmChatRequest, model: string | undefined): string[] {
  // Minimal session: without these flags a one-word reply loads this machine's
  // CLAUDE.md, skills, hooks and MCP servers (measured: 283k input tokens vs 557).
  // --bare is not used: it only authenticates with an API key, which is banned here.
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '',
    '--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands'];
  const m = cliModel(req.model ?? model);
  if (m) args.push('--model', m);
  if (req.system?.trim()) args.push('--system-prompt', req.system);
  return args;
}

/** Pull the reply text out of `--output-format json`. Throws on an error result. */
export function parseCliResult(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('claude CLI returned output that is not JSON');
  }
  const r = parsed as { is_error?: boolean; result?: unknown; error?: unknown };
  if (r.is_error) {
    throw new Error(`claude CLI reported an error: ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? r.error ?? 'unknown')}`);
  }
  if (typeof r.result !== 'string') throw new Error('claude CLI JSON has no result text');
  return r.result;
}

const realRun: ClaudeCliRun = (args, stdin, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    // An empty working directory so no project CLAUDE.md or settings are discovered.
    const cwd = mkdtempSync(join(tmpdir(), 'founderos-claude-'));
    const cleanup = () => rmSync(cwd, { recursive: true, force: true });
    const child = spawn(claudeBin(), args, { env: subscriptionEnv(), stdio: ['pipe', 'pipe', 'pipe'], cwd });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      cleanup();
      reject(new Error(`claude CLI timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`could not start the claude CLI (${claudeBin()}): ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      if (code === 0) resolve(out);
      else reject(new Error(`claude CLI exited ${code}: ${(err || out).trim().slice(0, 400)}`));
    });
    child.stdin.end(stdin);
  });

export function createClaudeCliProvider(opts: { run?: ClaudeCliRun; model?: string; timeoutMs?: number } = {}): LlmProvider {
  const run = opts.run ?? realRun;
  return {
    name: 'claude-cli',
    async chat(req: LlmChatRequest): Promise<LlmChatResult> {
      const stdout = await run(buildArgs(req, opts.model), renderTranscript(req), { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
      return { text: parseCliResult(stdout), toolCalls: [] };
    },
  };
}

/** True when the CLI binary starts. Does not prove a login, only that it is installed. */
export function claudeCliInstalled(): boolean {
  try {
    const r = spawnSync(claudeBin(), ['--version'], { env: subscriptionEnv(), timeout: 10_000, encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}
