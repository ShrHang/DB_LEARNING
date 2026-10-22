import { ObjectId } from 'mongodb';
import { AppError } from '../errors.js';
import { createSurveyRepository } from '../repositories/surveys.js';
import { createSubmissionRepository } from '../repositories/submissions.js';
import { createSurveyGuardRepository } from '../repositories/survey-guards.js';

const missing = () => new AppError(404, 'NOT_FOUND', '问卷不存在或无权访问');
const temporary = () => new AppError(503, 'TEMPORARY_UNAVAILABLE', '删除结果待确认，请重试确认');
const canDelete = (survey, now) => survey.status === 'draft' || survey.status === 'closed'
  || (survey.status === 'published' && survey.deadlineAt !== null && survey.deadlineAt.getTime() <= now);

function noQuery(query) {
  if (Object.keys(query).length) throw new AppError(400, 'INVALID_QUERY', '不支持查询参数');
}
function idOf(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value)) throw missing();
  return new ObjectId(value);
}
function requestOf(body, userId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['revision', 'expectedUserId', 'confirmation'].includes(key))) {
    throw new AppError(400, 'INVALID_BODY', '请求包含未知字段或正文格式错误');
  }
  if (!Number.isSafeInteger(body.revision) || body.revision < 1) throw new AppError(400, 'INVALID_REVISION', 'revision 必须是正整数');
  if (typeof body.expectedUserId !== 'string' || !/^[a-fA-F0-9]{24}$/.test(body.expectedUserId)) throw new AppError(400, 'INVALID_BODY', '原账号标识格式错误');
  if (body.expectedUserId.toLowerCase() !== userId) throw new AppError(409, 'ACCOUNT_CHANGED', '当前登录账号已变化，请恢复原账号后确认');
  if (Object.hasOwn(body, 'confirmation') && typeof body.confirmation !== 'string') throw new AppError(400, 'INVALID_BODY', '确认文字格式错误');
  if (body.confirmation !== '删除') throw new AppError(422, 'CONFIRMATION_REQUIRED', '请输入“删除”二字以确认永久删除');
  return body;
}

export function createDeletionService({ db, client, clock, hooks = {} }) {
  const surveys = createSurveyRepository(db);
  const submissions = createSubmissionRepository(db);
  const guards = createSurveyGuardRepository(db);
  return {
    async preview(userId, id, query = {}) {
      const survey = await surveys.findOwn(idOf(id), new ObjectId(userId));
      if (!survey) throw missing();
      noQuery(query);
      return { id: survey._id.toHexString(), title: survey.title, revision: survey.revision,
        totalSubmissions: await submissions.count(survey._id), canDelete: canDelete(survey, clock.now()) };
    },
    async remove(userId, id, body, query = {}) {
      const surveyId = idOf(id);
      const ownerId = new ObjectId(userId);
      noQuery(query);
      const request = requestOf(body, userId);
      let attempt = 0;
      const session = client.startSession();
      try {
        try {
          await session.withTransaction(async () => {
            const survey = await surveys.findOwn(surveyId, ownerId, session);
            if (!survey) throw missing();
            if (survey.revision !== request.revision) throw new AppError(409, 'REVISION_CONFLICT', '问卷已更新，请重新预览并确认删除');
            if (!canDelete(survey, clock.now())) throw new AppError(409, 'SURVEY_STILL_OPEN', '问卷仍在接收提交，请先关闭后再删除');
            const context = { survey, session, attempt: ++attempt };
            await hooks.afterRead?.(context);
            const removed = await guards.remove(surveyId, session);
            if (removed.deletedCount !== 1) throw temporary();
            await hooks.afterGuard?.(context);
            await submissions.removeSurvey(surveyId, session);
            await hooks.afterDeleteAnswers?.(context);
            const result = await surveys.removeOwn(survey, session);
            if (result.deletedCount !== 1) throw new AppError(409, 'REVISION_CONFLICT', '问卷已更新，请重新预览并确认删除');
            await hooks.beforeCommit?.(context);
          }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 10000 });
        } finally { await session.endSession(); }
        await hooks.afterCommit?.({ surveyId: surveyId.toHexString() });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw temporary();
      }
    },
  };
}
