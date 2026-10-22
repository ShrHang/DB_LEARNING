import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDefinition } from '../../src/shared/definition.js';

const complete = { complete: true };
const wrap = (question) => ({ title: '有效问卷', description: '', questions: [question] });
const textQuestion = () => ({ id: 'q', type: 'text', title: '请输入' });
const singleQuestion = () => ({
  id: 'q', type: 'single_choice', title: '请选择', options: [{ id: 'a', label: '选项' }, { id: 'b', label: '选项' }],
});
const multiQuestion = () => ({ ...singleQuestion(), type: 'multiple_choice' });
const numericQuestion = () => ({ id: 'q', type: 'number', title: '请输入数字' });
const withRule = (question, condition, target = 'END') => ({ ...question, rules: [{ condition, target }] });
function valid(definition, options) {
  assert.deepEqual(validateDefinition(definition, options), { valid: true, errors: [] });
}
function invalid(definition, field, code = 'INVALID_VALUE', options) {
  const result = validateDefinition(definition, options);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.field === field && error.code === code), JSON.stringify(result));
  for (const error of result.errors) {
    assert.deepEqual(Object.keys(error).sort(), ['code', 'field', 'message']);
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
    assert.ok(['INVALID_TYPE', 'UNKNOWN_FIELD', 'INVALID_VALUE'].includes(error.code));
  }
}

test('U09 草稿接受空定义和服务补齐前的缺省字段，完整校验拒绝未完成内容', () => {
  for (const definition of [{}, { title: '', description: '', questions: [] },
    { questions: [{ id: 'short-id', type: 'text' }] },
    { questions: [{ id: 'choice', type: 'single_choice', options: [{ id: 'a' }] }] },
    { questions: [{ id: 'choice', type: 'multiple_choice', rules: [{}, { condition: {}, target: null }] }] }]) {
    valid(definition);
    assert.equal(validateDefinition(definition, complete).valid, false);
  }
  invalid({ title: '标题', questions: [] }, 'questions', 'INVALID_VALUE', complete);
  invalid({ title: '标题' }, 'questions', 'INVALID_VALUE', complete);
  invalid(wrap({ id: 'q', type: 'text', title: ' \n\t' }), 'questions.0.title', 'INVALID_VALUE', complete);
  invalid({ ...wrap(textQuestion()), title: '\u3000' }, 'title', 'INVALID_VALUE', complete);
  valid(wrap(textQuestion()), complete);
});

test('U09 顶层元信息由服务处理，仅校验标题、说明和题目', () => {
  valid({ ...wrap(textQuestion()), _id: { opaque: true }, settings: null, revision: 'ignored', ownerId: 42 }, complete);
  for (const value of [null, 4, false, {}, [], undefined]) {
    invalid({ title: value }, 'title', 'INVALID_TYPE');
    invalid({ description: value }, 'description', 'INVALID_TYPE');
  }
  for (const value of [null, false, 'questions', {}, 3, undefined]) {
    invalid({ questions: value }, 'questions', 'INVALID_TYPE');
  }
  for (const value of [null, undefined, [], 'definition', 3, false, new Date()]) {
    invalid(value, 'definition', 'INVALID_TYPE');
  }
});

test('U09 四种合法题型、重复选项文字、非UUID标识和缺省字段可完整发布', () => {
  valid({
    title: ' 四题型问卷 ',
    description: '说明😀',
    questions: [
      { ...singleQuestion(), validation: {}, required: true },
      { ...multiQuestion(), id: 'multi', validation: { minSelections: 0, maxSelections: 2 } },
      { ...textQuestion(), id: 'text', options: [], rules: [], validation: { minLength: 0, maxLength: 20 } },
      { ...numericQuestion(), id: 'number', validation: { min: -10, max: 0, integer: true } },
    ],
  }, complete);
  valid(wrap({ ...multiQuestion(), validation: { minSelections: 2, maxSelections: 2 } }), complete);
  valid(wrap({ ...numericQuestion(), validation: { min: -0.5, max: 0.5, integer: false } }), complete);
});

