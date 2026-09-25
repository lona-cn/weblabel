//! Log and protocol-message redaction.
//!
//! Secrets, cookies, authorization headers and image bytes must never appear in
//! logs or protocol messages. Secret *references* (config aliases, env/keyring
//! refs) are configuration, not secrets, and are preserved.

export const REDACTED = '[REDACTED]';
export const IMAGE_REDACTED = '[IMAGE_BYTES_REDACTED]';

const DATA_URL = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const SENSITIVE_HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi;
const AUTH_SCHEME = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const API_KEY = /\b(?:sk|tp)-[A-Za-z0-9_-]{8,}\b/g;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const KEYED_SECRET = /\b(api[-_]?key|api[-_]?secret|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret|token|session|cookie)([=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const BASE64_BLOB = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{256,}={0,2}(?![A-Za-z0-9+/=])/g;

const SENSITIVE_KEY = /(^|[._-])(secret|token|password|passwd|pwd|apikey|authorization|cookie|cookies|credential|credentials|bearer|private[-_]?key|api[-_]?key|access[-_]?key|secret[-_]?key|client[-_]?secret)([._-]|$)/i;
const REFERENCE_KEY = /(_ref|_alias)$/i;
const IMAGE_KEY = /(image|bytes|blob|data)/i;

export function redactText(text: string): string {
  return text
    .replace(DATA_URL, IMAGE_REDACTED)
    .replace(SENSITIVE_HEADER, (match, header: string) => `${header}: ${REDACTED}`)
    .replace(AUTH_SCHEME, (match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(API_KEY, REDACTED)
    .replace(JWT_LIKE, REDACTED)
    .replace(KEYED_SECRET, (match, key: string, separator: string) => `${key}${separator}${REDACTED}`)
    .replace(BASE64_BLOB, IMAGE_REDACTED);
}

export function redactValue(value: unknown, keyHint?: string): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return IMAGE_REDACTED;
  if (Array.isArray(value)) {
    const isImageBytes =
      keyHint !== undefined &&
      IMAGE_KEY.test(keyHint) &&
      value.length > 32 &&
      value.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255);
    if (isImageBytes) return IMAGE_REDACTED;
    return value.map((item) => redactValue(item, keyHint));
  }
  if (typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (REFERENCE_KEY.test(key)) redacted[key] = redactValue(item, key);
      else if (SENSITIVE_KEY.test(key)) redacted[key] = REDACTED;
      else redacted[key] = redactValue(item, key);
    }
    return redacted;
  }
  return undefined;
}
