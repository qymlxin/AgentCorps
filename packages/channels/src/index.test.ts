import { describe, expect, it } from 'vitest';
import { GenericWebhookAdapter, MessageDeduplicator, signHmacSha256, verifyHmacSha256 } from './index.js';

describe('channel adapters', () => {
  it('normalizes a webhook message and formats an outbound reply', () => {
    const adapter = new GenericWebhookAdapter('feishu');
    const message = adapter.parseInbound({ message: { message_id: 'm1', conversation_id: 'c1', content: 'hello' }, sender: { sender_id: 'u1' } }, '2026-10-24T00:00:00.000Z');
    expect(message.text).toBe('hello');
    expect(adapter.formatOutbound({ channel: 'feishu', externalConversationId: 'c1', text: 'hi' })).toMatchObject({ conversation_id: 'c1' });
  });

  it('rejects duplicate messages and verifies signatures', () => {
    const dedupe = new MessageDeduplicator(1000, () => 1000);
    expect(dedupe.accept({ channel: 'dingtalk', externalMessageId: 'm1' })).toBe(true);
    expect(dedupe.accept({ channel: 'dingtalk', externalMessageId: 'm1' })).toBe(false);
    const signature = signHmacSha256('{"ok":true}', 'secret');
    expect(verifyHmacSha256('{"ok":true}', signature, 'secret')).toBe(true);
    expect(verifyHmacSha256('{"ok":false}', signature, 'secret')).toBe(false);
  });
});
