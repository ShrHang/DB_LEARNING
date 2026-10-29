import { ObjectId } from 'mongodb';
import { AppError } from '../errors.js';
export const missing = () => new AppError(404, 'NOT_FOUND', '资源不存在或无权访问');
export const conflict = () => new AppError(409, 'REVISION_CONFLICT', '资源已更新，请重新加载后操作');
export function oid(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value)) throw missing();
  return new ObjectId(value);
}
export function fields(value, allowed, query = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new AppError(400, query ? 'INVALID_QUERY' : 'INVALID_BODY', '未知字段或格式错误');
}
export function revision(body) {
  if (!Number.isSafeInteger(body.revision) || body.revision < 1) throw new AppError(400, 'INVALID_REVISION', 'revision 必须是正整数');
  return body.revision;
}
export async function transaction(client, work) {
  const session = client.startSession();
  try { return await session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 10000 }); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError(503, 'TEMPORARY_UNAVAILABLE', '操作结果待确认，请重新加载确认后重试'); }
  finally { await session.endSession(); }
}
export function pageQuery(query, scope, keys = []) {
  fields(query, ['limit', 'cursor', ...keys], true);
  const raw = query.limit ?? '20';
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw) || Number(raw) > 100) throw new AppError(400, 'INVALID_QUERY', 'limit 必须为 1—100');
  let after = null;
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== 'string' || !/^[\w-]+$/.test(query.cursor)) throw Error();
      const bytes = Buffer.from(query.cursor, 'base64url');
      if (bytes.toString('base64url') !== query.cursor) throw Error();
      const data = JSON.parse(bytes.toString());
      if (Object.keys(data).sort().join(',') !== 'position,scope' || data.scope !== scope) throw Error();
      after = data.position;
    } catch { throw new AppError(400, 'INVALID_CURSOR', '游标不合法或与当前资源不匹配'); }
  }
  return { limit: Number(raw), after };
}
export function paged(rows, limit, scope, position = r => r.id) {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, nextCursor: hasMore ? Buffer.from(JSON.stringify({ scope, position: position(items.at(-1)) })).toString('base64url') : null };
}
export function afterId(after) {
  if (after === null) return {};
  if (typeof after !== 'string' || !/^[a-f0-9]{24}$/.test(after)) throw new AppError(400, 'INVALID_CURSOR', '游标位置错误');
  return { _id: { $lt: new ObjectId(after) } };
}
