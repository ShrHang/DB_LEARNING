import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, getNextQuestion } from '../../src/shared/rules.js';

const choices = ['a', 'b', 'c'].map((id) => ({ id, label: id }));
const single = { id: 'q', type: 'single_choice', options: choices, rules: [] };
const multi = { ...single, type: 'multiple_choice' };
const number = { id: 'n', type: 'number', rules: [] };

test('U05 单选eq/ne独立真值表，不将空答当作不等于', () => {
  for (const [value, expected, eq, ne] of [
    ['a', 'a', true, false], ['a', 'b', false, true], ['b', 'a', false, true],
    [null, 'a', false, false], [undefined, 'a', false, false],
  ]) {
    assert.equal(evaluateCondition(single, value, { operator: 'eq', value: expected }), eq);
    assert.equal(evaluateCondition(single, value, { operator: 'ne', value: expected }), ne);
  }
});

test('U05 多选集合独立真值表包含交集、子集、全集和顺序变化', () => {
  const rows = [
    [['a'], ['a'], true, true, true],
    [['a'], ['b'], false, false, false],
    [['a'], ['a', 'b'], true, false, false],
    [['a', 'b'], ['a'], true, true, false],
    [['a', 'b'], ['b', 'a'], true, true, true],
    [['a', 'b'], ['b', 'c'], true, false, false],
    [['a', 'b'], ['c'], false, false, false],
    [[], ['a'], false, false, false],
    [null, ['a'], false, false, false],
  ];
  for (const [value, expected, any, all, equal] of rows) {
    for (const [operator, result] of [['contains_any', any], ['contains_all', all], ['equals_set', equal]]) {
      assert.equal(evaluateCondition(multi, value, { operator, value: expected }), result,
        JSON.stringify({ value, expected, operator }));
    }
  }
});

const numericRows = [
  ['eq', 2, [[1, false], [2, true], [3, false]]],
  ['ne', 2, [[1, true], [2, false], [3, true]]],
  ['gt', 2, [[1, false], [2, false], [3, true]]],
  ['gte', 2, [[1, false], [2, true], [3, true]]],
  ['lt', 2, [[1, true], [2, false], [3, false]]],
  ['lte', 2, [[1, true], [2, true], [3, false]]],
  ['between', [-1, 1], [[-2, false], [-1, true], [0, true], [1, true], [2, false]]],
  ['between', [0, 0], [[-0.5, false], [0, true], [0.5, false]]],
];
for (const [operator, expected, rows] of numericRows) {
  test(`U05 数字${operator}独立真值表 ${JSON.stringify(expected)}`, () => {
    for (const [value, result] of rows) {
      assert.equal(evaluateCondition(number, value, { operator, value: expected }), result, String(value));
    }
    for (const value of [null, undefined, NaN, Infinity, '2', [], Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(evaluateCondition(number, value, { operator, value: expected }), false);
    }
  });
}

test('U05 操作符白名单及题型边界，畸形条件不进行强制转换', () => {
  const rows = [
    [single, 'a', { operator: 'gt', value: 'a' }],
    [single, 'a', { operator: 'eq', value: 'missing' }],
    [multi, ['a'], { operator: 'eq', value: ['a'] }],
    [multi, ['a'], { operator: 'contains_all', value: [] }],
    [multi, ['a'], { operator: 'contains_any', value: ['a', 'a'] }],
    [multi, ['a'], { operator: 'contains_any', value: ['a', 'missing'] }],
    [multi, ['a', 'a'], { operator: 'contains_any', value: ['a'] }],
    [{ id: 't', type: 'text' }, 'a', { operator: 'eq', value: 'a' }],
    [number, 2, { operator: 'eval', value: 2 }],
    [number, 2, { operator: '__proto__', value: 2 }],
    [number, 2, { operator: 'eq', value: '2' }],
    [number, 2, { operator: 'ne', value: Number.MAX_SAFE_INTEGER + 1 }],
    [number, 2, { operator: 'between', value: [3, 1] }],
    [number, 2, { operator: 'between', value: [null, 3] }],
    [number, 2, { operator: 'between', value: [0] }],
    [number, 2, { operator: 'between', value: [0, 3, 4] }],
    [number, 2, { operator: 'between', value: [0, Infinity] }],
    [number, 2, { operator: 'between', value: [0, Number.MAX_SAFE_INTEGER + 1] }],
  ];
  for (const [question, value, condition] of rows) assert.equal(evaluateCondition(question, value, condition), false);
  for (const condition of [null, undefined, [], {}, 'eq']) assert.equal(evaluateCondition(number, 2, condition), false);
});

test('U06 首条规则命中，重排改变结果；无命中默认顺序，不连续沿链跳转', () => {
  const a = { condition: { operator: 'gte', value: 1 }, target: 'q3' };
  const b = { condition: { operator: 'lte', value: 10 }, target: 'END' };
  const questions = [
    { ...number, id: 'q1', rules: [a, b] },
    { id: 'q2', type: 'text' },
    { ...number, id: 'q3', rules: [{ condition: { operator: 'eq', value: 5 }, target: 'q1' }] },
  ];
  assert.equal(getNextQuestion(questions, 'q1', 5), 'q3');
  assert.equal(getNextQuestion([{ ...questions[0], rules: [b, a] }, ...questions.slice(1)], 'q1', 5), 'END');
  assert.equal(getNextQuestion([{ ...questions[0], rules: [a] }, ...questions.slice(1)], 'q1', 0), 'q2');
  assert.equal(getNextQuestion(questions, 'q3', 5), 'q1');
  assert.equal(getNextQuestion(questions, 'q3', 6), 'END');
  assert.equal(getNextQuestion(questions, 'q2', 'text'), 'q3');
});

test('U06 空答不匹配ne，多选空数组不命中，末题和显式END结束', () => {
  const questions = [
    { ...single, id: 'q1', rules: [{ condition: { operator: 'ne', value: 'a' }, target: 'END' }] },
    { ...multi, id: 'q2', rules: [{ condition: { operator: 'contains_all', value: ['a'] }, target: 'q1' }] },
    { id: 'q3', type: 'text' },
  ];
  assert.equal(getNextQuestion(questions, 'q1', null), 'q2');
  assert.equal(getNextQuestion(questions, 'q1', 'b'), 'END');
  assert.equal(getNextQuestion(questions, 'q2', []), 'q3');
  assert.equal(getNextQuestion(questions, 'q3', ''), 'END');
  assert.throws(() => getNextQuestion(questions, 'missing', null), RangeError);
});

test('U06 冻结的题目、规则和答案均不被更改', () => {
  const condition = Object.freeze({ operator: 'equals_set', value: Object.freeze(['b', 'a']) });
  const q = Object.freeze({ ...multi, rules: Object.freeze([Object.freeze({ condition, target: 'END' })]) });
  const questions = Object.freeze([q]);
  const value = Object.freeze(['a', 'b']);
  assert.equal(evaluateCondition(q, value, condition), true);
  assert.equal(getNextQuestion(questions, 'q', value), 'END');
  assert.deepEqual(value, ['a', 'b']);
  assert.deepEqual(condition.value, ['b', 'a']);
});
