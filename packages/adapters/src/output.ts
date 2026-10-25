export interface DecodedAgentOutput {
  readonly text?: string;
  readonly stream?: 'stdout' | 'stderr' | 'assistant';
  readonly error?: string;
}
export type AgentOutputDecoder = (value: unknown) => DecodedAgentOutput;

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Extracts only textual content, never tool argument objects or hidden reasoning blocks. */
export function messageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(messageText).filter((text): text is string => text !== undefined).join('') || undefined;
  const item = record(value);
  if (!item || (typeof item.type === 'string' && !['text', 'text_delta', 'output_text'].includes(item.type))) return undefined;
  return typeof item.text === 'string' ? item.text : undefined;
}

export function failureMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  const item = record(value);
  return typeof item?.message === 'string' ? item.message : 'External agent reported a failure';
}
