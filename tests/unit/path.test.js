import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFinalPath } from '../../src/shared/path.js';
import { getNextQuestion } from '../../src/shared/rules.js';

const pathQuestions = () => [
  { id: 'Q1', type: 'text', required: true },
  { id: 'Q2', type: 'single_choice', required: true,
    options: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }], rules: [
      { condition: { operator: 'eq', value: 'A' }, target: 'Q3' },
      { condition: { operator: 'eq', value: 'B' }, target: 'Q4' },
    ] },
  { id: 'Q3', type: 'single_choice', required: true, options: [{ id: 'Back', label: '返回' }],
    rules: [{ condition: { operator: 'eq', value: 'Back' }, target: 'Q2' }] },
  { id: 'Q4', type: 'text', required: true },
];
const finalAnswers = () => [
  { questionId: 'Q1', value: ' 起点 ' }, { questionId: 'Q2', value: 'B' }, { questionId: 'Q4', value: '终点' },
];
function failure(result, code, id) {
  assert.equal(result.valid, false);
  assert.equal(result.code, code);
  assert.ok(result.errors.length > 0);
  for (const error of result.errors) {
    assert.deepEqual(Object.keys(error).sort(), ['code', 'field', 'message', 'questionId']);
    assert.equal(error.questionId, id);
    assert.equal(error.field, `answers.${id}`);
    assert.ok(error.message.length > 0);
  }
}

test('U07 最终路径从首题重算，仅接受Q1/Q2/Q4，输出依路径排序且保留原文', () => {
  const answers = finalAnswers();
  assert.deepEqual(resolveFinalPath(pathQuestions(), [answers[2], answers[0], answers[1]]), {
    valid: true, answers, effectivePath: ['Q1', 'Q2', 'Q4'], errors: [], code: null,
  });
});

test('U07 缺失必答、路径内未知选项和非法类型均为ANSWER_INVALID并停止定位', () => {
  failure(resolveFinalPath(pathQuestions(), finalAnswers().slice(0, 2)), 'ANSWER_INVALID', 'Q4');
  failure(resolveFinalPath(pathQuestions(), [{ questionId: 'Q1', value: ' \n' }]), 'ANSWER_INVALID', 'Q1');
  failure(resolveFinalPath(pathQuestions(), [finalAnswers()[0], { questionId: 'Q2', value: 'unknown' }]), 'ANSWER_INVALID', 'Q2');
  const result = resolveFinalPath(pathQuestions(), [{ questionId: 'Q1', value: [] }]);
  failure(result, 'ANSWER_INVALID', 'Q1');
  assert.deepEqual(result.effectivePath, ['Q1']);
  assert.deepEqual(result.answers, []);
});

test('U07 未知/重复条目在两种模式中始终拒绝，包括未访问的缓存题目', () => {
  for (const rejectOutside of [true, false]) {
    const opts = { rejectOutside };
    failure(resolveFinalPath(pathQuestions(), [...finalAnswers(), { questionId: 'missing', value: null }], opts), 'ANSWER_INVALID', 'missing');
    failure(resolveFinalPath(pathQuestions(), [...finalAnswers(), finalAnswers()[1]], opts), 'ANSWER_INVALID', 'Q2');
    failure(resolveFinalPath(pathQuestions(), [...finalAnswers(), { questionId: 'Q3' }, { questionId: 'Q3', value: 'Back' }], opts), 'ANSWER_INVALID', 'Q3');
    for (const entry of [null, [], 0, false, 'Q1', {}, { questionId: 1 }]) {
      failure(resolveFinalPath(pathQuestions(), [...finalAnswers(), entry], opts), 'ANSWER_INVALID', null);
    }
    for (const input of [undefined, null, {}, 'answers']) {
      failure(resolveFinalPath(pathQuestions(), input, opts), 'ANSWER_INVALID', null);
    }
  }
});

test('U07 严格模式拒绝路径外答案；客户端模式筛除历史分支', () => {
  const cached = [...finalAnswers(), { questionId: 'Q3', value: 'Back' }];
  failure(resolveFinalPath(pathQuestions(), cached), 'ANSWER_OUTSIDE_PATH', 'Q3');
  assert.deepEqual(resolveFinalPath(pathQuestions(), cached, { rejectOutside: false }), {
    valid: true, answers: finalAnswers(), effectivePath: ['Q1', 'Q2', 'Q4'], errors: [], code: null,
  });
});

test('U07 历史分支的非法数字草稿不阻碍新路径，严格模式仍拒绝该路径外条目', () => {
  const questions = pathQuestions();
  questions[2] = { id: 'Q3', type: 'number', required: true, validation: { min: 0 } };
  for (const value of [NaN, Infinity, [], '12abc', -1, Number.MAX_SAFE_INTEGER + 1, {}]) {
    const cached = [...finalAnswers(), { questionId: 'Q3', value }];
    assert.deepEqual(resolveFinalPath(questions, cached, { rejectOutside: false }), {
      valid: true, answers: finalAnswers(), effectivePath: ['Q1', 'Q2', 'Q4'], errors: [], code: null,
    });
    failure(resolveFinalPath(questions, cached), 'ANSWER_OUTSIDE_PATH', 'Q3');
  }
});

