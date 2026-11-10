/**
 * LLM connector — backs agent & Wizard chat through the Vercel AI Gateway.
 *
 * Mirrors the brain.ts provider shape: a real `gateway` provider (default) that
 * calls the AI SDK with a `"provider/model"` string, plus a `stub` provider
 * (LLM_PROVIDER=stub) that is deterministic and makes NO network call — so the
 * whole agent-chat stack is testable offline. Status stays honest: no
 * AI_GATEWAY_API_KEY ⇒ not_configured, never a fake "connected".
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { CRED_FILES, resolveCred } from '@/lib/creds';
import type { ConnectorStatus } from '@/lib/connectors/types';

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';
export type LlmMessage = { role: LlmRole; content: string };

export type LlmToolSpec = {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export type LlmToolCall = { name: string; args: unknown; result: unknown };

export type LlmChatRequest = {
  system?: string;
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  model?: string;
};

export type LlmChatResult = { text: string; toolCalls: LlmToolCall[] };

export interface LlmProvider {
  name: string;
  chat(req: LlmChatRequest): Promise<LlmChatResult>;
}

const GATEWAY_KEY = 'AI_GATEWAY_API_KEY';
const DEFAULT_MODEL = process.env.LLM_MODEL ?? 'anthropic/claude-sonnet-5';
/** The gateway model an agent with no stored model id runs on (the failover select's default, F9). */
export const LLM_DEFAULT_MODEL = DEFAULT_MODEL;

/** process.env first (Next auto-loads .env.local), then the operator's cred files. */
function resolveGatewayKey(): string | undefined {
  return resolveCred(GATEWAY_KEY, [CRED_FILES.agentsEnv, CRED_FILES.socialMedia]);
}

/** Stub trigger: a user message containing `use-tool:<name>` fires that tool. */
const STUB_TRIGGER = /use-tool:(\S+)/;

export const stubLlmProvider: LlmProvider = {
  name: 'stub',
  async chat(req) {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const text = lastUser ? `stub-reply: ${lastUser.content}` : 'stub-reply';
    const toolCalls: LlmToolCall[] = [];
    const trigger = lastUser?.content.match(STUB_TRIGGER);
    if (trigger && req.tools) {
      const spec = req.tools.find((t) => t.name === trigger[1]);
      if (spec) {
        const args: Record<string, unknown> = {};
        const result = await spec.execute(args);
        toolCalls.push({ name: spec.name, args, result });
      }
    }
    return { text, toolCalls };
  },
};

export function createGatewayProvider(model: string = DEFAULT_MODEL): LlmProvider {
  return {
    name: 'gateway',
    async chat(req) {
      // Fail fast with an honest message instead of letting the SDK hang —
      // and hydrate process.env from the operator's cred files so a key that
      // exists outside .env.local still works.
      const key = resolveGatewayKey();
      if (!key) {
        throw new Error('AI_GATEWAY_API_KEY is not set — add it to .env.local to enable agent chat.');
      }
      if (!process.env.AI_GATEWAY_API_KEY) process.env.AI_GATEWAY_API_KEY = key;
      const { generateText, tool, stepCountIs, gateway } = await import('ai');
      const tools = Object.fromEntries(
        (req.tools ?? []).map((t) => [
          t.name,
          tool({ description: t.description, inputSchema: t.parameters, execute: t.execute }),
        ]),
      );
      const messages = req.messages
        .filter((m) => m.role !== 'tool')
        .map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content }));

      const result = await generateText({
        model: gateway(req.model ?? model),
        system: req.system,
        messages,
        tools: req.tools?.length ? tools : undefined,
        stopWhen: stepCountIs(6),
      });

      const toolCalls: LlmToolCall[] = [];
      for (const step of result.steps ?? []) {
        const calls = step.toolCalls ?? [];
        const results = step.toolResults ?? [];
        for (const c of calls) {
          // Match the result to its call by id — a failed/missing tool result
          // can leave `toolResults` shorter than `toolCalls`, so positional
          // alignment would attach the wrong output to every later call.
          const hit = results.find((r) => r.toolCallId === c.toolCallId);
          toolCalls.push({ name: c.toolName, args: c.input, result: hit?.output });
        }
      }
      return { text: result.text, toolCalls };
    },
  };
}

