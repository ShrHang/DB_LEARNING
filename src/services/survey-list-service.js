import { ObjectId } from 'mongodb';
import { AppError } from '../errors.js';
import { findOwnSurveyPage } from '../repositories/surveys.js';

export async function listSurveys(db, userId, query) {
  if (Object.keys(query).some(key => !['cursor', 'limit'].includes(key))) throw new AppError(400, 'INVALID_QUERY', '不支持的查询参数');
  const rawLimit = query.limit ?? '20';
  if (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 100) throw new AppError(400, 'INVALID_QUERY', 'limit 必须是 1—100 的整数');
  const limit = Number(rawLimit);
  let before = null;
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'createdAt,id' || !/^[a-f0-9]{24}$/.test(value.id) || typeof value.createdAt !== 'string') throw new Error();
      const createdAt = new Date(value.createdAt);
      if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value.createdAt) throw new Error();
      before = { createdAt, id: new ObjectId(value.id) };
    } catch {
      throw new AppError(400, 'INVALID_CURSOR', '分页游标不合法');
    }
  }
  const rows = await findOwnSurveyPage(db, { ownerId: new ObjectId(userId), before, limit });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(row => ({ id: row._id.toHexString(), title: row.title, description: row.description, status: row.status, deadlineAt: row.deadlineAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
  const last = items.at(-1);
  const nextCursor = hasMore ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url') : null;
  return { items, nextCursor };
}
