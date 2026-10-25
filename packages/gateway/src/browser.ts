import { URL } from 'node:url';

export interface BrowserTab {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly type: string;
}

export interface BrowserSnapshot {
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
  readonly text: string;
}

export interface BrowserScreenshot {
  readonly tabId: string;
  readonly mimeType: 'image/png';
  readonly data: string;
}

export interface BrowserGatewayOptions {
  /** Chrome DevTools Protocol HTTP endpoint, for example http://127.0.0.1:9222. */
  readonly endpoint?: string;
  readonly allowControl?: boolean;
  readonly requireApproval?: boolean;
  readonly timeoutMs?: number;
  readonly maxTextBytes?: number;
  readonly maxScreenshotBytes?: number;
  readonly transport?: BrowserTransport;
}

export interface BrowserTransport {
  listTabs(): Promise<readonly BrowserTab[]>;
  command(tabId: string, method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

type BrowserSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  send(value: string): void;
  close(): void;
};

type BrowserSocketConstructor = new (url: string) => BrowserSocket;

class CdpTransport implements BrowserTransport {
  constructor(private readonly endpoint: string, private readonly timeoutMs: number) {}

  async listTabs(): Promise<readonly BrowserTab[]> {
    const endpoint = new URL('/json/list', this.endpoint);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`Browser DevTools endpoint returned ${response.status}`);
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw new Error('Browser DevTools endpoint returned an invalid tab list');
    return value.filter(isRecord).filter((tab) => tab.type === 'page' && typeof tab.id === 'string' && typeof tab.webSocketDebuggerUrl === 'string').map((tab) => ({
      id: String(tab.id), title: String(tab.title ?? ''), url: String(tab.url ?? ''), type: String(tab.type),
    }));
  }

  async command(tabId: string, method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    const tab = (await this.listTabs()).find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`Browser tab not found: ${tabId}`);
    const endpoint = new URL('/json/list', this.endpoint);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`Browser DevTools endpoint returned ${response.status}`);
    const tabs: unknown = await response.json();
    const record = Array.isArray(tabs) ? tabs.find((candidate) => isRecord(candidate) && candidate.id === tabId) : undefined;
    if (!isRecord(record) || typeof record.webSocketDebuggerUrl !== 'string') throw new Error(`Browser tab has no DevTools socket: ${tabId}`);
    return sendCdpCommand(record.webSocketDebuggerUrl, method, params, this.timeoutMs);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function socketConstructor(): BrowserSocketConstructor {
  const constructor = (globalThis as unknown as { WebSocket?: BrowserSocketConstructor }).WebSocket;
  if (!constructor) throw new Error('This Node.js runtime does not provide WebSocket support');
  return constructor;
}

function sendCdpCommand(socketUrl: string, method: string, params: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<unknown> {
  const socket = new (socketConstructor())(socketUrl);
  const id = Math.floor(Math.random() * 2 ** 31);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`Browser command timed out after ${timeoutMs} ms`)), timeoutMs);
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve(result);
    };
    socket.onopen = () => socket.send(JSON.stringify({ id, method, params }));
    socket.onmessage = (event) => {
      let message: unknown;
      try { message = JSON.parse(String(event.data)); } catch { return finish(new Error('Browser DevTools returned invalid JSON')); }
      if (!isRecord(message) || message.id !== id) return;
      if (isRecord(message.error)) return finish(new Error(String(message.error.message ?? 'Browser DevTools command failed')));
      finish(undefined, message.result);
    };
    socket.onerror = () => finish(new Error(`Unable to connect to browser tab: ${socketUrl}`));
    socket.onclose = () => finish(new Error('Browser DevTools connection closed before the command completed'));
  });
}

function transportFor(options: BrowserGatewayOptions): BrowserTransport {
  if (options.transport) return options.transport;
  const endpoint = options.endpoint ?? 'http://127.0.0.1:9222';
  const parsed = new URL(endpoint);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Browser endpoint must be an HTTP or HTTPS URL without credentials or query parameters');
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error('Browser timeoutMs must be between 100 and 120000');
  return new CdpTransport(parsed.toString(), timeoutMs);
}

function validateTabId(tabId: string): string {
  if (!tabId.trim() || tabId.length > 256 || /[\0\r\n]/.test(tabId)) throw new Error('Browser tabId must be a valid identifier');
  return tabId;
}

function validateSelector(selector: string): string {
  if (!selector.trim() || selector.length > 1024 || selector.includes('\0')) throw new Error('Browser selector must be between 1 and 1024 characters');
  return selector;
}