test('U07 缺失可选值补null；空多选/空白文本标准化，0有效', () => {
  const questions = [
    { id: 'optional', type: 'number', validation: { min: 10 } },
    { id: 'multi', type: 'multiple_choice', options: [{ id: 'a' }], validation: { minSelections: 1 } },
    { id: 'text', type: 'text', validation: { minLength: 3 } },
    { id: 'zero', type: 'number', required: true },
  ];
  const result = resolveFinalPath(questions, [
    { questionId: 'multi', value: [] }, { questionId: 'text', value: '\u3000' }, { questionId: 'zero', value: -0 },
  ]);
  assert.deepEqual(result, {
    valid: true, answers: [
      { questionId: 'optional', value: null }, { questionId: 'multi', value: null },
      { questionId: 'text', value: null }, { questionId: 'zero', value: 0 },
    ], effectivePath: ['optional', 'multi', 'text', 'zero'], errors: [], code: null,
  });
});

test('U07 原始数字[]即使可选也不能当空答，非空字符串原样保留', () => {
  for (const rejectOutside of [true, false]) {
    failure(resolveFinalPath([{ id: 'n', type: 'number' }], [{ questionId: 'n', value: [] }], { rejectOutside }), 'ANSWER_INVALID', 'n');
    assert.deepEqual(resolveFinalPath([{ id: 't', type: 'text' }], [{ questionId: 't', value: ' a\n ' }], { rejectOutside }).answers,
      [{ questionId: 't', value: ' a\n ' }]);
  }
});

test('U07 已访问多选重复/未知项必须拒绝；未访问的多选草稿可筛除', () => {
  const questions = [
    { id: 'choose', type: 'single_choice', options: [{ id: 'skip' }, { id: 'visit' }],
      rules: [{ condition: { operator: 'eq', value: 'skip' }, target: 'END' }] },
    { id: 'multi', type: 'multiple_choice', options: [{ id: 'a' }, { id: 'b' }] },
  ];
  for (const value of [['a', 'a'], ['missing'], [null], 5]) {
    for (const rejectOutside of [true, false]) {
      failure(resolveFinalPath(questions, [{ questionId: 'choose', value: 'visit' }, { questionId: 'multi', value }], { rejectOutside }), 'ANSWER_INVALID', 'multi');
    }
    assert.equal(resolveFinalPath(questions, [{ questionId: 'choose', value: 'skip' }, { questionId: 'multi', value }], { rejectOutside: false }).valid, true);
  }
});

test('U08 固定答案重复节点即PATH_NOT_COMPLETE，不继续验证未达题', { timeout: 1000 }, () => {
  const answers = [
    { questionId: 'Q1', value: '起点' }, { questionId: 'Q2', value: 'A' }, { questionId: 'Q3', value: 'Back' },
  ];
  const result = resolveFinalPath(pathQuestions(), answers);
  failure(result, 'PATH_NOT_COMPLETE', 'Q2');
  assert.deepEqual(result.effectivePath, ['Q1', 'Q2', 'Q3']);
  assert.deepEqual(result.answers, answers);
  const self = [{ id: 'q', type: 'number', rules: [{ condition: { operator: 'eq', value: 0 }, target: 'q' }] }];
  failure(resolveFinalPath(self, [{ questionId: 'q', value: 0 }]), 'PATH_NOT_COMPLETE', 'q');
  failure(resolveFinalPath(self, [{ questionId: 'q', value: [] }]), 'ANSWER_INVALID', 'q');
});

test('U08 交互回跳无次数拦截，改变最终分支后路径可结束', () => {
  const questions = pathQuestions();
  for (let i = 0; i < 5000; i += 1) {
    assert.equal(getNextQuestion(questions, 'Q2', 'A'), 'Q3');
    assert.equal(getNextQuestion(questions, 'Q3', 'Back'), 'Q2');
  }
  assert.equal(getNextQuestion(questions, 'Q2', 'B'), 'Q4');
  assert.equal(resolveFinalPath(questions, finalAnswers()).valid, true);
});

test('U08 长顺序路径不使用递归或访问次数上限，特殊ID通过Map处理', () => {
  const questions = Array.from({ length: 12000 }, (_, i) => ({ id: `q${i}`, type: 'text' }));
  const result = resolveFinalPath(questions, []);
  assert.equal(result.valid, true);
  assert.equal(result.effectivePath.length, 12000);
  assert.deepEqual(result.answers[11999], { questionId: 'q11999', value: null });
  assert.deepEqual(resolveFinalPath([{ id: '__proto__', type: 'text' }], []).effectivePath, ['__proto__']);
});

test('U07–08 冻结输入不变，输出多选数组不与输入共享', () => {
  const value = Object.freeze(['b', 'a']);
  const q = Object.freeze({ id: 'q', type: 'multiple_choice', options: Object.freeze([{ id: 'a' }, { id: 'b' }]) });
  const answers = Object.freeze([Object.freeze({ questionId: 'q', value })]);
  const result = resolveFinalPath(Object.freeze([q]), answers);
  assert.equal(result.valid, true);
  assert.deepEqual(result.answers, [{ questionId: 'q', value: ['b', 'a'] }]);
  result.answers[0].value.push('a');
  assert.deepEqual(value, ['b', 'a']);
});
