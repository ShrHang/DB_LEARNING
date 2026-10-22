import { randomUUID } from 'node:crypto';

export function surveyDefinition() {
  const [single, multi, text, number, a, b, x, y] = Array.from({ length: 8 }, () => randomUUID());
  return {
    title: '四题型问卷', description: '管理测试',
    questions: [
      { id: single, type: 'single_choice', title: '选择一项', required: true, options: [{ id: a, label: 'A' }, { id: b, label: 'B' }], validation: {}, rules: [{ condition: { operator: 'eq', value: a }, target: number }] },
      { id: multi, type: 'multiple_choice', title: '选择多项', required: false, options: [{ id: x, label: 'X' }, { id: y, label: 'Y' }], validation: { minSelections: 1, maxSelections: 2 }, rules: [{ condition: { operator: 'contains_all', value: [x, y] }, target: 'END' }] },
      { id: text, type: 'text', title: '留言', required: false, validation: { minLength: 1, maxLength: 200 }, rules: [] },
      { id: number, type: 'number', title: '数字', required: false, validation: { min: 0, max: 100, integer: true }, rules: [{ condition: { operator: 'between', value: [0, 10] }, target: single }, { condition: { operator: 'gt', value: 10 }, target: 'END' }] }
    ]
  };
}
