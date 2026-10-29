const QUESTION_FIELDS = ['id', 'type', 'title', 'required', 'options', 'validation', 'rules', 'reference'];
const TYPES = ['single_choice', 'multiple_choice', 'text', 'number'];
const OPERATORS = {
  single_choice: ['eq', 'ne'],
  multiple_choice: ['contains_any', 'contains_all', 'equals_set'],
  text: [],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'],
};
const ALL_OPERATORS = new Set(Object.values(OPERATORS).flat());
const VALIDATION_FIELDS = {
  single_choice: [],
  multiple_choice: ['minSelections', 'maxSelections'],
  text: ['minLength', 'maxLength'],
  number: ['min', 'max', 'integer'],
};
const COUNT_FIELDS = new Set(['minSelections', 'maxSelections', 'minLength', 'maxLength']);
const has = (object, key) => Object.hasOwn(object, key);
const isObject = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const isChoice = (type) => type === 'single_choice' || type === 'multiple_choice';
const isFiniteSafeNumber = (value) => Number.isFinite(value)
  && (!Number.isInteger(value) || Number.isSafeInteger(value));

/** Validate author input without filling defaults or changing the definition. */
export function validateDefinition(definition, { complete = false } = {}) {
  const errors = [];
  const add = (field, message, code = 'INVALID_VALUE') => errors.push({ field, message, code });
  const result = () => ({ valid: errors.length === 0, errors });
  const object = (value, field, fields) => {
    if (!isObject(value)) {
      add(field, '必须为对象', 'INVALID_TYPE');
      return false;
    }
    if (fields) {
      for (const key of Object.keys(value)) {
        if (!fields.includes(key)) add(`${field}.${key}`, '不支持的字段', 'UNKNOWN_FIELD');
      }
    }
    return true;
  };
  const string = (value, field, nonempty = false) => {
    if (typeof value !== 'string') {
      add(field, '必须为字符串', 'INVALID_TYPE');
      return false;
    }
    if (nonempty && value.trim().length === 0) {
      add(field, '不能为空');
      return false;
    }
    return true;
  };
  const id = (value, field, ids, reserved = true) => {
    if (!string(value, field, true)) return;
    if (reserved && value === 'END') add(field, 'END 是保留标识');
    if (ids.has(value)) add(field, '标识不能重复');
    ids.add(value);
  };
  const number = (value, field) => {
    if (typeof value !== 'number') add(field, '必须为数值', 'INVALID_TYPE');
    else if (!isFiniteSafeNumber(value)) add(field, '必须为有限数值，整数必须是安全整数');
  };
  const array = (value, field) => {
    if (Array.isArray(value)) return true;
    add(field, '必须为数组', 'INVALID_TYPE');
    return false;
  };

  if (!object(definition, 'definition')) return result();
  if (has(definition, 'title') || complete) string(definition.title, 'title', complete);
  if (has(definition, 'description')) string(definition.description, 'description');
  if (!has(definition, 'questions')) {
    if (complete) add('questions', '至少需要一道题目');
    return result();
  }
  if (!array(definition.questions, 'questions')) return result();
  const questions = definition.questions;
  if (complete && questions.length === 0) add('questions', '至少需要一道题目');
  const questionIds = new Set();
  // Collect before checking targets, so forward references are valid.
  questions.forEach((question, index) => {
    if (isObject(question)) id(question.id, `questions.${index}.id`, questionIds);
  });

  questions.forEach((question, index) => {
    const field = `questions.${index}`;
    if (!object(question, field, QUESTION_FIELDS)) return;
    if (has(question, 'reference')) {
      if (object(question.reference, `${field}.reference`, ['questionId', 'versionId'])) {
        for (const key of ['questionId', 'versionId']) {
          if (typeof question.reference[key] !== 'string' || !/^[a-f0-9]{24}$/.test(question.reference[key])) add(`${field}.reference.${key}`, '版本引用不合法');
        }
      }
    }
    const type = question.type;
    const knownType = TYPES.includes(type);
    if (typeof type !== 'string') add(`${field}.type`, '题型必须为字符串', 'INVALID_TYPE');
    else if (!knownType) add(`${field}.type`, '不支持的题型');
    if (has(question, 'title') || complete) string(question.title, `${field}.title`, complete);
    if (has(question, 'required') && typeof question.required !== 'boolean') {
      add(`${field}.required`, '必须为布尔值', 'INVALID_TYPE');
    }

    const optionIds = new Set();
    const options = has(question, 'options') ? question.options : [];
    if (array(options, `${field}.options`)) {
      if (complete && isChoice(type) && options.length === 0) add(`${field}.options`, '选择题至少需要一个选项');
      if (knownType && !isChoice(type) && options.length > 0) add(`${field}.options`, '此题型不支持选项');
      options.forEach((option, optionIndex) => {
        const optionField = `${field}.options.${optionIndex}`;
        if (!object(option, optionField, ['id', 'label'])) return;
        id(option.id, `${optionField}.id`, optionIds);
        if (has(option, 'label') || complete) string(option.label, `${optionField}.label`, complete);
      });
    }

    if (has(question, 'validation') && object(question.validation, `${field}.validation`,
      knownType ? VALIDATION_FIELDS[type] : Object.values(VALIDATION_FIELDS).flat())) {
      const validation = question.validation;
      for (const key of Object.keys(validation)) {
        const value = validation[key];
        const keyField = `${field}.validation.${key}`;
        if (COUNT_FIELDS.has(key)) {
          if (typeof value !== 'number') add(keyField, '必须为数值', 'INVALID_TYPE');
          else if (!Number.isSafeInteger(value) || value < 0) add(keyField, '必须为非负安全整数');
        } else if (key === 'integer') {
          if (typeof value !== 'boolean') add(keyField, '必须为布尔值', 'INVALID_TYPE');
        } else if (key === 'min' || key === 'max') number(value, keyField);
      }
      if (complete) {
        for (const [min, max] of [['min', 'max'], ['minLength', 'maxLength'], ['minSelections', 'maxSelections']]) {
          if (typeof validation[min] === 'number' && typeof validation[max] === 'number'
            && validation[min] > validation[max]) add(`${field}.validation.${max}`, '上限不能小于下限');
        }
        if (type === 'multiple_choice' && Array.isArray(options)) {
          for (const key of ['minSelections', 'maxSelections']) {
            if (validation[key] > options.length) add(`${field}.validation.${key}`, '选择数量不能超过选项总数');
          }
        }
      }
    }

    const rules = has(question, 'rules') ? question.rules : [];
    if (!array(rules, `${field}.rules`)) return;
    if (complete && type === 'text' && rules.length > 0) add(`${field}.rules`, '文本题不支持跳转规则');
    const ruleIds = new Set();
    rules.forEach((rule, ruleIndex) => {
      const ruleField = `${field}.rules.${ruleIndex}`;
      if (!object(rule, ruleField, ['id', 'condition', 'target'])) return;
      if (has(rule, 'id')) id(rule.id, `${ruleField}.id`, ruleIds, false);
      if (!has(rule, 'target') || rule.target === null) {
        if (complete) add(`${ruleField}.target`, '请选择跳转目标');
      } else if (string(rule.target, `${ruleField}.target`, true) && complete
        && rule.target !== 'END' && !questionIds.has(rule.target)) {
        add(`${ruleField}.target`, '跳转目标不存在');
      }
      if (!has(rule, 'condition')) {
        if (complete) add(`${ruleField}.condition`, '请补全跳转条件');
        return;
      }
      const conditionField = `${ruleField}.condition`;
      if (!object(rule.condition, conditionField, ['operator', 'value'])) return;
      const { condition } = rule;
      const operator = condition.operator;
      if (has(condition, 'operator')) {
        if (typeof operator !== 'string') add(`${conditionField}.operator`, '操作符必须为字符串', 'INVALID_TYPE');
        else if (operator === '') {
          if (complete) add(`${conditionField}.operator`, '请选择操作符');
        }
        else if (!ALL_OPERATORS.has(operator)) add(`${conditionField}.operator`, '不支持的操作符');
        else if (complete && knownType && !OPERATORS[type].includes(operator)) {
          add(`${conditionField}.operator`, '操作符与题型不兼容');
        }
      } else if (complete) add(`${conditionField}.operator`, '请选择操作符');
      if (!has(condition, 'value') || condition.value === null) {
        if (complete) add(`${conditionField}.value`, '请补全条件值');
        return;
      }

      const { value } = condition;
      // A version switch may leave a formerly valid condition incompatible with
      // the new type. Retain its scalar/array shape in drafts; publishing is strict.
      if (!complete && question.reference && operator && (!OPERATORS[type]?.includes(operator) || (['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(operator) && type === 'number' && typeof value !== 'number') || (['eq', 'ne'].includes(operator) && type === 'single_choice' && typeof value !== 'string'))) {
        if (!['string', 'number'].includes(typeof value) && !Array.isArray(value)) add(`${conditionField}.value`, '条件值类型不合法', 'INVALID_TYPE');
        else if (typeof value === 'number') number(value, `${conditionField}.value`);
        else if (Array.isArray(value)) value.forEach((v, i) => { if (!['string', 'number'].includes(typeof v) && v !== null) add(`${conditionField}.value.${i}`, '条件值类型不合法', 'INVALID_TYPE'); });
        return;
      }
      const valueField = `${conditionField}.value`;
      const option = (value, valueField) => {
        if (string(value, valueField, true) && complete && !optionIds.has(value)) {
          add(valueField, '条件引用的选项不存在');
        }
      };
      if (['contains_any', 'contains_all', 'equals_set'].includes(operator)) {
        if (!array(value, valueField)) return;
        if (complete && value.length === 0) add(valueField, '条件选项数组不能为空');
        const seen = new Set();
        value.forEach((entry, entryIndex) => {
          const entryField = `${valueField}.${entryIndex}`;
          option(entry, entryField);
          if (typeof entry === 'string' && seen.has(entry)) add(entryField, '条件选项不能重复');
          seen.add(entry);
        });
      } else if (operator === 'between') {
        if (!array(value, valueField)) return;
        if (value.length !== 2) add(valueField, '区间条件必须包含两个数值');
        value.forEach((entry, entryIndex) => {
          if (entry === null) {
            if (complete) add(`${valueField}.${entryIndex}`, '请补全区间界限');
          } else number(entry, `${valueField}.${entryIndex}`);
        });
        if (complete && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number'
          && value[0] > value[1]) add(valueField, '区间上限不能小于下限');
      } else if (['gt', 'gte', 'lt', 'lte'].includes(operator)
        || (['eq', 'ne'].includes(operator) && type === 'number')) {
        number(value, valueField);
      } else if (['eq', 'ne'].includes(operator) && type === 'single_choice') {
        option(value, valueField);
      } else {
        // A draft may have a value before an operator, but never arbitrary objects.
        if (typeof value === 'number') number(value, valueField);
        else if (typeof value === 'string') string(value, valueField, true);
        else if (Array.isArray(value)) {
          value.forEach((entry, entryIndex) => {
            if (typeof entry === 'number') number(entry, `${valueField}.${entryIndex}`);
            else string(entry, `${valueField}.${entryIndex}`, true);
          });
        } else add(valueField, '条件值必须为字符串、数值或相应数组', 'INVALID_TYPE');
      }
    });
  });
  return result();
}
