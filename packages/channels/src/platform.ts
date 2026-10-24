import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelAdapter, ChannelKind, InboundMessage, OutboundMessage } from './index.js';

export class PlatformApiError extends Error {
  constructor(readonly provider: ChannelKind, readonly code: number | string, message: string, readonly details?: unknown) {
    super(`${provider} API error ${code}: ${message}`);
    this.name = 'PlatformApiError';
  }
}

export function platformResponseValidator(channel: ChannelKind): (response: Response) => Promise<void> {
  return async (response) => {
    const body = await response.clone().json() as unknown;
    assertPlatformSuccess(channel, body);
  };
}

export function assertPlatformSuccess(channel: ChannelKind, body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const value = body as Record<string, unknown>;
  const code = value.code ?? value.errcode;
  if (code === undefined || code === 0 || code === '0') return;
  const message = String(value.msg ?? value.errmsg ?? 'Unknown platform error');
  throw new PlatformApiError(channel, typeof code === 'number' || typeof code === 'string' ? code : 'unknown', message, body);
}

export interface FeishuSignatureHeaders {
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}

export function signFeishuEvent(body: string, timestamp: string, nonce: string, encryptKey: string): string {
  return createHash('sha256').update(`${timestamp}${nonce}${encryptKey}${body}`, 'utf8').digest('hex');
}

export function verifyFeishuEventSignature(body: string, headers: FeishuSignatureHeaders, encryptKey: string): boolean {
  const expected = Buffer.from(signFeishuEvent(body, headers.timestamp, headers.nonce, encryptKey));
  const received = Buffer.from(headers.signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export interface FeishuEventPayload {
  readonly challenge?: string;
  readonly header?: { event_id?: string; event_type?: string };
  readonly event?: {
    readonly message?: { message_id?: string; chat_id?: string; content?: string; message_type?: string };
    readonly sender?: { sender_id?: { open_id?: string; user_id?: string; union_id?: string } };
  };
}

export class FeishuEventAdapter implements ChannelAdapter {
  readonly kind = 'feishu' as const;

  parseInbound(raw: unknown, receivedAt = new Date().toISOString()): InboundMessage {
    const payload = asRecord(raw) as FeishuEventPayload;
    const message = payload.event?.message;
    const sender = payload.event?.sender?.sender_id;
    if (payload.challenge) throw new Error('Feishu URL verification challenge must be handled before message parsing');
    const content = parseJsonObject(message?.content);
    const externalMessageId = required(message?.message_id, 'Feishu event message_id');
    const externalConversationId = required(message?.chat_id, 'Feishu event chat_id');
    const externalUserId = required(sender?.open_id ?? sender?.user_id ?? sender?.union_id, 'Feishu event sender id');
    if (message?.message_type && message.message_type !== 'text') throw new Error(`Unsupported Feishu message type: ${message.message_type}`);
    return { channel: this.kind, externalMessageId, externalConversationId, externalUserId, text: required(content.text, 'Feishu text content'), receivedAt, raw };
  }

  formatOutbound(message: OutboundMessage): unknown {
    return { receive_id: message.externalConversationId, msg_type: 'text', content: JSON.stringify({ text: message.text }) };
  }
}

export function signDingTalkCallback(timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}\n${secret}`, 'utf8').digest('base64');
}

export function verifyDingTalkCallbackSignature(timestamp: string, signature: string, secret: string, maxAgeMs = 5 * 60 * 1000, now = Date.now()): boolean {
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > maxAgeMs) return false;
  const expected = Buffer.from(signDingTalkCallback(timestamp, secret));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export interface DingTalkRobotPayload {
  readonly msgId?: string;
  readonly conversationId?: string;
  readonly senderStaffId?: string;
  readonly text?: { content?: string };
}

export class DingTalkRobotAdapter implements ChannelAdapter {
  readonly kind = 'dingtalk' as const;

  parseInbound(raw: unknown, receivedAt = new Date().toISOString()): InboundMessage {
    const payload = asRecord(raw) as DingTalkRobotPayload;
    return {
      channel: this.kind,
      externalMessageId: required(payload.msgId, 'DingTalk msgId'),
      externalConversationId: required(payload.conversationId, 'DingTalk conversationId'),
      externalUserId: required(payload.senderStaffId, 'DingTalk senderStaffId'),
      text: required(payload.text?.content, 'DingTalk text content').trim(),
      receivedAt,
      raw,
    };
  }

  formatOutbound(message: OutboundMessage): unknown {
    return { msgtype: 'text', text: { content: message.text } };
  }
}

export function signWecomCallback(token: string, timestamp: string, nonce: string, encryptedBody: string): string {
  return createHash('sha1').update([token, timestamp, nonce, encryptedBody].sort().join(''), 'utf8').digest('hex');
}

export function verifyWecomCallbackSignature(token: string, timestamp: string, nonce: string, encryptedBody: string, signature: string, maxAgeMs = 5 * 60 * 1000, now = Date.now()): boolean {
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > maxAgeMs) return false;
  const expected = Buffer.from(signWecomCallback(token, timestamp, nonce, encryptedBody));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export interface WecomMessagePayload {
  readonly MsgId?: string;
  readonly FromUserName?: string;
  readonly ToUserName?: string;
  readonly ChatId?: string;
  readonly Content?: string;
}

export class WecomMessageAdapter implements ChannelAdapter {
  readonly kind = 'wecom' as const;

  parseInbound(raw: unknown, receivedAt = new Date().toISOString()): InboundMessage {
    const payload = asRecord(raw) as WecomMessagePayload;
    return {
      channel: this.kind,
      externalMessageId: required(payload.MsgId, 'WeCom MsgId'),
      externalConversationId: required(payload.ChatId ?? payload.ToUserName, 'WeCom conversation id'),
      externalUserId: required(payload.FromUserName, 'WeCom FromUserName'),
      text: required(payload.Content, 'WeCom Content').trim(),
      receivedAt,
      raw,
    };
  }

  formatOutbound(message: OutboundMessage): unknown {
    return { touser: message.externalConversationId, msgtype: 'text', text: { content: message.text } };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Platform payload must be an object');
  return value as Record<string, unknown>;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) throw new Error('Message content is required');
  try { return asRecord(JSON.parse(value)); } catch { throw new Error('Message content must be valid JSON'); }
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value;
}
