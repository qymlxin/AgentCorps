import { createHmac, timingSafeEqual } from 'node:crypto';

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
