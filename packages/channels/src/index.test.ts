import { describe, expect, it } from 'vitest';
import { createDingTalkTokenProvider, createWecomTokenProvider, DingTalkRobotAdapter, FeishuEventAdapter, FeishuTenantTokenProvider, formatWecomPassiveReply, GenericWebhookAdapter, HttpChannelConnector, MessageDeduplicator, OAuthClientCredentialsTokenProvider, OAuthHttpChannelConnector, PlatformApiError, assertPlatformSuccess, encryptWecomMessage, parseWecomEncryptedInbound, platformResponseValidator, signDingTalkCallback, signFeishuEvent, signHmacSha256, signWecomCallback, SpacedRateLimiter, verifyDingTalkCallbackSignature, verifyFeishuEventSignature, verifyHmacSha256, verifyWecomCallbackSignature, WecomMessageAdapter } from './index.js';

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

  it('uses the official vendor token endpoints and caches their responses', async () => {
    const urls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      urls.push(String(input));
      if (String(input).includes('feishu')) return new Response(JSON.stringify({ tenant_access_token: 'feishu-token', expire: 7200 }), { status: 200 });
      if (String(input).includes('dingtalk')) return new Response(JSON.stringify({ access_token: 'dingtalk-token', expires_in: 7200 }), { status: 200 });
      return new Response(JSON.stringify({ access_token: 'wecom-token', expires_in: 7200 }), { status: 200 });
    };
    const feishu = new FeishuTenantTokenProvider({ appId: 'app', appSecret: 'secret', fetchImpl });
    const dingtalk = createDingTalkTokenProvider('key', 'secret', fetchImpl);
    const wecom = createWecomTokenProvider('corp', 'secret', fetchImpl);
    await expect(feishu.getToken()).resolves.toBe('feishu-token');
    await expect(feishu.getToken()).resolves.toBe('feishu-token');
    await expect(dingtalk.getToken()).resolves.toBe('dingtalk-token');
    await expect(wecom.getToken()).resolves.toBe('wecom-token');
    expect(urls).toEqual(expect.arrayContaining(['https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', 'https://oapi.dingtalk.com/gettoken?appkey=key&appsecret=secret', 'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=corp&corpsecret=secret']));
    expect(urls.filter((url) => url.includes('feishu'))).toHaveLength(1);
  });


  it('caches OAuth tokens and refreshes once after an unauthorized delivery', async () => {
    let tokenRequests = 0;
    const authorizationHeaders: string[] = [];
    const tokenProvider = new OAuthClientCredentialsTokenProvider({
      tokenEndpoint: 'https://auth.example/token', clientId: 'client', clientSecret: 'secret',
      fetchImpl: async (input) => {
        if (String(input) === 'https://auth.example/token') {
          tokenRequests += 1;
          return new Response(JSON.stringify({ access_token: `token-${tokenRequests}`, expires_in: 300 }), { status: 200 });
        }
        throw new Error('Unexpected token endpoint');
      },
    });
    const connector = new OAuthHttpChannelConnector({
      endpoint: 'https://vendor.example/send', tokenProvider, rateLimiter: new SpacedRateLimiter(1_000, 2), backoffMs: 1,
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers);
        authorizationHeaders.push(headers.get('authorization') ?? '');
        return new Response('{}', { status: authorizationHeaders.length === 1 ? 401 : 200 });
      },
    });
    await expect(connector.send({ channel: 'feishu', externalConversationId: 'c1', text: 'hello' }, {})).resolves.toEqual({ statusCode: 200, attempts: 1 });
    expect(tokenRequests).toBe(2);
    expect(authorizationHeaders).toEqual(['Bearer token-1', 'Bearer token-2']);
    await expect(tokenProvider.getToken()).resolves.toBe('token-2');
  });
  it('refreshes an unauthorized token independently for each delivery', async () => {
    let tokenRequests = 0;
    let deliveries = 0;
    const tokenProvider = new OAuthClientCredentialsTokenProvider({
      tokenEndpoint: 'https://auth.example/token', clientId: 'client', clientSecret: 'secret',
      fetchImpl: async () => new Response(JSON.stringify({ access_token: `token-${++tokenRequests}`, expires_in: 300 }), { status: 200 }),
    });
    const connector = new OAuthHttpChannelConnector({
      endpoint: 'https://vendor.example/send', tokenProvider, maxAttempts: 1,
      fetchImpl: async () => new Response('{}', { status: ++deliveries % 2 === 1 ? 401 : 200 }),
    });
    await expect(connector.send({ channel: 'feishu', externalConversationId: 'c1', text: 'one' }, {})).resolves.toMatchObject({ statusCode: 200 });
    await expect(connector.send({ channel: 'feishu', externalConversationId: 'c1', text: 'two' }, {})).resolves.toMatchObject({ statusCode: 200 });
    expect(tokenRequests).toBe(3);
  });


  it('parses official vendor message fixtures and verifies callback signatures', async () => {
    const feishuBody = JSON.stringify({ header: { event_id: 'evt-1' }, event: { message: { message_id: 'om-1', chat_id: 'oc-1', message_type: 'text', content: JSON.stringify({ text: 'hello' }) }, sender: { sender_id: { open_id: 'ou-1' } } } });
    expect(new FeishuEventAdapter().parseInbound(JSON.parse(feishuBody))).toMatchObject({ externalMessageId: 'om-1', externalConversationId: 'oc-1', externalUserId: 'ou-1', text: 'hello' });
    const feishuSignature = signFeishuEvent(feishuBody, '1700000000', 'nonce-1', 'encrypt-key');
    expect(verifyFeishuEventSignature(feishuBody, { timestamp: '1700000000', nonce: 'nonce-1', signature: feishuSignature }, 'encrypt-key')).toBe(true);

    expect(new DingTalkRobotAdapter().parseInbound({ msgId: 'msg-1', conversationId: 'cid-1', senderStaffId: 'staff-1', text: { content: 'hi' } })).toMatchObject({ externalMessageId: 'msg-1', externalConversationId: 'cid-1', externalUserId: 'staff-1', text: 'hi' });
    const dingTimestamp = String(Date.now());
    expect(verifyDingTalkCallbackSignature(dingTimestamp, signDingTalkCallback(dingTimestamp, 'ding-secret'), 'ding-secret')).toBe(true);

    expect(new WecomMessageAdapter().parseInbound({ MsgId: 'wx-1', FromUserName: 'user-1', ToUserName: 'corp-1', Content: 'hello' })).toMatchObject({ externalMessageId: 'wx-1', externalConversationId: 'corp-1', externalUserId: 'user-1', text: 'hello' });
    const wecomTimestamp = String(Math.floor(Date.now() / 1000));
    const encodingAesKey = Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '');
    const encrypted = encryptWecomMessage('<xml><MsgId><![CDATA[wx-2]]></MsgId><FromUserName><![CDATA[user-2]]></FromUserName><ToUserName><![CDATA[corp-1]]></ToUserName><Content><![CDATA[encrypted hello]]></Content></xml>', encodingAesKey, 'corp-1', Buffer.alloc(16, 1));
    expect(parseWecomEncryptedInbound(`<xml><ToUserName><![CDATA[corp-1]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`, encodingAesKey, 'corp-1')).toMatchObject({ MsgId: 'wx-2', FromUserName: 'user-2', Content: 'encrypted hello' });
    const replyXml = formatWecomPassiveReply({ toUserName: 'user-2', fromUserName: 'corp-1', content: 'received' }, encodingAesKey, 'wecom-token', 'nonce-reply', '1700000000', Buffer.alloc(16, 2));
    expect(parseWecomEncryptedInbound(replyXml, encodingAesKey, 'corp-1')).toMatchObject({ ToUserName: 'user-2', FromUserName: 'corp-1', Content: 'received' });


    expect(() => assertPlatformSuccess('dingtalk', { errcode: 40014, errmsg: 'invalid access_token' })).toThrow('dingtalk API error 40014');
    const connector = new HttpChannelConnector({ endpoint: 'https://vendor.example/send', maxAttempts: 3, validateResponse: platformResponseValidator('wecom'), fetchImpl: async () => new Response(JSON.stringify({ errcode: 81013, errmsg: 'no valid receiver' }), { status: 200 }) });
    await expect(connector.send({ channel: 'wecom', externalConversationId: 'c1', text: 'hello' }, {})).rejects.toThrow('wecom API error 81013');
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