test('U09 标识始终必需、非空且类型正确，题型始终合法', () => {
  for (const value of ['', ' \n', 'END']) {
    invalid(wrap({ ...textQuestion(), id: value }), 'questions.0.id');
    invalid(wrap({ ...singleQuestion(), options: [{ id: value }] }), 'questions.0.options.0.id');
  }
  for (const value of [null, undefined, 1, false, {}, []]) {
    invalid(wrap({ ...textQuestion(), id: value }), 'questions.0.id', 'INVALID_TYPE');
    invalid(wrap({ ...singleQuestion(), options: [{ id: value }] }), 'questions.0.options.0.id', 'INVALID_TYPE');
    invalid(wrap({ ...textQuestion(), type: value }), 'questions.0.type', 'INVALID_TYPE');
  }
  invalid({ questions: [{ type: 'text' }] }, 'questions.0.id', 'INVALID_TYPE');
  invalid({ questions: [{ id: 'q' }] }, 'questions.0.type', 'INVALID_TYPE');
  for (const type of ['', 'multi', 'Number', '__proto__']) {
    invalid(wrap({ ...textQuestion(), type }), 'questions.0.type');
  }
});

test('U09 题目ID问卷内唯一，选项ID和可选规则ID各自题内唯一', () => {
  invalid({ title: '标题', questions: [textQuestion(), textQuestion()] }, 'questions.1.id');
  invalid(wrap({ ...singleQuestion(), options: [{ id: 'a' }, { id: 'a' }] }), 'questions.0.options.1.id');
  const rules = [
    { id: 'r', condition: { operator: 'eq', value: 'a' }, target: 'END' },
    { id: 'r', condition: { operator: 'ne', value: 'a' }, target: 'END' },
  ];
  invalid(wrap({ ...singleQuestion(), rules }), 'questions.0.rules.1.id');
  for (const value of ['', ' \t']) invalid(wrap({ ...textQuestion(), rules: [{ id: value }] }), 'questions.0.rules.0.id');
  for (const value of [null, false, 5, {}, undefined]) {
    invalid(wrap({ ...textQuestion(), rules: [{ id: value }] }), 'questions.0.rules.0.id', 'INVALID_TYPE');
  }
  valid({ title: '标题', questions: [
    { ...singleQuestion(), rules: [rules[0], { condition: { operator: 'ne', value: 'a' }, target: 'END' }] },
    { ...singleQuestion(), id: 'q2', rules: [rules[0]] },
  ] }, complete);
  valid(wrap({ ...singleQuestion(), rules: [
    { condition: { operator: 'eq', value: 'a' }, target: 'END' },
    { condition: { operator: 'ne', value: 'a' }, target: 'END' },
  ] }), complete);
});

const unknownCases = [
  ['questions.0.extra', () => wrap({ ...textQuestion(), extra: true })],
  ['questions.0.options.0.extra', () => wrap({ ...singleQuestion(), options: [{ id: 'a', label: 'A', extra: true }] })],
  ['questions.0.validation.pattern', () => wrap({ ...textQuestion(), validation: { pattern: '.*' } })],
  ['questions.0.rules.0.extra', () => wrap({ ...singleQuestion(), rules: [{ extra: true }] })],
  ['questions.0.rules.0.condition.script', () => wrap(withRule(singleQuestion(), { script: 'return true' }))],
];
for (const [field, make] of unknownCases) {
  test(`U09 嵌套白名单拒绝 ${field}（草稿及完整）`, () => {
    invalid(make(), field, 'UNKNOWN_FIELD');
    invalid(make(), field, 'UNKNOWN_FIELD', complete);
  });
}

test('U09 嵌套对象、数组和所有可选字段提供时严格检查类型', () => {
  for (const value of [null, 1, 'object', false, []]) {
    invalid({ questions: [value] }, 'questions.0', 'INVALID_TYPE');
    invalid(wrap({ ...singleQuestion(), options: [value] }), 'questions.0.options.0', 'INVALID_TYPE');
    invalid(wrap({ ...textQuestion(), validation: value }), 'questions.0.validation', 'INVALID_TYPE');
    invalid(wrap({ ...singleQuestion(), rules: [value] }), 'questions.0.rules.0', 'INVALID_TYPE');
    invalid(wrap(withRule(singleQuestion(), value)), 'questions.0.rules.0.condition', 'INVALID_TYPE');
  }
  for (const value of [null, 1, {}, false, 'array', undefined]) {
    invalid(wrap({ ...textQuestion(), rules: value }), 'questions.0.rules', 'INVALID_TYPE');
    invalid(wrap({ ...singleQuestion(), options: value }), 'questions.0.options', 'INVALID_TYPE');
  }
  for (const value of [null, 1, {}, [], undefined]) {
    invalid(wrap({ ...textQuestion(), required: value }), 'questions.0.required', 'INVALID_TYPE');
  }
  for (const value of [null, 1, {}, [], false, undefined]) {
    invalid(wrap({ ...textQuestion(), title: value }), 'questions.0.title', 'INVALID_TYPE');
    invalid(wrap({ ...singleQuestion(), options: [{ id: 'a', label: value }] }), 'questions.0.options.0.label', 'INVALID_TYPE');
  }
});

