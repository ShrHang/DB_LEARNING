import test from 'node:test';
import assert from 'node:assert/strict';
import { questionContent, validateQuestionContent, fillingQuestion } from '../../src/shared/question-content.js';
import { validateDefinition } from '../../src/shared/definition.js';

test('独立版本内容与问卷局部配置分离，填写序列化去除引用且不修改原值', () => {
  const input = { id: 'q', type: 'number', title: '年龄', required: true, rules: [], validation: { min: 0 }, reference: { questionId: '1'.repeat(24), versionId: '2'.repeat(24) } };
  const before = structuredClone(input);
  assert.deepEqual(questionContent(input), { type: 'number', title: '年龄', validation: { min: 0 } });
  assert.equal(fillingQuestion(input).reference, undefined); assert.deepEqual(input, before);
  assert.equal(validateQuestionContent(questionContent(input)).valid, true);
  assert.equal(validateQuestionContent({ ...questionContent(input), required: true }).valid, false);
});
test('版本切换后的不兼容跳转可暂存，发布完整校验拒绝，恶意值仍拒绝', () => {
  const q = { id: 'q', type: 'number', title: '数值', validation: {}, reference: { questionId: '1'.repeat(24), versionId: '2'.repeat(24) }, rules: [{ condition: { operator: 'eq', value: 'old-option' }, target: 'END' }] };
  const definition = { title: '问卷', questions: [q] };
  assert.equal(validateDefinition(definition).valid, true);
  assert.equal(validateDefinition(definition, { complete: true }).valid, false);
  q.rules[0].condition.value = { injected: true }; assert.equal(validateDefinition(definition).valid, false);
});
