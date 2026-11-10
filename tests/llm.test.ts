import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { chat, llmStatus } from '@/lib/connectors/llm';

const KEY = 'AI_GATEWAY_API_KEY';
const prevKey = process.env[KEY];
const prevProvider = process.env.LLM_PROVIDER;

afterEach(() => {
  if (prevKey === undefined) delete process.env[KEY];
  else process.env[KEY] = prevKey;
  if (prevProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = prevProvider;
  vi.restoreAllMocks();
});

describe('llmStatus — honest connector state', () => {
  test('not_configured when no gateway key is present', async () => {
    delete process.env[KEY];
    const status = await llmStatus();
    expect(status.state).toBe('not_configured');
    expect(status.kind).toBe('orchestration');
    expect(status.id).toBe('llm');
  });

  test('connected when the gateway key is present', async () => {
    process.env[KEY] = 'test-gateway-key';
    const status = await llmStatus();
    expect(status.state).toBe('connected');
    expect(status.detail.length).toBeGreaterThan(0);
  });
});

describe('stub provider chat — deterministic, no network', () => {
  test('echoes the last user message and makes no network call', async () => {
    process.env.LLM_PROVIDER = 'stub';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await chat({ messages: [{ role: 'user', content: 'hello there' }] });
    expect(res.text).toContain('hello there');
    expect(res.toolCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('executes a tool when the prompt carries the trigger token', async () => {
    process.env.LLM_PROVIDER = 'stub';
    let calledWith: unknown = 'NOT_CALLED';
    const res = await chat({
      messages: [{ role: 'user', content: 'use-tool:lookup find the thing' }],
      tools: [
        {
          name: 'lookup',
          description: 'look something up',
          parameters: z.object({}),
          execute: async (args) => {
            calledWith = args;
            return { ok: true, value: 42 };
          },
        },
      ],
    });
    expect(calledWith).not.toBe('NOT_CALLED');
    expect(res.toolCalls.map((c) => c.name)).toContain('lookup');
    expect(res.toolCalls[0].result).toEqual({ ok: true, value: 42 });
  });
});

describe('claude-cli provider — subscription only', () => {
  test('strips every metered key from the child env', async () => {
    const { claudeCliEnv } = await import('@/lib/connectors/llm');
    const env = claudeCliEnv({ ANTHROPIC_API_KEY: 'x', AI_GATEWAY_API_KEY: 'y', OPENAI_API_KEY: 'z', ANTHROPIC_AUTH_TOKEN: 'w', PATH: '/bin' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AI_GATEWAY_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  test('status reports connected without any gateway key', async () => {
    process.env.LLM_PROVIDER = 'claude-cli';
    delete process.env[KEY];
    const status = await llmStatus();
    expect(status.state).toBe('connected');
    expect(status.detail).toContain('no metered key');
  });

  test('renders the transcript as one prompt, dropping tool turns', async () => {
    const { renderClaudeCliPrompt } = await import('@/lib/connectors/llm');
    const prompt = renderClaudeCliPrompt({ messages: [{ role: 'user', content: 'hi' }, { role: 'tool', content: 'secret-tool-output' }] });
    expect(prompt).toContain('User: hi');
    expect(prompt).not.toContain('secret-tool-output');
  });

  test('a missing binary fails honestly instead of faking a reply', async () => {
    process.env.LLM_PROVIDER = 'claude-cli';
    process.env.CLAUDE_CLI_BIN = '/nonexistent/claude';
    try {
      await expect(chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/not runnable/);
    } finally {
      delete process.env.CLAUDE_CLI_BIN;
    }
  });
});
