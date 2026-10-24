import { randomBytes } from 'node:crypto';
import { encryptWecomMessage, signWecomCallback } from './platform.js';

export interface WecomPassiveReply {
  readonly toUserName: string;
  readonly fromUserName: string;
  readonly content: string;
  readonly msgType?: 'text';
  readonly createTime?: number;
}

export function formatWecomPassiveReply(reply: WecomPassiveReply, encodingAesKey: string, token: string, nonce: string, timestamp = String(Math.floor(Date.now() / 1000)), random = randomBytes(16)): string {
  const message = `<xml><ToUserName><![CDATA[${cdata(reply.toUserName)}]]></ToUserName><FromUserName><![CDATA[${cdata(reply.fromUserName)}]]></FromUserName><CreateTime>${reply.createTime ?? Number(timestamp)}</CreateTime><MsgType><![CDATA[${reply.msgType ?? 'text'}]]></MsgType><Content><![CDATA[${cdata(reply.content)}]]></Content></xml>`;
  const encrypt = encryptWecomMessage(message, encodingAesKey, reply.fromUserName, random);
  const signature = signWecomCallback(token, timestamp, nonce, encrypt);
  return `<xml><Encrypt><![CDATA[${cdata(encrypt)}]]></Encrypt><MsgSignature><![CDATA[${cdata(signature)}]]></MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${cdata(nonce)}]]></Nonce></xml>`;
}

function cdata(value: string): string { return value.replaceAll(']]>', ']]&gt;'); }