test('U09 完整选择题至少一个选项且文字非空；草稿可省略文字', () => {
  for (const type of ['single_choice', 'multiple_choice']) {
    for (const options of [[], [{ id: 'a' }], [{ id: 'a', label: '' }], [{ id: 'a', label: ' \n' }]]) {
      const definition = wrap({ id: 'q', type, title: '选择', options });
      valid(definition);
      assert.equal(validateDefinition(definition, complete).valid, false);
    }
    invalid(wrap({ id: 'q', type, title: '选择' }), 'questions.0.options', 'INVALID_VALUE', complete);
  }
  for (const type of ['text', 'number']) {
    invalid(wrap({ id: 'q', type, options: [{ id: 'a' }] }), 'questions.0.options');
  }
});

test('U09 约束字段仅属于相应题型，不接受任意校验配置', () => {
  const cases = [
    [singleQuestion(), { minSelections: 1 }, 'minSelections'],
    [textQuestion(), { min: 1 }, 'min'],
    [multiQuestion(), { minLength: 1 }, 'minLength'],
    [numericQuestion(), { maxSelections: 1 }, 'maxSelections'],
    [numericQuestion(), { pattern: {} }, 'pattern'],
  ];
  for (const [question, validation, key] of cases) {
    invalid(wrap({ ...question, validation }), `questions.0.validation.${key}`, 'UNKNOWN_FIELD');
  }
});

test('U09 码点长度和多选数量仅接受非负安全整数，包含0及安全上界', () => {
  for (const [make, fields] of [[textQuestion, ['minLength', 'maxLength']], [multiQuestion, ['minSelections', 'maxSelections']]]) {
    for (const field of fields) {
      for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) valid(wrap({ ...make(), validation: { [field]: value } }));
      for (const value of [-1, 0.5, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        invalid(wrap({ ...make(), validation: { [field]: value } }), `questions.0.validation.${field}`);
      }
      for (const value of [null, '', '1', false, {}, [], undefined]) {
        invalid(wrap({ ...make(), validation: { [field]: value } }), `questions.0.validation.${field}`, 'INVALID_TYPE');
      }
    }
  }
});

test('U09 数字上下限有限，整数安全；integer只接受布尔值', () => {
  for (const key of ['min', 'max']) {
    for (const value of [0, -0.5, 1.5, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      valid(wrap({ ...numericQuestion(), validation: { [key]: value } }), complete);
    }
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
      invalid(wrap({ ...numericQuestion(), validation: { [key]: value } }), `questions.0.validation.${key}`);
    }
    for (const value of [null, '0', {}, false, []]) {
      invalid(wrap({ ...numericQuestion(), validation: { [key]: value } }), `questions.0.validation.${key}`, 'INVALID_TYPE');
    }
  }
  for (const integer of [true, false]) valid(wrap({ ...numericQuestion(), validation: { integer } }), complete);
  for (const integer of [null, 0, 'true', {}, undefined]) {
    invalid(wrap({ ...numericQuestion(), validation: { integer } }), 'questions.0.validation.integer', 'INVALID_TYPE');
  }
});

