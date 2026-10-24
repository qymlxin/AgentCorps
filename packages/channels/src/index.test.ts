import { describe, expect, it } from 'vitest';
import { GenericWebhookAdapter, HttpChannelConnector, MessageDeduplicator, signHmacSha256, verifyHmacSha256 } from './index.js';

describe('channel adapters', () => {
  it('normalizes a webhook message and formats an outbound reply', () => {
    const adapter = new GenericWebhookAdapter('feishu');
    const message = adapter.parseInbound({ message: { message_id: 'm1', conversation_id: 'c1', content: 'hello' }, sender: { sender_id: 'u1' } }, '2026-10-24T00:00:00.000Z');
    expect(message.text).toBe('hello');
    expect(adapter.formatOutbound({ channel: 'feishu', externalConversationId: 'c1', text: 'hi' })).toMatchObject({ conversation_id: 'c1' });
  });

  it('retries transient HTTP failures and reports delivery attempts', async () => {
    let attempts = 0;
    const connector = new HttpChannelConnector({
      endpoint: 'https://channel.example/send',
      maxAttempts: 3,
      backoffMs: 1,
      fetchImpl: async () => {
        attempts += 1;
        return new Response(attempts === 3 ? '{}' : 'busy', { status: attempts === 3 ? 200 : 503 });
      },
    });
    await expect(connector.send({ channel: 'feishu', externalConversationId: 'c1', text: 'hello' }, { text: 'hello' })).resolves.toEqual({ statusCode: 200, attempts: 3 });
    expect(attempts).toBe(3);
  });

  it('does not retry a permanent HTTP failure', async () => {
    let attempts = 0;
    const connector = new HttpChannelConnector({ endpoint: 'https://channel.example/send', maxAttempts: 3, backoffMs: 1, fetchImpl: async () => { attempts += 1; return new Response('bad request', { status: 400 }); } });
    await expect(connector.send({ channel: 'wecom', externalConversationId: 'c1', text: 'hello' }, {})).rejects.toThrow('HTTP 400');
    expect(attempts).toBe(1);
  });
  it('retries transport failures and preserves endpoint headers and payload', async () => {
    let attempts = 0;
    let receivedUrl = '';
    let receivedRequest: RequestInit | undefined;
    const connector = new HttpChannelConnector({
      endpoint: (message) => `https://channel.example/${message.externalConversationId}`,
      headers: { authorization: 'Bearer test' },
      maxAttempts: 2,
      backoffMs: 1,
      fetchImpl: async (input, init) => {
        attempts += 1;
        receivedUrl = String(input);
        receivedRequest = init;
        if (attempts === 1) throw new Error('socket closed');
        return new Response('{}', { status: 201 });
      },
    });
    await expect(connector.send({ channel: 'custom', externalConversationId: 'c2', text: 'hello' }, { content: 'hello' })).resolves.toEqual({ statusCode: 201, attempts: 2 });
    expect(receivedUrl).toBe('https://channel.example/c2');
    expect(receivedRequest?.headers).toMatchObject({ authorization: 'Bearer test', 'content-type': 'application/json' });
    expect(receivedRequest?.body).toBe('{"content":"hello"}');
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
