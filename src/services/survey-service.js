import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../errors.js';
import { createSurveyRepository } from '../repositories/surveys.js';
import { validateDefinition } from '../shared/definition.js';

const missing = () => new AppError(404, 'NOT_FOUND', '问卷不存在或无权访问');
const conflict = () => new AppError(409, 'REVISION_CONFLICT', '问卷已更新，请保留当前输入并重新载入最新版本');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function bodyFields(body, allowed) {
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new AppError(400, 'INVALID_BODY', '请求包含未知字段或正文格式错误');
}
function revisionOf(body) {
  if (!Number.isSafeInteger(body.revision) || body.revision < 1) throw new AppError(400, 'INVALID_REVISION', 'revision 必须是正整数');
  return body.revision;
}
function settingsOf(value, previous) {
  bodyFields(value, ['anonymityMode', 'allowMultipleSubmissions']);
  const settings = { ...previous, ...value };
  if (typeof settings.anonymityMode !== 'string' || typeof settings.allowMultipleSubmissions !== 'boolean') throw new AppError(400, 'INVALID_BODY', '填写策略字段类型错误');
  if (!['forced', 'optional', 'forbidden'].includes(settings.anonymityMode)) throw new AppError(422, 'VALIDATION_FAILED', '请选择合法的匿名模式', [{ field: 'settings.anonymityMode', message: '请选择强制匿名、允许匿名或禁止匿名' }]);
  return settings;
}
function deadlineOf(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new AppError(400, 'INVALID_BODY', '截止时间须为带时区的 ISO 字符串或 null');
  const date = new Date(value);
  const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!shape.test(value) || !Number.isFinite(date.getTime()) || month < 1 || month > 12 || day < 1 || day > days) throw new AppError(422, 'VALIDATION_FAILED', '截止时间不合法', [{ field: 'deadlineAt', message: '请提供有效且带时区的日期时间' }]);
  return date;
}
function validate(document, complete) {
  const result = validateDefinition(document, { complete });
  if (result.valid) return;
  const malformed = result.errors.some(error => ['INVALID_TYPE', 'UNKNOWN_FIELD'].includes(error.code));
  throw new AppError(malformed ? 400 : 422, 'VALIDATION_FAILED', complete ? '问卷未通过完整校验' : '草稿结构不合法', result.errors);
}
function normalizeQuestions(questions) {
  return questions.map(question => ({
    ...question, title: question.title ?? '', required: question.required ?? false,
    ...(['single_choice', 'multiple_choice'].includes(question.type) ? { options: (question.options ?? []).map(option => ({ ...option, label: option.label ?? '' })) } : {}),
    validation: question.validation ?? {},
    rules: (question.rules ?? []).map(rule => {
      const condition = { ...(rule.condition ?? {}) };
      if (condition.operator === '') delete condition.operator;
      return { ...rule, condition, target: rule.target ?? null };
    })
  }));
}
export function serializeSurvey(document) {
  return {
    id: document._id.toHexString(), slug: document.slug,
    title: document.title, description: document.description, status: document.status,
    settings: document.settings, deadlineAt: document.deadlineAt?.toISOString() ?? null,
    questions: document.questions, revision: document.revision, definitionRevision: document.definitionRevision,
    contentLocked: document.contentLocked, firstSubmittedAt: document.firstSubmittedAt?.toISOString() ?? null,
    firstPublishedAt: document.firstPublishedAt?.toISOString() ?? null,
    createdAt: document.createdAt.toISOString(), updatedAt: document.updatedAt.toISOString(),
    schemaVersion: document.schemaVersion, shareUrl: `/survey/${document.slug}`
  };
}

