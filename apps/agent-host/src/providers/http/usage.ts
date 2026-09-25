//! Usage and cost normalization for provider responses.
//!
//! Unknown usage stays `null` — never zero — and a cost is only ever produced
//! from explicitly configured pricing. Providers that omit usage (MiMo
//! documents `usage: null`) therefore surface `cost_display: 'unknown'`.

export interface NormalizedUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

export interface TokenPricing {
  input_per_million_usd: number | null;
  output_per_million_usd: number | null;
}

function tokenCount(raw: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    return null;
  }
  return null;
}

function computeCost(input_tokens: number | null, output_tokens: number | null, pricing: TokenPricing | null): number | null {
  if (pricing === null) return null;
  const { input_per_million_usd, output_per_million_usd } = pricing;
  if (input_per_million_usd === null || output_per_million_usd === null) return null;
  if (!Number.isFinite(input_per_million_usd) || !Number.isFinite(output_per_million_usd)) return null;
  if (input_per_million_usd < 0 || output_per_million_usd < 0) return null;
  if (input_tokens === null || output_tokens === null) return null;
  return (input_tokens * input_per_million_usd + output_tokens * output_per_million_usd) / 1_000_000;
}

export function normalizeUsage(raw: unknown, pricing: TokenPricing | null = null): NormalizedUsage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { input_tokens: null, output_tokens: null, cost_usd: null };
  }
  const record = raw as Record<string, unknown>; // narrowed by the runtime check above
  const input_tokens = tokenCount(record, ['input_tokens', 'prompt_tokens']);
  const output_tokens = tokenCount(record, ['output_tokens', 'completion_tokens']);
  return { input_tokens, output_tokens, cost_usd: computeCost(input_tokens, output_tokens, pricing) };
}

function sumKnown(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

export function mergeUsage(a: NormalizedUsage, b: NormalizedUsage, pricing: TokenPricing | null = null): NormalizedUsage {
  const input_tokens = sumKnown(a.input_tokens, b.input_tokens);
  const output_tokens = sumKnown(a.output_tokens, b.output_tokens);
  const priced = computeCost(input_tokens, output_tokens, pricing);
  const cost_usd = priced !== null ? priced : a.cost_usd !== null && b.cost_usd !== null ? a.cost_usd + b.cost_usd : null;
  return { input_tokens, output_tokens, cost_usd };
}

export function costDisplay(usage: NormalizedUsage): 'known' | 'unknown' {
  return usage.cost_usd === null ? 'unknown' : 'known';
}
