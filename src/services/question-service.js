import { storageQuestions } from '../repositories/surveys.js';
import { ObjectId } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../errors.js';
import { questionContent, validateQuestionContent, CONTENT_FIELDS } from '../shared/question-content.js';
import { oid, fields, revision, missing, conflict, transaction, pageQuery, paged, afterId } from './library-common.js';

export function createQuestionService({ db, client, clock = { now: () => Date.now() }, hooks = {} }) {
  const questions = db.collection('questions');
  const versions = db.collection('questionVersions');
  const shares = db.collection('questionShares');
  const now = () => new Date(clock.now());
  const id = value => value.toHexString();
  const publicQuestion = q => ({ id: id(q._id), owned: q.ownerId.toHexString(), archived: q.archived, revision: q.revision, latestNumber: q.nextVersion - 1, createdAt: q.createdAt, updatedAt: q.updatedAt });
  const publicVersion = v => ({ id: id(v._id), questionId: id(v.questionId), number: v.number, parentVersionId: v.parentVersionId ? id(v.parentVersionId) : null, sourceVersionId: v.sourceVersionId ? id(v.sourceVersionId) : null, operation: v.operation, content: v.content, createdAt: v.createdAt });
  function contentOf(content) {
    const result = validateQuestionContent(content);
    if (!result.valid) throw new AppError(422, 'VALIDATION_FAILED', '独立题目须完整合法', result.errors);
    return questionContent(content);
  }
  async function access(userId, questionId, session, { owner = false, usable = false, touch = false } = {}) {
    const q = await questions.findOne({ _id: oid(questionId) }, { session });
    if (!q) throw missing();
    const owned = q.ownerId.equals(oid(userId));
    if (!owned && (owner || !await shares.findOne({ questionId: q._id, userId: oid(userId) }, { session }))) throw missing();
    if (usable && q.archived) throw new AppError(409, 'QUESTION_ARCHIVED', '题目已归档，不能新增使用');
    if (touch) await hooks.beforeTouch?.({ session, question: q });
    if (touch) await questions.updateOne({ _id: q._id }, { $set: { token: new ObjectId() } }, { session });
    return q;
  }
  async function version(questionId, versionId, session) {
    const v = await versions.findOne({ _id: oid(versionId), questionId: oid(questionId) }, { session });
    if (!v) throw missing();
    return v;
  }
  async function insert(userId, content, session, sourceVersionId = null) {
    const q = { _id: new ObjectId(), ownerId: oid(userId), archived: false, nextVersion: 2, revision: 1, token: new ObjectId(), createdAt: now(), updatedAt: now(), schemaVersion: 1 };
    const v = { _id: new ObjectId(), questionId: q._id, number: 1, parentVersionId: null, sourceVersionId, operation: sourceVersionId ? 'fork' : 'create', content: contentOf(content), createdAt: now(), schemaVersion: 1 };
    await questions.insertOne(q, { session });
    await versions.insertOne({ ...v, content: storageQuestions([v.content])[0] }, { session });
    return { question: { ...publicQuestion(q), owned: true }, version: publicVersion(v) };
  }
  async function versionView(v, userId) {
    let source = null;
    if (v.sourceVersionId) {
      const origin = await versions.findOne({ _id: v.sourceVersionId });
      if (origin) {
        try {
          await access(userId, id(origin.questionId));
          source = { questionId: id(origin.questionId), versionId: id(origin._id), number: origin.number, title: origin.content.title };
        } catch (error) { if (error.status !== 404) throw error; }
      }
    }
    return { ...publicVersion(v), source };
  }
  async function view(q, userId) {
    const latest = await versions.findOne({ questionId: q._id }, { sort: { number: -1 } });
    return { ...publicQuestion(q), owned: q.ownerId.equals(oid(userId)), latest: await versionView(latest, userId) };
  }
  return {
    access, version, insert,
    async create(userId, body) {
      fields(body, ['content']);
      const content = contentOf(body.content);
      return transaction(client, s => insert(userId, content, s));
    },
    async get(userId, questionId, query = {}) {
      fields(query, [], true);
      return view(await access(userId, questionId), userId);
    },
    async list(userId, query = {}) {
      const scope = `questions:${userId}:${query.scope ?? 'own'}:${query.archived ?? 'false'}`;
      const { limit, after } = pageQuery(query, scope, ['scope', 'archived']);
      if (!['own', 'shared'].includes(query.scope ?? 'own') || !['true', 'false'].includes(query.archived ?? 'false')) throw new AppError(400, 'INVALID_QUERY', '列表筛选无效');
      let filter = { ownerId: oid(userId) };
      if (query.scope === 'shared') filter = { _id: { $in: (await shares.find({ userId: oid(userId) }).toArray()).map(s => s.questionId) } };
      const rows = await questions.find({ $and: [filter, afterId(after), { archived: query.archived === 'true' }] }).sort({ _id: -1 }).limit(limit + 1).toArray();
      return paged(await Promise.all(rows.map(q => view(q, userId))), limit, scope);
    },
    async listVersions(userId, questionId, query = {}) {
      await access(userId, questionId);
      const scope = `versions:${questionId}`;
      const { limit, after } = pageQuery(query, scope);
      if (after !== null && (!Number.isSafeInteger(after) || after < 1)) throw new AppError(400, 'INVALID_CURSOR', '版本游标错误');
      const rows = await versions.find({ questionId: oid(questionId), ...(after === null ? {} : { number: { $lt: after } }) }).sort({ number: -1 }).limit(limit + 1).toArray();
      return paged(await Promise.all(rows.map(v => versionView(v, userId))), limit, scope, v => v.number);
    },
    async getVersion(userId, questionId, versionId, query = {}) {
      fields(query, [], true);
      await access(userId, questionId);
      return versionView(await version(questionId, versionId), userId);
    },
    async addVersion(userId, questionId, body) {
      fields(body, ['revision', 'parentVersionId', 'operation', 'content']);
      revision(body);
      if (!['edit', 'restore'].includes(body.operation)) throw new AppError(400, 'INVALID_BODY', 'operation 须为 edit 或 restore');
      if (body.operation === 'restore' && Object.hasOwn(body, 'content')) throw new AppError(400, 'INVALID_BODY', '恢复使用原版本内容');
      return transaction(client, async session => {
        const q = await access(userId, questionId, session, { owner: true, usable: true });
        if (q.revision !== body.revision) throw conflict();
        const parent = await version(questionId, body.parentVersionId, session);
        const content = body.operation === 'restore' ? parent.content : contentOf(body.content);
        if (body.operation === 'edit' && isDeepStrictEqual(content, parent.content)) return { version: publicVersion(parent), unchanged: true };
        const parentOptions = new Set((parent.content.options ?? []).map(o => o.id));
        const newOptions = (content.options ?? []).filter(o => !parentOptions.has(o.id)).map(o => o.id);
        if (newOptions.length && await versions.findOne({ questionId: q._id, 'content.options.id': { $in: newOptions } }, { session })) throw new AppError(422, 'OPTION_ID_REUSED', '新增选项不能复用其他历史版本中已存在的 ID');
        const v = { _id: new ObjectId(), questionId: q._id, number: q.nextVersion, parentVersionId: parent._id, sourceVersionId: null, operation: body.operation, content, createdAt: now(), schemaVersion: 1 };
        const updated = await questions.updateOne({ _id: q._id, revision: q.revision }, { $inc: { nextVersion: 1, revision: 1 }, $set: { token: new ObjectId(), updatedAt: now() } }, { session });
        if (!updated.matchedCount) throw conflict();
        await versions.insertOne({ ...v, content: storageQuestions([v.content])[0] }, { session });
        await hooks.afterVersion?.({ session, version: v });
        return { version: publicVersion(v), unchanged: false };
      });
    },
    async fork(userId, questionId, body) {
      fields(body, ['versionId']);
      return transaction(client, async session => {
        await access(userId, questionId, session, { usable: true, touch: true });
        const v = await version(questionId, body.versionId, session);
        await hooks.afterAuthorized?.({ session, operation: 'fork' });
        return insert(userId, v.content, session, v._id);
      });
    },
    async archive(userId, questionId, body, archived) {
      fields(body, ['revision']); revision(body);
      return transaction(client, async session => {
        const q = await access(userId, questionId, session, { owner: true });
        if (q.revision !== body.revision) throw conflict();
        await questions.updateOne({ _id: q._id }, { $set: { archived, updatedAt: now(), token: new ObjectId() }, $inc: { revision: 1 } }, { session });
        return { id: questionId, archived, revision: q.revision + 1 };
      });
    },
    async listShares(userId, questionId, query = {}) {
      await access(userId, questionId, undefined, { owner: true });
      const scope = `shares:${questionId}`;
      const { limit, after } = pageQuery(query, scope);
      const rows = await shares.find({ questionId: oid(questionId), ...afterId(after) }).sort({ _id: -1 }).limit(limit + 1).toArray();
      const items = [];
      for (const row of rows) {
        const user = await db.collection('users').findOne({ _id: row.userId }, { projection: { username: 1 } });
        items.push({ id: id(row._id), username: user?.username ?? null, createdAt: row.createdAt });
      }
      return paged(items, limit, scope);
    },
    async share(userId, questionId, body) {
      fields(body, ['revision', 'username']); revision(body);
      if (typeof body.username !== 'string') throw new AppError(400, 'INVALID_BODY', '请提供用户名');
      return transaction(client, async session => {
        const q = await access(userId, questionId, session, { owner: true, usable: true });
        if (q.revision !== body.revision) throw conflict();
        const user = await db.collection('users').findOne({ username: body.username }, { session, collation: { locale: 'simple' } });
        if (!user) throw missing();
        if (user._id.equals(q.ownerId)) throw new AppError(422, 'VALIDATION_FAILED', '无需共享给自己');
        await shares.updateOne({ questionId: q._id, userId: user._id }, { $setOnInsert: { _id: new ObjectId(), createdAt: now(), schemaVersion: 1 } }, { session, upsert: true });
        await questions.updateOne({ _id: q._id }, { $set: { token: new ObjectId(), updatedAt: now() }, $inc: { revision: 1 } }, { session });
        return { revision: q.revision + 1 };
      });
    },
    async revoke(userId, questionId, shareId, body) {
      fields(body, ['revision']); revision(body);
      return transaction(client, async session => {
        const q = await access(userId, questionId, session, { owner: true });
        if (q.revision !== body.revision) throw conflict();
        const result = await shares.deleteOne({ _id: oid(shareId), questionId: q._id }, { session });
        if (!result.deletedCount) throw missing();
        await questions.updateOne({ _id: q._id }, { $set: { token: new ObjectId(), updatedAt: now() }, $inc: { revision: 1 } }, { session });
        return { revision: q.revision + 1 };
      });
    },
    async usage(userId, questionId, query = {}) {
      const qid = id(oid(questionId));
      const filter = { ownerId: oid(userId), 'questions.reference.questionId': qid };
      if (!await db.collection('surveys').findOne(filter, { projection: { _id: 1 } })) await access(userId, questionId);
      const scope = `usage:${userId}:${qid}`;
      const { limit, after } = pageQuery(query, scope);
      const rows = await db.collection('surveys').find({ ...filter, ...afterId(after) }).sort({ _id: -1 }).limit(limit + 1).toArray();
      return paged(rows.map(s => ({ id: id(s._id), title: s.title, status: s.status, versions: s.questions.filter(q => q.reference?.questionId === qid).map(q => ({ questionId: q.id, versionId: q.reference.versionId })) })), limit, scope);
    },
    async materialize(userId, incoming, previous, session, force = false) {
      if (!Array.isArray(incoming)) throw new AppError(400, 'INVALID_BODY', 'questions 必须为数组');
      const seen = new Set();
      const output = [];
      for (const input of incoming) {
        fields(input, ['id', 'type', 'title', 'options', 'validation', 'required', 'rules', 'reference']);
        const old = previous.find(q => q.id === input.id);
        if (!input.reference) {
          if (old?.reference) throw new AppError(422, 'REFERENCE_REQUIRED', '已关联题目不能直接解除来源，请移除后另建题目');
          output.push(input); continue;
        }
        fields(input.reference, ['questionId', 'versionId']);
        const { questionId, versionId } = input.reference;
        oid(questionId); oid(versionId);
        if (seen.has(versionId)) throw new AppError(422, 'DUPLICATE_VERSION', '同一版本在问卷中只能使用一次');
        seen.add(versionId);
        let content;
        if (!force && old && isDeepStrictEqual(old.reference, input.reference)) content = questionContent(old);
        else {
          await hooks.beforeAuthorize?.({ session, operation: 'materialize' });
          await access(userId, questionId, session, { usable: true, touch: true });
          const v = await version(questionId, versionId, session);
          content = v.content;
          await hooks.afterAuthorized?.({ session, operation: 'materialize' });
        }
        for (const key of CONTENT_FIELDS) if (Object.hasOwn(input, key) && !isDeepStrictEqual(input[key], content[key])) throw new AppError(422, 'CONTENT_MISMATCH', '题目内容与所引用版本不一致', [{ field: `questions.${output.length}.${key}`, message: '请通过创建新版本修改内容' }]);
        output.push({ id: input.id, ...content, required: input.required ?? false, rules: input.rules ?? [], reference: { questionId, versionId } });
      }
      return output;
    },
  };
}
