export function parseDashboardOrigins(rawValue) {
  const source = String(rawValue || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

  return source
    .map(value => value.replace(/\/+$/, ''))
    .filter(Boolean);
}

export function resolveAllowedOrigin(origin, allowedOrigins) {
  if (!origin) {
    return null;
  }

  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    return null;
  }

  return allowedOrigins.includes(origin) ? origin : null;
}

export function normalizePhoneNumber(value) {
  return String(value ?? '')
    .replace(/[^\d]/g, '')
    .replace(/^00/, '')
    .replace(/^0+(?=\d)/, '');
}

export function isValidPhoneNumber(value) {
  return /^\d{10,15}$/.test(String(value ?? ''));
}

export function isValidUserId(value) {
  return typeof value === 'string' && /^[a-f0-9-]{16,64}$/i.test(value);
}