test('U09 草稿允许范围编辑中矛盾，完整校验检查上下界和可选数量', () => {
  for (const [make, minKey, maxKey] of [[textQuestion, 'minLength', 'maxLength'],
    [multiQuestion, 'minSelections', 'maxSelections'], [numericQuestion, 'min', 'max']]) {
    const definition = wrap({ ...make(), validation: { [minKey]: 2, [maxKey]: 1 } });
    valid(definition);
    invalid(definition, `questions.0.validation.${maxKey}`, 'INVALID_VALUE', complete);
    valid(wrap({ ...make(), validation: { [minKey]: 1, [maxKey]: 1 } }), complete);
    valid(wrap({ ...make(), validation: { [minKey]: 0 } }), complete);
    valid(wrap({ ...make(), validation: { [maxKey]: 1 } }), complete);
  }
  for (const key of ['minSelections', 'maxSelections']) {
    const definition = wrap({ ...multiQuestion(), validation: { [key]: 3 } });
    valid(definition);
    invalid(definition, `questions.0.validation.${key}`, 'INVALID_VALUE', complete);
  }
});

test('U09 规则可未完成；完整校验要求条件、操作符、值及目标', () => {
  for (const rule of [{}, { condition: {} }, { target: null }, { condition: { operator: 'eq' }, target: 'END' },
    { condition: { value: 'a' }, target: 'END' }]) {
    const definition = wrap({ ...singleQuestion(), rules: [rule] });
    valid(definition);
    assert.equal(validateDefinition(definition, complete).valid, false);
  }
  const condition = { operator: 'eq', value: 'a' };
  for (const rule of [{ condition }, { condition, target: null }]) {
    invalid(wrap({ ...singleQuestion(), rules: [rule] }), 'questions.0.rules.0.target', 'INVALID_VALUE', complete);
  }
  for (const target of [0, false, [], {}, undefined]) {
    invalid(wrap({ ...singleQuestion(), rules: [{ target }] }), 'questions.0.rules.0.target', 'INVALID_TYPE');
  }
  invalid(wrap(withRule(singleQuestion(), condition, ' ')), 'questions.0.rules.0.target');
});

test('U09 单选eq/ne引用稳定选项ID，草稿允许悬空选项及目标', () => {
  for (const operator of ['eq', 'ne']) {
    valid(wrap(withRule(singleQuestion(), { operator, value: 'a' })), complete);
    const missingOption = wrap(withRule(singleQuestion(), { operator, value: 'deleted-option' }));
    valid(missingOption);
    invalid(missingOption, 'questions.0.rules.0.condition.value', 'INVALID_VALUE', complete);
    for (const value of [0, false, {}, []]) {
      invalid(wrap(withRule(singleQuestion(), { operator, value })), 'questions.0.rules.0.condition.value', 'INVALID_TYPE');
    }
    const missingTarget = wrap(withRule(singleQuestion(), { operator, value: 'a' }, 'deleted-question'));
    valid(missingTarget);
    invalid(missingTarget, 'questions.0.rules.0.target', 'INVALID_VALUE', complete);
  }
});

for (const operator of ['contains_any', 'contains_all', 'equals_set']) {
  test(`U09 多选${operator}使用非空、无重复选项ID数组`, () => {
    valid(wrap(withRule(multiQuestion(), { operator, value: ['b', 'a'] })), complete);
    valid(wrap(withRule(multiQuestion(), { operator, value: ['missing'] })));
    invalid(wrap(withRule(multiQuestion(), { operator, value: ['missing'] })),
      'questions.0.rules.0.condition.value.0', 'INVALID_VALUE', complete);
    valid(wrap(withRule(multiQuestion(), { operator, value: [] })));
    invalid(wrap(withRule(multiQuestion(), { operator, value: [] })), 'questions.0.rules.0.condition.value', 'INVALID_VALUE', complete);
    invalid(wrap(withRule(multiQuestion(), { operator, value: ['a', 'a'] })), 'questions.0.rules.0.condition.value.1');
    invalid(wrap(withRule(multiQuestion(), { operator, value: [''] })), 'questions.0.rules.0.condition.value.0');
    for (const value of ['a', 0, {}]) {
      invalid(wrap(withRule(multiQuestion(), { operator, value })), 'questions.0.rules.0.condition.value', 'INVALID_TYPE');
    }
    for (const value of [0, null, {}, []]) {
      invalid(wrap(withRule(multiQuestion(), { operator, value: [value] })), 'questions.0.rules.0.condition.value.0', 'INVALID_TYPE');
    }
  });
}