/**
 * Subscription-backed provider (LLM_PROVIDER=claude-cli): shells out to the
 * Claude Code CLI, which bills the operator's Claude plan, never a metered key.
 * Metered keys are stripped from the child env so the CLI cannot fall back to
 * pay-per-token billing. Text only: the CLI cannot call this app's in-process
 * tools, so `tools` are ignored and `toolCalls` is always empty (honest, not faked).
 */
const METERED_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AI_GATEWAY_API_KEY', 'OPENAI_API_KEY'];

/** Render the transcript as one prompt; the CLI takes a single user turn on stdin. */
export function renderClaudeCliPrompt(req: LlmChatRequest): string {
  const label = { assistant: 'Assistant', system: 'System', user: 'User', tool: 'Tool' } as const;
  const lines = req.messages.filter((m) => m.role !== 'tool').map((m) => `${label[m.role]}: ${m.content}`);
  return `${lines.join('\n\n')}\n\nAssistant:`;
}

export function claudeCliEnv(base: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const env = { ...base } as NodeJS.ProcessEnv;
  for (const k of METERED_KEYS) delete env[k];
  return env;
}

export function createClaudeCliProvider(): LlmProvider {
  return {
    name: 'claude-cli',
    chat(req) {
      const bin = process.env.CLAUDE_CLI_BIN ?? 'claude';
      const timeoutMs = Number(process.env.CLAUDE_CLI_TIMEOUT_MS ?? 120_000);
      return new Promise<LlmChatResult>((resolve, reject) => {
        const args = ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', ''];
        if (req.system) args.push('--system-prompt', req.system);
        // Gateway-style ids ("anthropic/…") mean nothing to the CLI; only a bare alias is passed through.
        const model = req.model && !req.model.includes('/') ? req.model : process.env.CLAUDE_CLI_MODEL;
        if (model) args.push('--model', model);
        const child = spawn(bin, args, { env: claudeCliEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(new Error(`claude CLI not runnable (${e.message}). Install Claude Code and log in with your plan.`));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(out) as { result?: string; is_error?: boolean };
            if (code !== 0 || parsed.is_error) throw new Error(parsed.result ?? `exit ${code}`);
            resolve({ text: (parsed.result ?? '').trim(), toolCalls: [] });
          } catch (e) {
            reject(new Error(`claude CLI failed: ${(e as Error).message}${err ? ` · ${err.slice(0, 200)}` : ''}`));
          }
        });
        child.stdin.end(renderClaudeCliPrompt(req));
      });
    },
  };
}

export function getLlmProvider(): LlmProvider {
  const name = process.env.LLM_PROVIDER ?? 'gateway';
  if (name === 'stub') return stubLlmProvider;
  if (name === 'claude-cli') return createClaudeCliProvider();
  return createGatewayProvider();
}

export function chat(req: LlmChatRequest): Promise<LlmChatResult> {
  return getLlmProvider().chat(req);
}

export async function llmStatus(): Promise<ConnectorStatus> {
  const base = { id: 'llm', name: 'LLM (Gateway)', kind: 'orchestration' } as const;
  if (process.env.LLM_PROVIDER === 'stub') {
    return { ...base, state: 'connected', detail: 'stub provider active (tests)' };
  }
  if (process.env.LLM_PROVIDER === 'claude-cli') {
    return { ...base, state: 'connected', detail: 'Claude Code CLI on your plan (no metered key); text only, no tool calls' };
  }
  const key = resolveGatewayKey();
  if (!key) {
    return {
      ...base,
      state: 'not_configured',
      detail: 'Set AI_GATEWAY_API_KEY in .env.local to enable agent chat via the Vercel AI Gateway.',
    };
  }
  return { ...base, state: 'connected', detail: `Vercel AI Gateway · default model ${DEFAULT_MODEL}` };
}
