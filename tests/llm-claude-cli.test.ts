import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildArgs,
  claudeBin,
  cliModel,
  createClaudeCliProvider,
  parseCliResult,
  renderTranscript,
  subscriptionEnv,
} from '@/lib/connectors/llm-claude-cli';
import { getLlmProvider, llmStatus } from '@/lib/connectors/llm';

const prevProvider = process.env.LLM_PROVIDER;
const prevBin = process.env.CLAUDE_BIN;
afterEach(() => {
  if (prevProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevProvider;
  if (prevBin === undefined) delete process.env.CLAUDE_BIN;
  else process.env.CLAUDE_BIN = prevBin;
  vi.restoreAllMocks();
});

describe('claude-cli provider: subscription only', () => {
  test('strips every metered-billing variable from the child environment', () => {
    const env = subscriptionEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', PATH: '/bin' } as unknown as NodeJS.ProcessEnv);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  test('starts the CLI with every tool off and no session saved', () => {
    const args = buildArgs({ messages: [{ role: 'user', content: 'hi' }], system: 'be brief' }, undefined);
    expect(args).toContain('-p');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project');
    expect(args).not.toContain('--bare'); // --bare is API-key only
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('be brief');
    expect(args).not.toContain('--model');
  });

  test('maps gateway model ids to CLI aliases', () => {
    expect(cliModel('anthropic/claude-sonnet-5')).toBe('sonnet');
    expect(cliModel('anthropic/claude-opus-5-5')).toBe('opus');
    expect(cliModel('claude-haiku-5-5')).toBe('haiku');
    expect(cliModel('some-full-id')).toBe('some-full-id');
    expect(cliModel(undefined)).toBeUndefined();
    expect(cliModel('openai/gpt-5')).toBeUndefined(); // a non-Anthropic gateway id is not passed to the CLI
  });

  test('a CLI that exits before reading its stdin fails the chat cleanly (no unhandled EPIPE)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\nexit 1\n');
    chmodSync(bin, 0o755);
    vi.stubEnv('CLAUDE_BIN', bin);
    const p = createClaudeCliProvider({ timeoutMs: 10000 });
    await expect(p.chat({ messages: [{ role: 'user', content: 'x'.repeat(2_000_000) }] } as never)).rejects.toThrow(/exited 1/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a single user turn is sent verbatim; a longer chat is labelled', () => {
    expect(renderTranscript({ messages: [{ role: 'user', content: 'hello' }] })).toBe('hello');
    const multi = renderTranscript({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'tool', content: 'ignored' },
        { role: 'user', content: 'c' },
      ],
    });
    expect(multi).toBe('User: a\n\nAssistant: b\n\nUser: c');
  });
});

describe('claude-cli provider: chat', () => {
  test('returns the reply text and never any tool calls', async () => {
    const run = vi.fn(async (_args: string[], _stdin: string, _o: { timeoutMs: number }) => JSON.stringify({ is_error: false, result: 'pong' }));
    const p = createClaudeCliProvider({ run });
    const res = await p.chat({
      messages: [{ role: 'user', content: 'ping' }],
      tools: [{ name: 't', description: 'd', parameters: undefined as never, execute: async () => 1 }],
    });
    expect(res).toEqual({ text: 'pong', toolCalls: [] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toBe('ping');
  });

  test('an error result throws instead of returning fake text', async () => {
    const p = createClaudeCliProvider({ run: async () => JSON.stringify({ is_error: true, result: 'Not logged in' }) });
    await expect(p.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/Not logged in/);
  });

  test('non-JSON output and a missing result both throw', () => {
    expect(() => parseCliResult('oops')).toThrow(/not JSON/);
    expect(() => parseCliResult(JSON.stringify({ is_error: false }))).toThrow(/no result/);
  });
});

describe('claude-cli provider: wiring', () => {
  test('LLM_PROVIDER=claude-cli selects it', () => {
    process.env.LLM_PROVIDER = 'claude-cli';
    expect(getLlmProvider().name).toBe('claude-cli');
  });

  test('status is not_configured when the binary is missing, never a fake connected', async () => {
    process.env.LLM_PROVIDER = 'claude-cli';
    process.env.CLAUDE_BIN = '/nonexistent/claude-bin';
    expect(claudeBin()).toBe('/nonexistent/claude-bin');
    const s = await llmStatus();
    expect(s.state).toBe('not_configured');
    expect(s.detail).toMatch(/claude/i);
  });
});
