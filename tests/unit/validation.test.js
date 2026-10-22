import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswer, validateAnswer } from '../../src/shared/answers.js';

const options = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id }));
const question = (type, validation = {}, required = false) => ({
  id: 'q', type, title: '题目', required, options, validation, rules: [],
});
function valid(q, input, expected = input) {
  assert.deepEqual(validateAnswer(q, input), { valid: true, value: expected, errors: [] });
}
function invalid(q, input, code) {
  const result = validateAnswer(q, input);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  for (const error of result.errors) {
    assert.deepEqual(Object.keys(error).sort(), ['code', 'field', 'message', 'questionId']);
    assert.equal(error.questionId, 'q');
    assert.equal(error.field, 'answers.q');
    assert.ok(error.message.length > 0);
    if (code) assert.equal(error.code, code);
  }
}

test('U01 单选缺失/null按必答检查，空字符串不是合法选项，合法ID原样保留', () => {
  const q = question('single_choice');
  for (const input of [undefined, null]) {
    valid(q, input, null);
    invalid({ ...q, required: true }, input, 'REQUIRED');
  }
  valid(q, 'a');
  valid(q, 'b');
  for (const input of ['unknown', '', ' a ']) invalid(q, input, 'INVALID_VALUE');
});

test('U01–04 错误类型不会被规范化为空答，即使题目可选', () => {
  const rows = [
    ['single_choice', [false, 0, [], {}, ['a']]],
    ['multiple_choice', [false, 0, '', 'a', {}, [null], [1], [undefined], new Array(1)]],
    ['text', [false, 0, [], {}, ['a']]],
    ['number', [false, '', '0', '12abc', [], {}, [0], new Number(0)]],
  ];
  for (const [type, inputs] of rows) {
    for (const input of inputs) {
      const q = question(type);
      assert.equal(normalizeAnswer(q, input).valid, false, `${type}: ${String(input)}`);
      invalid(q, input, 'INVALID_TYPE');
    }
  }
});

test('U02 多选min=2/max=3独立边界表，空答只检查required', () => {
  const q = question('multiple_choice', { minSelections: 2, maxSelections: 3 });
  for (const input of [undefined, null, []]) {
    valid(q, input, null);
    invalid({ ...q, required: true }, input, 'REQUIRED');
  }
  invalid(q, ['a']);
  valid(q, ['a', 'b']);
  valid(q, ['c', 'a', 'b']);
  invalid(q, ['a', 'b', 'c', 'd']);
  invalid(q, ['a', 'a']);
  invalid(q, ['a', 'missing']);
  invalid(question('multiple_choice', { maxSelections: 0 }), ['a']);
  valid(question('multiple_choice', { maxSelections: 0 }), [], null);
});

test('U02 规范化不静默去重或改变选项顺序，校验拒绝重复项', () => {
  const q = question('multiple_choice');
  const input = Object.freeze(['b', 'a', 'a']);
  const normalized = normalizeAnswer(q, input);
  assert.deepEqual(normalized, { valid: true, value: ['b', 'a', 'a'], errors: [] });
  assert.notEqual(normalized.value, input);
  invalid(q, input);
  const selected = Object.freeze(['b', 'a']);
  const result = validateAnswer(q, selected);
  assert.deepEqual(result.value, ['b', 'a']);
  result.value.push('c');
  assert.deepEqual(selected, ['b', 'a']);
});

test('U02 恰好选2项：相等上下限拒绝1/3项，接受2项，空答按必答区分', () => {
  for (const required of [false, true]) {
    const q = { ...question('multiple_choice', { minSelections: 2, maxSelections: 2 }, required), options: options.slice(0, 3) };
    invalid(q, ['a'], 'INVALID_VALUE');
    valid(q, ['b', 'a']);
    invalid(q, ['a', 'b', 'c'], 'INVALID_VALUE');
    for (const input of [undefined, null, []]) {
      if (required) invalid(q, input, 'REQUIRED');
      else valid(q, input, null);
    }
  }
});

test('U03 文本按码点计数，组合表情不按字形计数，非空原文不trim', () => {
  const q = question('text', { minLength: 2, maxLength: 4 });
  for (const [input, expectedValid] of [
    ['a', false], ['中文', true], ['a😀', true], ['中ab😀', true], ['中abc😀', false],
    ['😀', false], ['👨‍👩‍👧‍👦', false], ['e\u0301', true], [' a ', true],
  ]) {
    if (expectedValid) valid(q, input);
    else invalid(q, input);
  }
  valid(question('text', { minLength: 1, maxLength: 1 }), '😀');
  valid(question('text', { minLength: 7, maxLength: 7 }), '👨‍👩‍👧‍👦');
  for (const input of [undefined, null, '', ' \n\t', '\u3000']) {
    valid(q, input, null);
    invalid({ ...q, required: true }, input, 'REQUIRED');
  }
  valid(question('text', { maxLength: 0 }), '', null);
  invalid(question('text', { maxLength: 0 }), 'a');
});

test('U04 数字闭区间与整数限制，0有效，负零规范为0', () => {
  const q = question('number', { min: 0, max: 120, integer: true }, true);
  valid(q, 0);
  valid(q, -0, 0);
  valid(q, 120);
  for (const input of [-1, 121, 1.5]) invalid(q, input);
  for (const input of [null, undefined]) invalid(q, input, 'REQUIRED');
  valid(question('number', { min: 1, integer: true }), null, null);
  valid(question('number', { min: -0.5, max: 0.5 }), -0.5);
  valid(question('number', { min: -0.5, max: 0.5 }), 0.5);
  invalid(question('number', { min: -0.5, max: 0.5 }), 0.50001);
});

test('U04 所有整数均须safe，不以integer=true或上下界作为前提', () => {
  for (const validation of [{}, { integer: false }, { integer: true }]) {
    const q = question('number', validation);
    valid(q, Number.MAX_SAFE_INTEGER);
    valid(q, Number.MIN_SAFE_INTEGER);
    for (const input of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, 1e30, -1e30,
      NaN, Infinity, -Infinity]) invalid(q, input, 'INVALID_VALUE');
  }
  for (const input of [0.25, -0.25, Number.MIN_VALUE]) valid(question('number'), input);
});

test('U01–04 冻结输入不被修改，未知题型和合法类型检查不依赖Node/DOM', () => {
  const q = Object.freeze({ ...question('multiple_choice'), options: Object.freeze(options), validation: Object.freeze({}) });
  const selected = Object.freeze(['d', 'a']);
  valid(q, selected, ['d', 'a']);
  for (const type of ['__proto__', 'Number', 'unknown']) {
    invalid({ ...q, type }, null, 'INVALID_TYPE');
  }
});

test('U03 非法Unicode代理项拒绝，合法代理对/组合表情原样保留', () => {
  const question = {id:'t',type:'text',required:false};
  for (const value of ['a\uD800b', '\uDC00', '\uD800\uD800']) {
    assert.equal(validateAnswer(question,value).valid,false);
    assert.equal(normalizeAnswer(question,value).valid,false);
  }
  for (const value of ['😀', '👨‍👩‍👧‍👦', 'a\uFFFDb']) assert.equal(validateAnswer(question,value).value,value);
});
