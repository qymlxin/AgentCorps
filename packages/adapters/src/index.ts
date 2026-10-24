import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentDescriptor } from '@agentcorps/domain';
import type { AgentAdapter, AgentRequest } from '@agentcorps/runtime';

export interface JsonlAgentOptions {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly version?: string;
  readonly capabilities?: AgentDescriptor['capabilities'];
  readonly timeoutMs?: number;
  readonly maxLineBytes?: number;
}

interface OutputFrame {
  readonly type: 'output';
  readonly text: string;
  readonly stream?: 'stdout' | 'stderr' | 'assistant';
}

interface CompletedFrame {
  readonly type: 'completed';
}

interface ErrorFrame {
  readonly type: 'error';
  readonly message: string;
}

type AgentFrame = OutputFrame | CompletedFrame | ErrorFrame;

function isFrame(value: unknown): value is AgentFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return frame.type === 'output' || frame.type === 'completed' || frame.type === 'error';
}

function abortError(): Error {
  const error = new Error('Agent run cancelled');
  error.name = 'AbortError';
  return error;
}

export class JsonlAgentAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  private readonly options: JsonlAgentOptions;

  constructor(options: JsonlAgentOptions) {
    this.options = options;
    this.descriptor = {
      id: options.id,
      displayName: options.displayName,
      version: options.version ?? 'unknown',
      transport: 'stdio-jsonl',
      capabilities: options.capabilities ?? [],
    };
  }

  async execute(request: AgentRequest): Promise<void> {
    const options = this.options;
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 120_000;
    let settled = false;
    let completed = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (resolve: () => void, reject: (error: Error) => void, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    const promise = new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => finish(resolve, reject, error);
      const succeed = () => finish(resolve, reject);
      timeout = setTimeout(() => {
        child.kill('SIGTERM');
        fail(new Error(`Agent timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const abort = () => {
        child.kill('SIGTERM');
        fail(abortError());
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener('abort', abort, { once: true });

      child.once('error', (error) => fail(error));
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (Buffer.byteLength(text) <= maxLineBytes) request.emit(text, 'stderr');
      });

      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
          fail(new Error(`Agent output line exceeds ${maxLineBytes} bytes`));
          child.kill('SIGTERM');
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          request.emit(line, 'stdout');
          return;
        }
        if (!isFrame(value)) {
          request.emit(line, 'stdout');
          return;
        }
        if (value.type === 'output') request.emit(value.text, value.stream ?? 'assistant');
        if (value.type === 'error') fail(new Error(value.message));
        if (value.type === 'completed') {
          completed = true;
          succeed();
        }
      });

      child.once('close', (code, signal) => {
        if (settled) return;
        if (completed || code === 0) succeed();
        else fail(new Error(`Agent exited before completion (code=${code ?? 'null'}, signal=${signal ?? 'none'})`));
      });

      child.stdin.end(JSON.stringify({
        type: 'run',
        runId: request.runId,
        task: { id: request.task.id, objective: request.task.objective, mode: request.task.mode, workspaceId: request.task.workspaceId },
      }) + '\n');
    });

    await promise;
  }
}

export function createCodexAdapter(command = 'codex', args: readonly string[] = []): JsonlAgentAdapter {
  return new JsonlAgentAdapter({ id: 'codex-cli', displayName: 'OpenAI Codex CLI', command, args });
}

export function createClaudeCodeAdapter(command = 'claude', args: readonly string[] = []): JsonlAgentAdapter {
  return new JsonlAgentAdapter({ id: 'claude-code', displayName: 'Anthropic Claude Code', command, args });
}

export function createCursorAdapter(command = 'cursor-agent', args: readonly string[] = []): JsonlAgentAdapter {
  return new JsonlAgentAdapter({ id: 'cursor-cli', displayName: 'Cursor CLI', command, args });
}
