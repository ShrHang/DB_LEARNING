export class AppError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof AppError) return res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'JSON 格式错误', details: [] } });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: '请求内容过大', details: [] } });
  if (['charset.unsupported', 'encoding.unsupported'].includes(error.type)) return res.status(415).json({ error: { code: 'UNSUPPORTED_ENCODING', message: '请使用 UTF-8 JSON 及受支持的内容编码', details: [] } });
  if (['request.aborted', 'request.size.invalid'].includes(error.type)) return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '请求内容不完整或长度错误', details: [] } });
  req.app.get('logger').error(error);
  res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试', details: [] } });
}
