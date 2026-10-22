// Session cookies are browser managed; CSRF tokens live only in this module's memory.
let csrfToken = null;
let csrfRequest = null;

export class ApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = Array.isArray(details) ? details : [];
  }
}

async function send(path, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-CSRF-Token'] = token;
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务器，请检查网络后重试。');
  }
  if (response.status === 204 && response.ok) return undefined;
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(response.status, 'INVALID_RESPONSE', '服务器返回了无法识别的响应，请稍后重试。');
  }
  if (!response.ok) {
    if (response.status === 401) csrfToken = null;
    throw new ApiError(
      response.status,
      payload?.error?.code || 'REQUEST_FAILED',
      payload?.error?.message || '请求未能完成，请稍后重试。',
      payload?.error?.details,
    );
  }
  if (!payload || !Object.hasOwn(payload, 'data')) {
    throw new ApiError(response.status, 'INVALID_RESPONSE', '服务器响应缺少数据，请稍后重试。');
  }
  return payload.data;
}

export async function ensureCsrf() {
  if (csrfToken) return csrfToken;
  if (!csrfRequest) {
    csrfRequest = send('/auth/csrf').then((data) => {
      if (typeof data?.csrfToken !== 'string' || !data.csrfToken) {
        throw new ApiError(200, 'INVALID_RESPONSE', '无法获取会话凭证，请刷新页面后重试。');
      }
      csrfToken = data.csrfToken;
      return csrfToken;
    }).finally(() => { csrfRequest = null; });
  }
  return csrfRequest;
}

export async function request(path, { method = 'GET', body } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError('API 路径必须以单个 / 开头');
  }
  const verb = method.toUpperCase();
  const writing = !['GET', 'HEAD', 'OPTIONS'].includes(verb);
  const token = writing ? await ensureCsrf() : undefined;
  let data;
  try {
    data = await send(path, { method: verb, body, token });
  } catch (error) {
    // Retry only an explicit CSRF rejection, once; never replay network failures.
    if (!writing || error.status !== 403 || error.code !== 'CSRF_INVALID') throw error;
    csrfToken = null;
    data = await send(path, { method: verb, body, token: await ensureCsrf() });
  }
  if (path === '/auth/login' && verb === 'POST') {
    csrfToken = typeof data?.csrfToken === 'string' && data.csrfToken ? data.csrfToken : null;
  }
  if (path === '/auth/logout' && verb === 'POST') csrfToken = null;
  return data;
}
