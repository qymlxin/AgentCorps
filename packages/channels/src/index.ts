import { createHmac, timingSafeEqual } from 'node:crypto';
import { isRetryablePlatformError } from './platform.js';

export type ChannelKind = 'feishu' | 'dingtalk' | 'wecom' | 'custom';

export interface InboundMessage {
  readonly channel: ChannelKind;
  readonly externalMessageId: string;
  readonly externalUserId: string;
  readonly externalConversationId: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly raw: unknown;
}

export interface OutboundMessage {
  readonly channel: ChannelKind;
  readonly externalConversationId: string;
  readonly text: string;
  readonly replyToExternalMessageId?: string;
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  parseInbound(raw: unknown, receivedAt?: string): InboundMessage;
  formatOutbound(message: OutboundMessage): unknown;
}

export interface ChannelConnector {
  send(message: OutboundMessage, payload: unknown): Promise<ChannelDeliveryResult>;
}

export interface ChannelDeliveryResult {
  readonly statusCode: number;
  readonly attempts: number;
}

export interface HttpChannelConnectorOptions {
  readonly endpoint: string | ((message: OutboundMessage) => string);
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly validateResponse?: (response: Response) => Promise<void>;
}

export class HttpChannelConnector implements ChannelConnector {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpChannelConnectorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: OutboundMessage, payload: unknown): Promise<ChannelDeliveryResult> {
    const maxAttempts = positiveInteger(this.options.maxAttempts, 3);
    const timeoutMs = positiveInteger(this.options.timeoutMs, 10_000);
    const backoffMs = positiveInteger(this.options.backoffMs, 100);
    const endpoint = typeof this.options.endpoint === 'function' ? this.options.endpoint(message) : this.options.endpoint;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.options.headers },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === maxAttempts) throw lastError;
        await delay(backoffMs * attempt);
        continue;
      }
      if (response.ok) {
        try {
          await this.options.validateResponse?.(response);
        } catch (error) {
          if (isRetryablePlatformError(error) && attempt < maxAttempts) {
            await delay(retryAfterMs(response.headers.get('retry-after')) ?? backoffMs * attempt);
            continue;
          }
          throw error;
        }
        return { statusCode: response.status, attempts: attempt };
      }
      if (!retryableStatus(response.status) || attempt === maxAttempts) throw new Error(`Channel delivery failed: HTTP ${response.status}`);
      await delay(retryAfterMs(response.headers.get('retry-after')) ?? backoffMs * attempt);
    }
    throw lastError ?? new Error('Channel delivery failed');
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
export class GenericWebhookAdapter implements ChannelAdapter {
  constructor(readonly kind: ChannelKind) {}

  parseInbound(raw: unknown, receivedAt = new Date().toISOString()): InboundMessage {
    if (!raw || typeof raw !== 'object') throw new Error('Webhook payload must be an object');
    const payload = raw as Record<string, unknown>;
    const message = payload.message && typeof payload.message === 'object' ? payload.message as Record<string, unknown> : payload;
    const sender = payload.sender && typeof payload.sender === 'object' ? payload.sender as Record<string, unknown> : payload;
    const externalMessageId = String(message.message_id ?? message.msg_id ?? payload.messageId ?? '');
    const externalConversationId = String(message.conversation_id ?? message.chat_id ?? payload.conversationId ?? '');
    const externalUserId = String(sender.sender_id ?? sender.user_id ?? payload.userId ?? '');
    const text = String(message.text ?? message.content ?? payload.text ?? '');
    if (!externalMessageId || !externalConversationId || !externalUserId) throw new Error('Webhook payload is missing message, conversation, or user identity');
    return { channel: this.kind, externalMessageId, externalUserId, externalConversationId, text, receivedAt, raw };
  }

  formatOutbound(message: OutboundMessage): unknown {
    return { msg_type: 'text', conversation_id: message.externalConversationId, text: { content: message.text }, ...(message.replyToExternalMessageId ? { reply_to: message.replyToExternalMessageId } : {}) };
  }
}

export class MessageDeduplicator {
  private readonly seen = new Map<string, number>();
  constructor(private readonly retentionMs = 24 * 60 * 60 * 1000, private readonly now: () => number = () => Date.now()) {}

  accept(message: Pick<InboundMessage, 'channel' | 'externalMessageId'>): boolean {
    this.prune();
    const key = `${message.channel}:${message.externalMessageId}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, this.now());
    return true;
  }

  private prune(): void {
    const threshold = this.now() - this.retentionMs;
    for (const [key, timestamp] of this.seen) if (timestamp < threshold) this.seen.delete(key);
  }
}

export function signHmacSha256(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export function verifyHmacSha256(body: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(signHmacSha256(body, secret), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export * from './provider.js';
export * from './platform.js';
export * from './wecom.js';
export * from './state.js';
