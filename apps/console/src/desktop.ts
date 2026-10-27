import { invoke } from '@tauri-apps/api/core';
import type { Connection } from './api.js';

export interface DesktopGatewayStatus {
  readonly apiBase: string;
  readonly token: string;
  readonly managed: boolean;
}

interface DesktopGlobals {
  readonly __TAURI_INTERNALS__?: unknown;
  readonly __TAURI__?: unknown;
}

export function isDesktopRuntime(): boolean {
  const globals = globalThis as typeof globalThis & DesktopGlobals;
  return Boolean(globals.__TAURI_INTERNALS__ || globals.__TAURI__);
}

export async function ensureDesktopGateway(): Promise<Connection | undefined> {
  if (!isDesktopRuntime()) return undefined;
  const status = await invoke<DesktopGatewayStatus>('ensure_gateway');
  if (!status.managed || !status.token) return undefined;
  return { apiBase: status.apiBase, token: status.token };
}
