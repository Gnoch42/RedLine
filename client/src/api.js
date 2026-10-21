const TOKEN_KEY = 'redline.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/**
 * Fetch a file and hand it to the browser as a download. A plain link cannot
 * carry the bearer token, so the bytes come back here and go out through an
 * object URL.
 */
export async function download(path) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || 'Could not download that.');
  }

  // filename*=UTF-8''... is what the server sends, so names keep their accents.
  const disposition = res.headers.get('content-disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : (plain || 'download');

  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Every call goes through here: same origin, bearer token, errors as exceptions. */
export async function api(path, { method = 'GET', body, signal } = {}) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) clearToken();
    throw new ApiError(res.status, data.error || 'Something went wrong.');
  }
  return data;
}
