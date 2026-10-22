import { validateAnswer } from './answers.js';
import { selectNextQuestion } from './rules.js';

/** Recompute the final path from fixed answers, independently of navigation history. */
export function resolveFinalPath(questions, answers, { rejectOutside = true } = {}) {
  const effectivePath = [];
  const normalizedAnswers = [];
  const fail = (code, questionId, message, errors) => ({
    valid: false,
    answers: normalizedAnswers,
    effectivePath,
    errors: errors ?? [{ questionId, field: `answers.${questionId}`, code, message }],
    code,
  });
  // Definitions are complete and validated by the caller. Each question is indexed once.
  const index = new Map(questions.map((question, position) => [question.id, {
    question, next: questions[position + 1]?.id ?? 'END',
  }]));
  if (!Array.isArray(answers)) return fail('ANSWER_INVALID', null, '答案必须为数组');
  const supplied = new Map();
  for (const entry of answers) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.questionId !== 'string') {
      return fail('ANSWER_INVALID', null, '答案条目必须包含题目ID');
    }
    const { questionId, value } = entry;
    if (!index.has(questionId)) return fail('ANSWER_INVALID', questionId, '题目不存在');
    if (supplied.has(questionId)) return fail('ANSWER_INVALID', questionId, '题目答案不能重复');
    // A known cached branch may contain an unfinished or invalid draft. Only
    // values actually visited below participate in answer validation.
    supplied.set(questionId, value);
  }

  const visited = new Set();
  let questionId = questions[0]?.id ?? 'END';
  while (questionId !== 'END') {
    if (visited.has(questionId)) return fail('PATH_NOT_COMPLETE', questionId, '当前最终答案未形成结束路径');
    visited.add(questionId);
    const { question, next } = index.get(questionId);
    effectivePath.push(questionId);
    const validated = validateAnswer(question, supplied.get(questionId));
    if (!validated.valid) return fail('ANSWER_INVALID', questionId, '', validated.errors);
    normalizedAnswers.push({ questionId, value: validated.value });
    questionId = selectNextQuestion(question, validated.value, next);
  }

  if (rejectOutside) {
    for (const suppliedId of supplied.keys()) {
      if (!visited.has(suppliedId)) return fail('ANSWER_OUTSIDE_PATH', suppliedId, '不能提交最终路径外的答案');
    }
  }
  return { valid: true, answers: normalizedAnswers, effectivePath, errors: [], code: null };
}
