import { ObjectId } from 'mongodb';
import { AppError } from '../errors.js';
import { createSurveyRepository } from '../repositories/surveys.js';
import { createStatisticsRepository } from '../repositories/statistics.js';
import { serializeStatisticsSurvey, serializeSubmissionSummary, serializeQuestionAnswer, serializeSubmission } from '../serializers/submissions.js';

const missing = () => new AppError(404, 'NOT_FOUND', '资源不存在或无权访问');
const isId = value => typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
function queryFields(query, allowed) {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !allowed.includes(key))) {
    throw new AppError(400, 'INVALID_QUERY', '不支持的查询参数');
  }
}

function pagination(query, surveyId, questionId) {
  queryFields(query, ['cursor', 'limit']);
  const rawLimit = query.limit ?? '20';
  if (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 100) {
    throw new AppError(400, 'INVALID_QUERY', 'limit 必须是 1—100 的整数');
  }
  let before = null;
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      const bytes = Buffer.from(query.cursor, 'base64url');
      if (bytes.toString('base64url') !== query.cursor) throw new Error();
      const value = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'id,questionId,submittedAt,surveyId') throw new Error();
      if (value.surveyId !== surveyId || value.questionId !== questionId || typeof value.id !== 'string' || !/^[a-f0-9]{24}$/.test(value.id) || typeof value.submittedAt !== 'string') throw new Error();
      const submittedAt = new Date(value.submittedAt);
      if (!Number.isFinite(submittedAt.getTime()) || submittedAt.toISOString() !== value.submittedAt) throw new Error();
      before = { submittedAt, id: new ObjectId(value.id) };
    } catch {
      throw new AppError(400, 'INVALID_CURSOR', '分页游标不合法或与当前资源不匹配');
    }
  }
  return { before, limit: Number(rawLimit) };
}

function questionStatistics(questions, result) {
  const counts = new Map(result.questions.map(row => [row._id, row]));
  const optionCounts = new Map();
  for (const row of result.options) {
    if (!optionCounts.has(row._id.questionId)) optionCounts.set(row._id.questionId, new Map());
    optionCounts.get(row._id.questionId).set(row._id.optionId, row.count);
  }
  return questions.map(question => {
    const metric = counts.get(question.id);
    const answeredCount = metric?.answeredCount ?? 0;
    const data = { questionId: question.id, type: question.type, title: question.title, answeredCount };
    if (['single_choice', 'multiple_choice'].includes(question.type)) data.options = (question.options ?? []).map(option => {
      const count = optionCounts.get(question.id)?.get(option.id) ?? 0;
      return { id: option.id, label: option.label, count, percentage: answeredCount ? count / answeredCount * 100 : null };
    });
    if (question.type === 'number') data.average = metric?.average ?? null;
    return data;
  });
}

export function createStatisticsService({ db }) {
  const surveys = createSurveyRepository(db);
  const repository = createStatisticsRepository(db);
  async function own(userId, id) {
    if (!isId(id) || !isId(userId)) throw missing();
    const survey = await surveys.findOwn(new ObjectId(id), new ObjectId(userId));
    if (!survey) throw missing();
    return survey;
  }
  function findQuestion(survey, questionId) {
    const question = survey.questions.find(item => item.id === questionId);
    if (!question) throw missing();
    return question;
  }
  async function page(survey, questionId, query) {
    const surveyId = survey._id.toHexString();
    const { rows, hasMore } = await repository.page({ surveyId: survey._id, questionId, ...pagination(query, surveyId, questionId) });
    const items = rows.map(questionId === null ? serializeSubmissionSummary : serializeQuestionAnswer);
    const last = items.at(-1);
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ surveyId, questionId, submittedAt: last.submittedAt, id: last.submissionId })).toString('base64url') : null;
    return { items, nextCursor };
  }
  return {
    async get(userId, id, query = {}) {
      const survey = await own(userId, id);
      queryFields(query, []);
      const result = await repository.aggregate(survey._id, survey.questions);
      return { survey: serializeStatisticsSurvey(survey), totalSubmissions: result.totalSubmissions, questions: questionStatistics(survey.questions, result) };
    },
    async question(userId, id, questionId, query = {}) {
      const survey = await own(userId, id);
      const question = findQuestion(survey, questionId);
      queryFields(query, []);
      const result = await repository.aggregate(survey._id, [question]);
      return { survey: serializeStatisticsSurvey(survey), question: questionStatistics([question], result)[0] };
    },
    async answers(userId, id, questionId, query = {}) {
      const survey = await own(userId, id);
      findQuestion(survey, questionId);
      return page(survey, questionId, query);
    },
    async submissions(userId, id, query = {}) {
      return page(await own(userId, id), null, query);
    },
    async submission(userId, id, submissionId, query = {}) {
      const survey = await own(userId, id);
      if (!isId(submissionId)) throw missing();
      const row = await repository.find(survey._id, new ObjectId(submissionId));
      if (!row) throw missing();
      queryFields(query, []);
      return serializeSubmission(row, survey);
    },
  };
}
