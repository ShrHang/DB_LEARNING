import { ObjectId } from 'mongodb';
import { AppError } from '../errors.js';
import { createSurveyRepository } from '../repositories/surveys.js';
import { createSubmissionRepository } from '../repositories/submissions.js';
import { createSurveyGuardRepository } from '../repositories/survey-guards.js';
import { parseSubmissionRequest } from './submission-request.js';
import { assertOpen } from './fill-service.js';
import { resolveFinalPath } from '../shared/path.js';
import { validateAnswer } from '../shared/answers.js';

const temporary = () => new AppError(503, 'TEMPORARY_UNAVAILABLE', '提交结果待确认，请保留当前页面并重试确认');
const result = (document, replayed) => ({ submissionId: document._id.toHexString(), submittedAt: document.submittedAt.toISOString(), replayed });
function replay(document, requestHash) {
  if (!document) return null;
  if (document.requestHash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一提交标识已经用于不同内容');
  return result(document, true);
}
function assertDefinition(survey, request) {
  if (survey.definitionRevision !== request.definitionRevision) throw new AppError(409, 'DEFINITION_CHANGED', '题目已更新，请重新载入最新问卷后填写');
  const mode = survey.settings.anonymityMode;
  if ((mode === 'forced' && !request.anonymous) || (mode === 'forbidden' && request.anonymous)) throw new AppError(422, 'ANSWER_INVALID', '所选匿名方式不符合问卷要求', [{ field: 'anonymous', message: '请按问卷要求选择匿名方式' }]);
}

export function createSubmissionService({ db, client, clock, hooks = {} }) {
  const surveys = createSurveyRepository(db);
  const submissions = createSubmissionRepository(db);
  const guards = createSurveyGuardRepository(db);
  return { async submit(userId, slug, body) {
    const request = parseSubmissionRequest(body);
    if (request.expectedUserId !== userId) throw new AppError(409, 'ACCOUNT_CHANGED', '当前登录账号已变化，请在本页恢复原账号');
    const respondentId = new ObjectId(userId);
    let survey;
    try { survey = await surveys.findSlug(slug); } catch { throw temporary(); }
    if (!survey) throw new AppError(404, 'NOT_FOUND', '问卷不存在或已删除');
    const existing = () => submissions.findRequest(survey._id, respondentId, request.requestId);
    const replayExisting = document => {
      const previous = replay(document, request.requestHash);
      if (previous) {
        // Empty values share a hash, but an empty array for a number is still
        // an invalid type. Successful records freeze these question definitions.
        const questions = new Map(survey.questions.map(question => [question.id, question]));
        for (const entry of body.answers) {
          const question = questions.get(entry.questionId);
          if (!question) throw new AppError(422, 'ANSWER_INVALID', '题目不存在');
          const validated = validateAnswer(question, entry.value);
          if (!validated.valid) throw new AppError(422, 'ANSWER_INVALID', '答案不合法', validated.errors);
        }
      }
      return previous;
    };
    let saved;
    try {
      const previous = replayExisting(await existing());
      if (previous) return previous;
      assertOpen(survey, clock.now());
      assertDefinition(survey, request);
      // Preserve the raw values for type validation. Hash normalization alone
      // must not turn an empty array for a number/text question into a null.
      const path = resolveFinalPath(survey.questions, body.answers);
      if (!path.valid) throw new AppError(422, path.code || 'ANSWER_INVALID', '请检查最终答题路径和答案', path.errors);
      const submissionId = new ObjectId();
      const session = client.startSession();
      let attempt = 0;
      try {
        saved = await session.withTransaction(async () => {
          // This must remain the first database read in every transaction try.
          const current = await surveys.findId(survey._id, session);
          const acceptedAt = new Date(clock.now());
          assertOpen(current, acceptedAt.getTime());
          assertDefinition(current, request);
          const context = { survey: current, session, attempt: ++attempt };
          await hooks.afterAccepted?.(context);
          // Every new submission, including those after content freezing, must
          // conflict with deletion. Updating the survey itself here would also
          // conflict with close and break its established acceptance semantics.
          const guarded = await guards.touch(current._id, session);
          if (!guarded.matchedCount) throw temporary();
          await hooks.afterGuard?.(context);
          const previous = replayExisting(await submissions.findRequest(current._id, respondentId, request.requestId, session));
          if (previous) return previous;
          if (!current.contentLocked) {
            const locked = await surveys.freeze(current, acceptedAt, session);
            if (!locked.matchedCount) throw new AppError(409, 'DEFINITION_CHANGED', '题目已更新，请重新载入填写');
            await hooks.afterFreeze?.(context);
          }
          const document = {
            _id: submissionId, surveyId: current._id, definitionRevision: request.definitionRevision,
            respondentId, anonymous: request.anonymous, singleOnly: !current.settings.allowMultipleSubmissions,
            requestId: request.requestId, requestHash: request.requestHash,
            answers: path.answers, effectivePath: path.effectivePath, submittedAt: acceptedAt, schemaVersion: 1,
          };
          await hooks.beforeInsert?.(context);
          await submissions.insert(document, session);
          return result(document, false);
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 10000 });
      } finally { await session.endSession(); }
    } catch (error) {
      // A competing copy can have committed while this attempt was rejected.
      // Read outside the aborted snapshot before classifying any business error.
      let previous;
      try { previous = replayExisting(await existing()); }
      catch (lookupError) { if (lookupError instanceof AppError) throw lookupError; throw temporary(); }
      if (previous) return previous;
      if (error instanceof AppError) throw error;
      if (error.code === 11000 && (error.keyPattern?.requestId || error.keyPattern?.respondentId)) {
        if (!error.keyPattern.requestId) throw new AppError(409, 'ALREADY_SUBMITTED', '当前账号已提交过本问卷');
      }
      throw temporary();
    }
    // A test can drop a response only after the real commit, without changing
    // the persisted outcome or replacing the transaction with a fake.
    try { await hooks.afterCommit?.({ result: saved }); } catch { throw temporary(); }
    return saved;
  } };
}