function stringLiteral(value: string): string {
  return JSON.stringify(value);
}

function evaluationValue(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.result)) throw new Error('Browser evaluation returned an invalid result');
  if (value.exceptionDetails) {
    const details = isRecord(value.exceptionDetails) ? value.exceptionDetails : {};
    throw new Error(String(details.text ?? 'Browser page evaluation failed'));
  }
  return value.result.value;
}

function textLimit(options: BrowserGatewayOptions): number {
  const limit = options.maxTextBytes ?? 256 * 1024;
  if (!Number.isInteger(limit) || limit < 1 || limit > 4 * 1024 * 1024) throw new Error('Browser maxTextBytes must be between 1 and 4194304');
  return limit;
}

export async function browserTabs(options: BrowserGatewayOptions): Promise<readonly BrowserTab[]> {
  return transportFor(options).listTabs();
}

export async function browserSnapshot(options: BrowserGatewayOptions, tabId: string): Promise<BrowserSnapshot> {
  const id = validateTabId(tabId);
  const value = await transportFor(options).command(id, 'Runtime.evaluate', {
    expression: `JSON.stringify({title: document.title, url: location.href, text: document.body?.innerText ?? ''})`,
    returnByValue: true,
  });
  const raw = evaluationValue(value);
  if (typeof raw !== 'string') throw new Error('Browser page did not return a snapshot');
  let snapshot: unknown;
  try { snapshot = JSON.parse(raw); } catch (error) { throw new Error('Browser page returned invalid snapshot JSON', { cause: error }); }
  if (!isRecord(snapshot)) throw new Error('Browser page returned an invalid snapshot');
  const text = String(snapshot.text ?? '');
  const limit = textLimit(options);
  const encoded = Buffer.from(text, 'utf8');
  return { tabId: id, title: String(snapshot.title ?? ''), url: String(snapshot.url ?? ''), text: encoded.byteLength <= limit ? text : encoded.subarray(0, limit).toString('utf8') };
}

export async function browserNavigate(options: BrowserGatewayOptions, tabId: string, target: string): Promise<{ tabId: string; url: string }> {
  const id = validateTabId(tabId);
  const parsed = new URL(target);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Browser navigation only supports HTTP and HTTPS URLs without credentials');
  await transportFor(options).command(id, 'Page.navigate', { url: parsed.toString() });
  return { tabId: id, url: parsed.toString() };
}

export async function browserClick(options: BrowserGatewayOptions, tabId: string, selector: string): Promise<{ tabId: string; selector: string }> {
  const id = validateTabId(tabId);
  const value = await transportFor(options).command(id, 'Runtime.evaluate', {
    expression: `(() => { const element = document.querySelector(${stringLiteral(validateSelector(selector))}); if (!element) throw new Error('Element not found'); element.click(); return true; })()`,
    returnByValue: true,
  });
  if (evaluationValue(value) !== true) throw new Error('Browser click did not complete');
  return { tabId: id, selector };
}

export async function browserFill(options: BrowserGatewayOptions, tabId: string, selector: string, text: string): Promise<{ tabId: string; selector: string }> {
  const id = validateTabId(tabId);
  if (text.length > 256 * 1024 || text.includes('\0')) throw new Error('Browser input text is too large or contains a null byte');
  const value = await transportFor(options).command(id, 'Runtime.evaluate', {
    expression: `(() => { const element = document.querySelector(${stringLiteral(validateSelector(selector))}); if (!element || !('value' in element)) throw new Error('Editable element not found'); element.focus(); element.value = ${stringLiteral(text)}; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
    returnByValue: true,
  });
  if (evaluationValue(value) !== true) throw new Error('Browser fill did not complete');
  return { tabId: id, selector };
}

export async function browserScreenshot(options: BrowserGatewayOptions, tabId: string): Promise<BrowserScreenshot> {
  const id = validateTabId(tabId);
  const value = await transportFor(options).command(id, 'Page.captureScreenshot', { format: 'png' });
  if (!isRecord(value) || typeof value.data !== 'string') throw new Error('Browser did not return a PNG screenshot');
  const maxBytes = options.maxScreenshotBytes ?? 4 * 1024 * 1024;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('Browser maxScreenshotBytes must be between 1 and 16777216');
  const data = String(value.data);
  if (Buffer.byteLength(data, 'base64') > maxBytes) throw new Error(`Browser screenshot exceeds the ${maxBytes}-byte limit`);
  return { tabId: id, mimeType: 'image/png', data };
}

export function browserHost(value: string): string {
  return new URL(value).hostname;
}
