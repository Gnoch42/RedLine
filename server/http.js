export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const denied = (msg = 'Not allowed.') => new HttpError(403, msg);
export const missing = (msg = 'Not found.') => new HttpError(404, msg);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);

/** Trim a required string field, or throw a 400 naming the field. */
export function str(body, field, { required = true, max = 20000 } = {}) {
  const raw = body?.[field];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value && required) throw bad(`"${field}" is required.`);
  if (value.length > max) throw bad(`"${field}" is too long (max ${max} characters).`);
  return value;
}

export function int(body, field, { min = 1, max = 10000 } = {}) {
  const value = Number(body?.[field]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw bad(`"${field}" must be a whole number between ${min} and ${max}.`);
  }
  return value;
}
