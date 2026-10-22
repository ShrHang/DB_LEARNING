import { validateAnswer } from './answers.js';

const safeNumber = (value) => typeof value === 'number' && Number.isFinite(value)
  && (!Number.isInteger(value) || Number.isSafeInteger(value));

/** Only the documented operators can match; empty or invalid answers never match. */
export function evaluateCondition(question, value, condition) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return false;
  const normalized = validateAnswer(question, value);
  if (!normalized.valid || normalized.value === null) return false;
  value = normalized.value;
  const { operator, value: expected } = condition;

  if (question.type === 'single_choice') {
    if (typeof expected !== 'string' || !question.options.some((option) => option.id === expected)) return false;
    if (operator === 'eq') return value === expected;
    if (operator === 'ne') return value !== expected;
  } else if (question.type === 'multiple_choice') {
    if (!Array.isArray(expected) || expected.length === 0) return false;
    const options = new Set(question.options.map((option) => option.id));
    const targets = new Set();
    for (const optionId of expected) {
      if (typeof optionId !== 'string' || !options.has(optionId) || targets.has(optionId)) return false;
      targets.add(optionId);
    }
    const selected = new Set(value);
    if (operator === 'contains_any') return expected.some((optionId) => selected.has(optionId));
    if (operator === 'contains_all') return expected.every((optionId) => selected.has(optionId));
    if (operator === 'equals_set') return selected.size === targets.size
      && expected.every((optionId) => selected.has(optionId));
  } else if (question.type === 'number') {
    if (operator === 'between') {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const [min, max] = expected;
      return safeNumber(min) && safeNumber(max) && min <= max && value >= min && value <= max;
    }
    if (!safeNumber(expected)) return false;
    switch (operator) {
      case 'eq': return value === expected;
      case 'ne': return value !== expected;
      case 'gt': return value > expected;
      case 'gte': return value >= expected;
      case 'lt': return value < expected;
      case 'lte': return value <= expected;
    }
  }
  return false;
}

/** Shared step selection; the caller supplies its already indexed sequential successor. */
export function selectNextQuestion(question, value, sequentialTarget) {
  for (const rule of question.rules ?? []) {
    if (evaluateCondition(question, value, rule.condition)) return rule.target;
  }
  return sequentialTarget;
}

/** Compute exactly one transition, including backwards and self transitions. */
export function getNextQuestion(questions, questionId, value) {
  const index = questions.findIndex((question) => question.id === questionId);
  if (index === -1) throw new RangeError('题目不存在');
  return selectNextQuestion(questions[index], value, questions[index + 1]?.id ?? 'END');
}