test('U09 数字七种比较支持有限数值和闭区间，包括0与负数', () => {
  for (const operator of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']) {
    for (const value of [0, -1, 0.5]) valid(wrap(withRule(numericQuestion(), { operator, value })), complete);
    for (const value of [Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      invalid(wrap(withRule(numericQuestion(), { operator, value })), 'questions.0.rules.0.condition.value');
    }
    for (const value of ['0', {}, [0]]) {
      invalid(wrap(withRule(numericQuestion(), { operator, value })), 'questions.0.rules.0.condition.value', 'INVALID_TYPE');
    }
  }
  for (const value of [[0, 0], [-1, 0], [0.5, 1.5]]) {
    valid(wrap(withRule(numericQuestion(), { operator: 'between', value })), complete);
  }
  const inverted = wrap(withRule(numericQuestion(), { operator: 'between', value: [2, 1] }));
  valid(inverted);
  invalid(inverted, 'questions.0.rules.0.condition.value', 'INVALID_VALUE', complete);
  for (const value of [[], [0], [0, 1, 2]]) {
    invalid(wrap(withRule(numericQuestion(), { operator: 'between', value })), 'questions.0.rules.0.condition.value');
  }
  invalid(wrap(withRule(numericQuestion(), { operator: 'between', value: [0, Infinity] })), 'questions.0.rules.0.condition.value.1');
  invalid(wrap(withRule(numericQuestion(), { operator: 'between', value: [0, '1'] })), 'questions.0.rules.0.condition.value.1', 'INVALID_TYPE');
});

test('U09 操作符白名单始终检查，题型兼容性在完整校验时检查', () => {
  for (const operator of ['exec', 'constructor']) {
    invalid(wrap(withRule(numericQuestion(), { operator, value: 1 })), 'questions.0.rules.0.condition.operator');
  }
  for (const operator of [null, 0, {}, [], undefined]) {
    invalid(wrap(withRule(numericQuestion(), { operator, value: 1 })), 'questions.0.rules.0.condition.operator', 'INVALID_TYPE');
  }
  for (const question of [
    withRule(singleQuestion(), { operator: 'gt', value: 1 }),
    withRule(multiQuestion(), { operator: 'eq', value: 'a' }),
    withRule(numericQuestion(), { operator: 'contains_all', value: ['a'] }),
    withRule(textQuestion(), { operator: 'eq', value: 'text' }),
  ]) {
    valid(wrap(question));
    invalid(wrap(question), 'questions.0.rules.0.condition.operator', 'INVALID_VALUE', complete);
  }
  invalid(wrap(withRule(textQuestion(), {})), 'questions.0.rules', 'INVALID_VALUE', complete);
});

test('U09 草稿的未完成条件值不能携带任意对象或非法数值', () => {
  for (const value of [{}, false, { $where: 'arbitrary' }]) {
    invalid(wrap(withRule(singleQuestion(), { value })), 'questions.0.rules.0.condition.value', 'INVALID_TYPE');
  }
  invalid(wrap(withRule(singleQuestion(), { value: [{}] })), 'questions.0.rules.0.condition.value.0', 'INVALID_TYPE');
  invalid(wrap(withRule(singleQuestion(), { value: [Infinity] })), 'questions.0.rules.0.condition.value.0');
});

test('U09 草稿各类条件值允许缺省或null，完整校验按未完成值拒绝', () => {
  const cases = [
    [singleQuestion, ['eq', 'ne']],
    [multiQuestion, ['contains_any', 'contains_all', 'equals_set']],
    [numericQuestion, ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between']],
  ];
  for (const [make, operators] of cases) {
    for (const operator of operators) {
      for (const condition of [{ operator }, { operator, value: null }]) {
        const definition = wrap(withRule(make(), condition));
        valid(definition);
        invalid(definition, 'questions.0.rules.0.condition.value', 'INVALID_VALUE', complete);
        assert.equal(validateDefinition(definition, complete).errors.some((error) => error.code === 'INVALID_TYPE'), false);
      }
    }
  }
  valid(wrap(withRule(singleQuestion(), { value: null })));
  // Explicit undefined is neither the JSON null placeholder nor an omitted field.
  invalid(wrap(withRule(singleQuestion(), { operator: 'eq', value: undefined })),
    'questions.0.rules.0.condition.value', 'INVALID_TYPE');
});

test('U09 between草稿允许两个null界限及单边完成，完整校验要求两边补全', () => {
  for (const value of [[null, null], [null, 0], [0, null], [null, -0.5], [1.5, null]]) {
    const definition = wrap(withRule(numericQuestion(), { operator: 'between', value }));
    valid(definition);
    value.forEach((entry, index) => {
      if (entry === null) invalid(definition, `questions.0.rules.0.condition.value.${index}`, 'INVALID_VALUE', complete);
    });
    assert.equal(validateDefinition(definition, complete).errors.some((error) => error.code === 'INVALID_TYPE'), false);
  }
  for (const value of [[null], [null, null, null]]) {
    invalid(wrap(withRule(numericQuestion(), { operator: 'between', value })), 'questions.0.rules.0.condition.value');
  }
  for (const entry of [false, '', {}, [], undefined]) {
    const definition = wrap(withRule(numericQuestion(), { operator: 'between', value: [null, entry] }));
    invalid(definition, 'questions.0.rules.0.condition.value.1', 'INVALID_TYPE');
    invalid(definition, 'questions.0.rules.0.condition.value.1', 'INVALID_TYPE', complete);
  }
  for (const entry of [Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    invalid(wrap(withRule(numericQuestion(), { operator: 'between', value: [entry, null] })),
      'questions.0.rules.0.condition.value.0');
  }
});

test('U09 草稿空操作符视为未选，完整校验拒绝，仍检查非空非法值与白名单', () => {
  for (const condition of [{ operator: '' }, { operator: '', value: null }, { operator: '', value: 0 }]) {
    const definition = wrap(withRule(numericQuestion(), condition));
    valid(definition);
    invalid(definition, 'questions.0.rules.0.condition.operator', 'INVALID_VALUE', complete);
    assert.equal(validateDefinition(definition, complete).errors.some((error) => error.code === 'INVALID_TYPE'), false);
  }
  for (const operator of [' ', 'unknown']) {
    invalid(wrap(withRule(numericQuestion(), { operator, value: null })), 'questions.0.rules.0.condition.operator');
  }
  for (const value of [{}, false, [{}]]) {
    const definition = wrap(withRule(numericQuestion(), { operator: '', value }));
    assert.equal(validateDefinition(definition).valid, false);
    assert.equal(validateDefinition(definition, complete).valid, false);
  }
  for (const condition of [
    { operator: '', value: null, extra: true },
    { operator: 'between', value: [null, null], extra: true },
    { operator: 'contains_any', value: [], extra: true },
  ]) {
    invalid(wrap(withRule(numericQuestion(), condition)), 'questions.0.rules.0.condition.extra', 'UNKNOWN_FIELD');
    invalid(wrap(withRule(numericQuestion(), condition)), 'questions.0.rules.0.condition.extra', 'UNKNOWN_FIELD', complete);
  }
  // null array members are reserved for between bounds, never option IDs.
  invalid(wrap(withRule(multiQuestion(), { operator: 'contains_any', value: [null] })),
    'questions.0.rules.0.condition.value.0', 'INVALID_TYPE');
  invalid(wrap(withRule(numericQuestion(), { operator: '', value: [null, null] })),
    'questions.0.rules.0.condition.value.0', 'INVALID_TYPE');
});

test('U09 完整校验允许前跳、回跳、自跳、有环图及END，保持规则顺序', () => {
  const definition = { title: '允许循环', questions: [
    { ...singleQuestion(), rules: [
      { condition: { operator: 'eq', value: 'a' }, target: 'later' },
      { condition: { operator: 'ne', value: 'a' }, target: 'q' },
    ] },
    { ...numericQuestion(), id: 'later', rules: [
      { condition: { operator: 'lt', value: 0 }, target: 'q' },
      { condition: { operator: 'gte', value: 0 }, target: 'END' },
    ] },
  ] };
  const original = structuredClone(definition);
  valid(definition, complete);
  assert.deepEqual(definition, original);
});

test('U09 纯函数接受冻结输入，不填充默认值或修改草稿', () => {
  const question = Object.freeze({ id: 'q', type: 'text' });
  const definition = Object.freeze({ questions: Object.freeze([question]) });
  valid(definition);
  assert.deepEqual(Object.keys(question), ['id', 'type']);
  assert.equal(validateDefinition(definition, complete).valid, false);
});