export function createSurveyService({ db, clock }) {
  const repository = createSurveyRepository(db);
  async function own(id, ownerId) {
    if (typeof id !== 'string' || !/^[a-fA-F0-9]{24}$/.test(id)) throw missing();
    const document = await repository.findOwn(new ObjectId(id), new ObjectId(ownerId));
    if (!document) throw missing();
    return document;
  }
  async function update(document, revision, changes, conditions = {}) {
    const result = await repository.updateOwn({ _id: document._id, ownerId: document.ownerId, revision, ...conditions }, { ...changes, updatedAt: new Date(clock.now()) });
    if (!result) throw conflict();
    return serializeSurvey(result);
  }
  return {
    async create(ownerId, body) {
      bodyFields(body, ['title', 'description', 'settings', 'deadlineAt', 'questions']);
      if (!Object.hasOwn(body, 'settings') || !Object.hasOwn(body.settings ?? {}, 'anonymityMode')) throw new AppError(400, 'INVALID_BODY', '创建时必须显式选择匿名模式');
      const now = new Date(clock.now());
      const document = {
        _id: new ObjectId(), ownerId: new ObjectId(ownerId), slug: randomUUID(),
        title: body.title ?? '', description: body.description ?? '',
        settings: settingsOf(body.settings, { allowMultipleSubmissions: false }),
        deadlineAt: Object.hasOwn(body, 'deadlineAt') ? deadlineOf(body.deadlineAt) : null,
        questions: Object.hasOwn(body, 'questions') ? body.questions : [],
        status: 'draft', revision: 1, definitionRevision: 1, contentLocked: false,
        firstSubmittedAt: null, firstPublishedAt: null, createdAt: now, updatedAt: now, schemaVersion: 1
      };
      // Do not coerce malformed supplied values into legitimate empty fields.
      if (Object.hasOwn(body, 'title')) document.title = body.title;
      if (Object.hasOwn(body, 'description')) document.description = body.description;
      validate(document, false);
      document.questions = normalizeQuestions(document.questions);
      await repository.insert(document);
      return serializeSurvey(document);
    },
    async get(ownerId, id) { return serializeSurvey(await own(id, ownerId)); },
    async patch(ownerId, id, body) {
      const document = await own(id, ownerId);
      bodyFields(body, ['revision', 'title', 'description', 'settings', 'deadlineAt', 'questions']);
      const revision = revisionOf(body);
      if (revision !== document.revision) throw conflict();
      const changes = {};
      for (const key of ['title', 'description', 'questions']) if (Object.hasOwn(body, key)) changes[key] = body[key];
      if (Object.hasOwn(body, 'settings')) changes.settings = settingsOf(body.settings, document.settings);
      if (Object.hasOwn(body, 'deadlineAt')) changes.deadlineAt = deadlineOf(body.deadlineAt);
      const candidate = { ...document, ...changes };
      validate(candidate, document.firstPublishedAt !== null);
      if (Object.hasOwn(changes, 'questions')) changes.questions = normalizeQuestions(changes.questions);
      const questionsChanged = Object.hasOwn(changes, 'questions') && !isDeepStrictEqual(changes.questions, document.questions);
      const policyChanged = changes.settings && !isDeepStrictEqual(changes.settings, document.settings);
      if (policyChanged && document.firstPublishedAt !== null) throw new AppError(409, 'SETTINGS_LOCKED', '首次发布后匿名模式和重复填写策略不可修改');
      if (questionsChanged && document.contentLocked) throw new AppError(409, 'CONTENT_LOCKED', '已有成功答卷，题目、校验与跳转不可修改');
      if (questionsChanged) changes.definitionRevision = document.definitionRevision + 1;
      return update(document, revision, changes, { ...(questionsChanged ? { contentLocked: false } : {}), ...(policyChanged ? { firstPublishedAt: null } : {}) });
    },
    async transition(ownerId, id, action, body) {
      const document = await own(id, ownerId);
      bodyFields(body, ['revision']);
      const revision = revisionOf(body);
      if (revision !== document.revision) throw conflict();
      const expected = { publish: 'draft', close: 'published', reopen: 'closed' }[action];
      if (!expected || document.status !== expected) throw new AppError(409, 'INVALID_STATUS', '当前问卷状态不允许执行此操作');
      const changes = { status: action === 'close' ? 'closed' : 'published' };
      if (action !== 'close') validate(document, true);
      if (action === 'publish') changes.firstPublishedAt = new Date(clock.now());
      if (action === 'reopen' && document.deadlineAt && document.deadlineAt.getTime() <= clock.now()) throw new AppError(409, 'DEADLINE_PASSED', '截止时间已到，请先延长期限或取消截止时间再重开');
      return update(document, revision, changes, { status: expected });
    }
  };
}
