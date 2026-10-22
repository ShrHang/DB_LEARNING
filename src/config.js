export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1—65535 的整数');
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET 至少需要 32 个字符，请配置 .env');
  const mongoUri = env.MONGODB_URI || 'mongodb://127.0.0.1:27018/?replicaSet=questionnaire-rs';
  const dbName = env.MONGODB_DB || 'questionnaire_dev';
  if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) throw new Error('MONGODB_DB 格式不合法');
  if (!['true', 'false', undefined].includes(env.COOKIE_SECURE)) throw new Error('COOKIE_SECURE 只能为 true 或 false');
  return { host: env.HOST || '127.0.0.1', port, mongoUri, dbName, sessionSecret: env.SESSION_SECRET, cookieSecure: env.COOKIE_SECURE === 'true' };
}
