import { fillingQuestion } from '../shared/question-content.js';
import { AppError } from '../errors.js';
import { createSurveyRepository } from '../repositories/surveys.js';

export function assertOpen(survey, now) {
  if (!survey || survey.status === 'draft') throw new AppError(404, 'NOT_FOUND', '问卷不存在或已删除');
  if (survey.status !== 'published' || (survey.deadlineAt && now >= survey.deadlineAt.getTime())) {
    throw new AppError(409, 'SURVEY_NOT_OPEN', '问卷已关闭或已到截止时间');
  }
}

export function createFillService({ db, clock }) {
  const surveys = createSurveyRepository(db);
  return { async get(slug) {
    const survey = await surveys.findSlug(slug);
    assertOpen(survey, clock.now());
    return {
      id: survey._id.toHexString(), slug: survey.slug, title: survey.title, description: survey.description,
      settings: survey.settings, questions: survey.questions.map(fillingQuestion), deadlineAt: survey.deadlineAt,
      definitionRevision: survey.definitionRevision,
    };
  } };
}
