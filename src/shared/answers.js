const TYPES = new Set(['single_choice', 'multiple_choice', 'text', 'number']);

function failure(question, value, code, message) {
  const questionId = question?.id ?? null;
  return {
    valid: false,
    value,
    errors: [{ questionId, field: `answers.${questionId}`, code, message }],
  };
}

/** Normalize typed empty answers; never coerce strings, deduplicate, or trim content. */
export function normalizeAnswer(question, value) {
  if (!TYPES.has(question?.type)) {
    return failure(question, value, 'INVALID_TYPE', '不支持的题型');
  }
  if (value === undefined || value === null) return { valid: true, value: null, errors: [] };

  switch (question.type) {
    case 'single_choice':
    case 'text':
      if (typeof value !== 'string') return failure(question, value, 'INVALID_TYPE', '答案必须为字符串');
      if (!value.isWellFormed()) return failure(question, value, 'INVALID_VALUE', '文本包含无效的Unicode字符');
      if (question.type === 'text' && value.trim().length === 0) value = null;
      break;
    case 'multiple_choice':
      if (!Array.isArray(value)) return failure(question, value, 'INVALID_TYPE', '答案必须为选项ID数组');
      for (const optionId of value) {
        if (typeof optionId !== 'string') return failure(question, value, 'INVALID_TYPE', '选项ID必须为字符串');
        if (!optionId.isWellFormed()) return failure(question, value, 'INVALID_VALUE', '选项ID包含无效的Unicode字符');
      }
      value = value.length === 0 ? null : [...value];
      break;
    case 'number':
      if (typeof value !== 'number') return failure(question, value, 'INVALID_TYPE', '答案必须为数值');
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        return failure(question, value, 'INVALID_VALUE', '必须为有限数值，整数必须是安全整数');
      }
      if (Object.is(value, -0)) value = 0;
      break;
  }
  return { valid: true, value, errors: [] };
}

/** Validate the current answer against a complete question definition. */
export function validateAnswer(question, value) {
  const normalized = normalizeAnswer(question, value);
  if (!normalized.valid) return normalized;
  value = normalized.value;
  const invalid = (message) => failure(question, value, 'INVALID_VALUE', message);
  if (value === null) {
    return question.required ? failure(question, value, 'REQUIRED', '此题为必答题') : normalized;
  }

  const validation = question.validation ?? {};
  if (question.type === 'single_choice' || question.type === 'multiple_choice') {
    const options = new Set(question.options.map((option) => option.id));
    if (question.type === 'single_choice') {
      if (!options.has(value)) return invalid('选项不存在');
    } else {
      const seen = new Set();
      for (const optionId of value) {
        if (seen.has(optionId)) return invalid('选项不能重复');
        if (!options.has(optionId)) return invalid('选项不存在');
        seen.add(optionId);
      }
      if (validation.minSelections !== undefined && value.length < validation.minSelections) {
        return invalid('选择数量少于下限');
      }
      if (validation.maxSelections !== undefined && value.length > validation.maxSelections) {
        return invalid('选择数量超过上限');
      }
    }
  } else if (question.type === 'text') {
    const length = Array.from(value).length;
    if (validation.minLength !== undefined && length < validation.minLength) return invalid('文本长度少于下限');
    if (validation.maxLength !== undefined && length > validation.maxLength) return invalid('文本长度超过上限');
  } else if (question.type === 'number') {
    if (validation.integer && !Number.isSafeInteger(value)) return invalid('答案必须为安全整数');
    if (validation.min !== undefined && value < validation.min) return invalid('数值小于下限');
    if (validation.max !== undefined && value > validation.max) return invalid('数值超过上限');
  }
  return normalized;
}
