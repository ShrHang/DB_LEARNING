import { validateDefinition } from './definition.js';

export const CONTENT_FIELDS = ['type', 'title', 'options', 'validation'];
export function questionContent(question) {
  return {
    type: question.type, title: question.title ?? '',
    ...(['single_choice', 'multiple_choice'].includes(question.type) ? { options: (question.options ?? []).map(o => ({ id: o.id, label: o.label ?? '' })) } : {}),
    validation: question.validation ?? {},
  };
}
export function validateQuestionContent(content) {
  const fields = content && typeof content === 'object' && !Array.isArray(content);
  if (!fields || Object.keys(content).some(k => !CONTENT_FIELDS.includes(k))) return { valid: false, errors: [{ field: 'content', message: '题目内容包含未知字段或类型错误', code: 'UNKNOWN_FIELD' }] };
  return validateDefinition({ title: '题目', questions: [{ ...content, id: 'question', required: false, rules: [] }] }, { complete: true });
}
// Reference metadata belongs to author management, never to the filling protocol.
export function fillingQuestion(question) {
  const { reference, ...definition } = question;
  return definition;
}
