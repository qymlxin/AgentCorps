/** ACP v1 wire types used by the client and host boundary. */
export type AcpContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | { readonly type: 'audio'; readonly data: string; readonly mimeType: string }
  | { readonly type: 'resource'; readonly uri: string; readonly mimeType?: string; readonly text?: string }
  | { readonly type: string; readonly [key: string]: unknown };

export interface AcpToolCallContent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type AcpPlanEntryStatus = 'pending' | 'in_progress' | 'completed';
export type AcpPlanEntryPriority = 'high' | 'medium' | 'low';

export interface AcpToolCall {
  readonly toolCallId: string;
  readonly title: string;
  readonly kind?: string;
  readonly status?: AcpToolCallStatus;
  readonly content?: readonly AcpToolCallContent[];
  readonly locations?: readonly { readonly path: string; readonly line?: number }[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}

export interface AcpToolCallUpdate {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: AcpToolCallStatus;
  readonly content?: readonly AcpToolCallContent[];
  readonly locations?: readonly { readonly path: string; readonly line?: number }[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}

export interface AcpPlanEntry {
  readonly content: string;
  readonly priority: AcpPlanEntryPriority;
  readonly status: AcpPlanEntryStatus;
}

export interface AcpSessionUpdate {
  readonly sessionUpdate: string;
  readonly content?: AcpContentBlock;
  readonly toolCallId?: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: AcpToolCallStatus;
  readonly toolCall?: AcpToolCall;
  readonly toolCallUpdate?: AcpToolCallUpdate;
  readonly entries?: readonly AcpPlanEntry[];
  readonly plan?: readonly AcpPlanEntry[];
  readonly currentModeId?: string;
  readonly configOptions?: readonly AcpConfigOption[];
  readonly used?: number;
  readonly size?: number;
  readonly [key: string]: unknown;
}

export interface AcpConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly type?: string;
  readonly currentValue?: string;
  readonly options?: readonly { readonly value: string; readonly name: string; readonly description?: string }[];
  readonly [key: string]: unknown;
}

export interface AcpSessionUpdateParams {
  readonly sessionId: string;
  readonly update: AcpSessionUpdate;
}

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind?: string;
  readonly [key: string]: unknown;
}

export interface AcpPermissionRequest {
  readonly sessionId: string;
  readonly toolCall: AcpToolCall;
  readonly options: readonly AcpPermissionOption[];
}

export type AcpPermissionOutcome =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' };

export interface AcpPermissionResponse {
  readonly outcome: AcpPermissionOutcome;
}

export interface AcpTerminalExitStatus {
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface AcpTerminalOutputResponse {
  readonly output: string;
  readonly truncated: boolean;
  readonly exitStatus?: AcpTerminalExitStatus;
}

export interface AcpTerminalCreateParams {
  readonly sessionId: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeout?: number;
}

export interface AcpTerminalRef {
  readonly terminalId: string;
}

export interface AcpFileReadParams {
  readonly sessionId: string;
  readonly path: string;
  readonly line?: number;
  readonly limit?: number;
}

export interface AcpFileReadResponse { readonly content: string }
export interface AcpFileWriteParams { readonly sessionId: string; readonly path: string; readonly content: string }

export interface AcpSessionNewParams { readonly cwd: string; readonly mcpServers: readonly unknown[] }
export interface AcpSessionNewResult { readonly sessionId: string; readonly [key: string]: unknown }
export interface AcpSessionPromptParams { readonly sessionId: string; readonly prompt: readonly AcpContentBlock[] }
export interface AcpSessionPromptResult { readonly stopReason?: string; readonly [key: string]: unknown }
