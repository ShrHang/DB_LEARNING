import { request } from './api.js';

const $ = selector => document.querySelector(selector);
const form = $('#editor-form');
const fields = $('#editor-fields');
const errorBox = $('#editor-error');
const message = $('#editor-status');
const saveState = $('#save-state');
const questionList = $('#question-list');
const idFromUrl = new URLSearchParams(location.search).get('id');
let survey = null;
let questions = [];
let dirty = false;
let busy = false;
let ready = !idFromUrl;
let controlId = 0;
const types = [['single_choice', '单选题'], ['multiple_choice', '多选题'], ['text', '文本题'], ['number', '数字题']];
const statusNames = { draft: '草稿', published: '已发布', closed: '已关闭' };
const numberOperators = [['eq', '等于'], ['ne', '不等于'], ['gt', '大于'], ['gte', '大于等于'], ['lt', '小于'], ['lte', '小于等于'], ['between', '区间内（含边界）']];
const choiceOperators = [['eq', '选中'], ['ne', '未选中']];
const multipleOperators = [['contains_any', '包含任意一项'], ['contains_all', '包含全部所选项'], ['equals_set', '恰好为所选集合']];

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, disabled = false) {
  const node = el('button', text, 'secondary');
  node.type = 'button';
  node.disabled = disabled;
  node.addEventListener('click', action);
  return node;
}
function field(labelText, input, path) {
  const wrapper = el('div', undefined, 'field');
  input.id = `editor-control-${++controlId}`;
  if (path) input.dataset.field = path;
  const label = el('label', labelText);
  label.htmlFor = input.id;
  wrapper.append(label, input);
  return wrapper;
}
function textInput(value, onInput, multiline = false) {
  const input = el(multiline ? 'textarea' : 'input');
  if (multiline) input.rows = 2;
  else input.type = 'text';
  input.value = value ?? '';
  input.addEventListener('input', () => { onInput(input.value); changed(); });
  return input;
}
function numberInput(value, onInput, integer = false) {
  const input = el('input');
  input.type = 'number';
  input.step = integer ? '1' : 'any';
  if (integer) input.min = '0';
  input.value = value ?? '';
  input.addEventListener('input', () => {
    onInput(input.value === '' ? undefined : input.valueAsNumber);
    changed();
  });
  return input;
}
function selectInput(choices, value, onChange, missingLabel = '缺失引用') {
  const select = el('select');
  for (const [key, text] of choices) {
    const option = el('option', text);
    option.value = key;
    select.append(option);
  }
  const selected = value ?? '';
  if (!choices.some(([key]) => key === selected)) {
    const option = el('option', `${missingLabel}（${selected}）`);
    option.value = selected;
    select.append(option);
  }
  select.value = selected;
  select.addEventListener('change', () => { onChange(select.value); changed(); });
  return select;
}
function checkbox(labelText, checked, onChange, path) {
  const label = el('label', undefined, 'check-label');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  if (path) input.dataset.field = path;
  input.addEventListener('change', () => { onChange(input.checked); changed(); });
  label.append(input, document.createTextNode(labelText));
  return label;
}
function changed() {
  dirty = true;
  saveState.textContent = survey ? '有未保存的修改' : '配置尚未创建';
  saveState.classList.add('unsaved');
}
function clearErrors() {
  errorBox.hidden = true;
  errorBox.replaceChildren();
  document.querySelectorAll('[aria-invalid="true"]').forEach(node => node.removeAttribute('aria-invalid'));
  document.querySelectorAll('.server-field-error').forEach(node => node.remove());
}
function fieldNode(path) {
  let current = String(path).replace(/\[(\d+)\]/g, '.$1');
  while (current) {
    const node = [...document.querySelectorAll('[data-field]')].find(item => item.dataset.field === current);
    if (node) return node;
    current = current.includes('.') ? current.slice(0, current.lastIndexOf('.')) : '';
  }
  return null;
}
function showError(error) {
  clearErrors();
  let text = error.message || '操作未完成，请重试。';
  if (error.status === 401) text += ' 当前输入已保留。请在新标签页登录原账号，然后回到本页重试。';
  if (error.status === 409) text += ' 当前输入已保留。可先复制需要保留的内容，再点击“重新加载服务器版本”；重新加载会丢弃未保存输入。';
  if (error.status === 0 || error.code === 'INVALID_RESPONSE' || error.status >= 500) {
    text += ' 尚未确认服务器是否已保存。当前输入已保留；已有问卷可重新加载核对，新建草稿请先到列表核对，避免重复创建。';
  }
  errorBox.append(el('p', text));
  const details = Array.isArray(error.details) ? error.details : [];
  if (details.length) {
    const list = el('ul');
    for (const detail of details) {
      const item = el('li');
      const node = fieldNode(detail.field || '');
      const label = `${detail.field || '问卷'}：${detail.message || '请检查此字段'}`;
      if (node) {
        node.setAttribute('aria-invalid', 'true');
        const link = el('a', label);
        link.href = '#';
        link.addEventListener('click', event => {
          event.preventDefault();
          node.scrollIntoView({ block: 'center', behavior: 'smooth' });
          const target = node.matches('input,textarea,select,button') ? node : node.querySelector('input,textarea,select,button');
          target?.focus();
        });
        item.append(link);
        const inline = el('p', detail.message || '请检查此字段', 'field-error server-field-error');
        node.insertAdjacentElement('afterend', inline);
      } else item.textContent = label;
      list.append(item);
    }
    errorBox.append(list);
  }
  errorBox.hidden = false;
  errorBox.focus();
}
function localDate(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function updateControls() {
  fields.disabled = busy || !ready;
  $('#reload-button').disabled = busy;
  $('#policy-fields').disabled = Boolean(survey?.firstPublishedAt);
  $('#question-fields').disabled = Boolean(survey?.contentLocked);
  $('#save-button').textContent = busy ? '正在处理…' : survey ? '保存修改' : '创建草稿';
}
function displayStatus() {
  if (!survey) return;
  const expired = survey.deadlineAt && new Date(survey.deadlineAt).getTime() <= Date.now();
  $('#survey-status').textContent = `${statusNames[survey.status] || survey.status}${expired ? ' · 已到期' : ''}`;
  $('#survey-status').className = `badge ${Object.hasOwn(statusNames, survey.status) ? survey.status : ''}`;
}
function applySurvey(data) {
  survey = data;
  questions = structuredClone(data.questions || []);
  ready = true;
  dirty = false;
  document.title = `${data.title || '未命名问卷'} · 编辑问卷`;
  $('#editor-heading').textContent = '编辑问卷';
  $('#survey-title').value = data.title;
  $('#survey-description').value = data.description;
  $('#anonymity-mode').value = data.settings.anonymityMode;
  $('#allow-multiple').checked = data.settings.allowMultipleSubmissions;
  $('#survey-deadline').value = localDate(data.deadlineAt);
  $('#deadline-field').hidden = false;
  $('#questions-section').hidden = false;
  $('#lifecycle-actions').hidden = false;
  $('#reload-button').hidden = false;
  $('#publish-button').hidden = data.status !== 'draft';
  $('#close-button').hidden = data.status !== 'published';
  $('#reopen-button').hidden = data.status !== 'closed';
  $('#policy-note').textContent = data.firstPublishedAt ? '已首次发布：匿名及重复提交策略永久冻结。' : '首次发布后永久冻结，请在发布前确认。';
  $('#content-note').textContent = data.contentLocked
    ? '已收到首份答卷：题目、选项、校验、顺序及跳转规则已永久冻结。标题、说明和截止时间仍可修改。'
    : '收到首份答卷后题目定义永久冻结。规则按顺序匹配，首条命中即跳转；未命中时进入下一题，最后一题默认结束。空答不匹配规则，允许回跳、自跳及循环。';
  $('#share-section').hidden = !data.firstPublishedAt;
  if (data.firstPublishedAt) $('#share-url').value = new URL(`/survey/${encodeURIComponent(data.slug)}`, location.origin).href;
  $('#copy-status').textContent = '';
  saveState.textContent = '已保存';
  saveState.classList.remove('unsaved');
  displayStatus();
  renderQuestions();
  updateControls();
}
function move(items, index, offset) {
  [items[index], items[index + offset]] = [items[index + offset], items[index]];
  changed();
  renderQuestions();
}
function reorderTools(items, index, noun, onDelete) {
  const tools = el('div', undefined, 'toolbar reorder-tools');
  tools.append(
    button(`上移${noun}`, () => move(items, index, -1), index === 0),
    button(`下移${noun}`, () => move(items, index, 1), index === items.length - 1),
    button(`删除${noun}`, () => { onDelete(); changed(); renderQuestions(); }),
  );
  return tools;
}
function refreshReferenceLabels() {
  document.querySelectorAll('select[data-reference="target"]').forEach(select => {
    for (const option of select.options) {
      const index = questions.findIndex(q => q.id === option.value);
      if (index >= 0) option.textContent = `第 ${index + 1} 题 · ${questions[index].title || '未命名题目'}`;
    }
  });
  document.querySelectorAll('[data-option-reference]').forEach(node => {
    const q = questions.find(item => item.id === node.dataset.questionId);
    const option = q?.options?.find(item => item.id === node.dataset.optionReference);
    if (option) node.textContent = option.label || '未命名选项';
  });
}
function renderOptions(question, qi, container) {
  const options = question.options ??= [];
  const section = el('div', undefined, 'editor-subsection');
  section.append(el('h3', '选项'));
  const rows = el('div');
  rows.dataset.field = `questions.${qi}.options`;
  options.forEach((option, oi) => {
    const row = el('div', undefined, 'option-row');
    row.dataset.field = `questions.${qi}.options.${oi}`;
    row.append(field(`选项 ${oi + 1}`, textInput(option.label, value => { option.label = value; refreshReferenceLabels(); }), `questions.${qi}.options.${oi}.label`));
    row.append(reorderTools(options, oi, '选项', () => options.splice(oi, 1)));
    rows.append(row);
  });
  section.append(rows, button('添加选项', () => {
    options.push({ id: crypto.randomUUID(), label: '' });
    changed(); renderQuestions();
  }));
  section.append(el('p', '删除选项不会自动修改已有规则，缺失的引用会保留并提示。', 'hint'));
  container.append(section);
}
function renderValidation(question, qi, container) {
  const constraints = question.validation ??= {};
  const section = el('div', undefined, 'editor-subsection');
  section.dataset.field = `questions.${qi}.validation`;
  section.append(el('h3', '答案限制（留空表示不限制）'));
  const grid = el('div', undefined, 'form-grid');
  const settings = question.type === 'multiple_choice' ? [['minSelections', '至少选择项数'], ['maxSelections', '最多选择项数']]
    : question.type === 'text' ? [['minLength', '最少字符数'], ['maxLength', '最多字符数']]
      : question.type === 'number' ? [['min', '最小值'], ['max', '最大值']] : [];
  settings.forEach(([key, label]) => {
    grid.append(field(label, numberInput(constraints[key], value => {
      if (value === undefined) delete constraints[key];
      else constraints[key] = value;
    }, question.type !== 'number'), `questions.${qi}.validation.${key}`));
  });
  section.append(grid);
  if (question.type === 'number') section.append(checkbox('仅接受安全整数', constraints.integer, value => { constraints.integer = value; }, `questions.${qi}.validation.integer`));
  if (question.type === 'text') section.append(el('p', '字符长度按 Unicode 码点计算。', 'hint'));
  if (settings.length) container.append(section);
}
function optionChoices(question) {
  return (question.options || []).map(option => [option.id, option.label || '未命名选项']);
}
function renderCondition(question, rule, path, container) {
  const condition = rule.condition ??= {};
  const operators = question.type === 'number' ? numberOperators : question.type === 'multiple_choice' ? multipleOperators : choiceOperators;
  container.append(field('条件', selectInput([['', '请选择条件'], ...operators], condition.operator, value => {
    const wasBetween = condition.operator === 'between';
    if (value) condition.operator = value;
    else delete condition.operator;
    if (question.type === 'number' && wasBetween !== (value === 'between')) delete condition.value;
    renderQuestions();
  }, '不适用于当前题型的条件'), `${path}.condition.operator`));
  if (question.type === 'single_choice') {
    const input = selectInput([['', '请选择选项'], ...optionChoices(question)], condition.value, value => {
      if (value) condition.value = value;
      else delete condition.value;
    }, '缺失选项');
    for (const option of input.options) {
      option.dataset.optionReference = option.value;
      option.dataset.questionId = question.id;
    }
    container.append(field('比较选项', input, `${path}.condition.value`));
    if (condition.value && !question.options?.some(option => option.id === condition.value)) container.append(el('p', '引用的选项已缺失，请明确选择替代项；保存前仍保留原引用。', 'field-error'));
  } else if (question.type === 'multiple_choice') {
    const values = Array.isArray(condition.value) ? condition.value : [];
    const group = el('fieldset', undefined, 'condition-options');
    group.dataset.field = `${path}.condition.value`;
    group.append(el('legend', '比较选项（可多选）'));
    const missing = values.filter(id => !question.options?.some(option => option.id === id));
    for (const [id, labelText] of [...optionChoices(question), ...missing.map(id => [id, `缺失选项（${id}）`])]) {
      const label = checkbox('', values.includes(id), checked => {
        const selected = Array.isArray(condition.value) ? condition.value : [];
        const next = checked ? [...selected, id] : selected.filter(value => value !== id);
        if (next.length) condition.value = next;
        else delete condition.value;
      });
      const text = el('span', labelText);
      text.dataset.optionReference = id;
      text.dataset.questionId = question.id;
      label.append(text);
      group.append(label);
    }
    if (!question.options?.length && !missing.length) group.append(el('p', '请先添加选项。', 'hint'));
    if (missing.length) group.append(el('p', '勾选的缺失选项仍保留原引用；取消勾选后才会移除。', 'field-error'));
    container.append(group);
  } else if (question.type === 'number') {
    if (condition.operator === 'between') {
      const values = Array.isArray(condition.value) ? condition.value : [null, null];
      const grid = el('div', undefined, 'form-grid');
      ['区间下限', '区间上限'].forEach((label, index) => grid.append(field(label, numberInput(values[index], value => {
        if (!Array.isArray(condition.value)) condition.value = [null, null];
        condition.value[index] = value ?? null;
      }), `${path}.condition.value.${index}`)));
      container.append(grid);
    } else container.append(field('比较数值', numberInput(condition.value, value => {
      if (value === undefined) delete condition.value;
      else condition.value = value;
    }), `${path}.condition.value`));
  }
}
function renderRules(question, qi, container) {
  const rules = question.rules ??= [];
  const section = el('div', undefined, 'editor-subsection');
  section.dataset.field = `questions.${qi}.rules`;
  section.append(el('h3', '有序跳转规则'));
  if (question.type === 'text') {
    section.append(el('p', '文本题按顺序进入下一题，不配置条件规则。', 'hint'));
    container.append(section);
    return;
  }
  rules.forEach((rule, ri) => {
    const path = `questions.${qi}.rules.${ri}`;
    const card = el('div', undefined, 'rule-card');
    card.dataset.field = path;
    const heading = el('div', undefined, 'item-heading');
    heading.append(el('h4', `规则 ${ri + 1}`), reorderTools(rules, ri, '规则', () => rules.splice(ri, 1)));
    card.append(heading);
    renderCondition(question, rule, path, card);
    const choices = [['', '未选择目标（草稿可暂存）'], ...questions.map((q, index) => [q.id, `第 ${index + 1} 题 · ${q.title || '未命名题目'}`]), ['END', '结束问卷（END）']];
    const target = selectInput(choices, rule.target, value => { rule.target = value || null; }, '缺失题目');
    target.dataset.reference = 'target';
    card.append(field('跳转目标', target, `${path}.target`));
    if (rule.target && rule.target !== 'END' && !questions.some(q => q.id === rule.target)) card.append(el('p', '引用的题目已缺失，请明确选择替代目标；保存前仍保留原引用。', 'field-error'));
    section.append(card);
  });
  section.append(button('添加跳转规则', () => {
    rules.push({ condition: { operator: question.type === 'multiple_choice' ? 'contains_any' : 'eq' }, target: null });
    changed(); renderQuestions();
  }));
  container.append(section);
}
function renderQuestions() {
  controlId = 0;
  const cards = questions.map((question, qi) => {
    const card = el('section', undefined, 'question-card');
    card.dataset.field = `questions.${qi}`;
    const header = el('div', undefined, 'item-heading');
    header.append(el('h3', `第 ${qi + 1} 题`), reorderTools(questions, qi, '题目', () => {
      if (confirm('删除这道题？指向它的规则将保留原引用，并显示缺失提示。')) questions.splice(qi, 1);
    }));
    card.append(header);
    card.append(field('题型', selectInput(types, question.type, type => {
      const hasConfiguration = question.options?.length || question.rules?.length || Object.keys(question.validation || {}).length;
      if (hasConfiguration && !confirm('更换题型将清空这道题的选项、答案限制和跳转规则，是否继续？')) { renderQuestions(); return; }
      question.type = type;
      question.validation = {};
      question.rules = [];
      delete question.options;
      if (type === 'single_choice' || type === 'multiple_choice') question.options = [];
      renderQuestions();
    }), `questions.${qi}.type`));
    card.append(field('题干', textInput(question.title, value => { question.title = value; refreshReferenceLabels(); }, true), `questions.${qi}.title`));
    card.append(checkbox('必答题', question.required, value => { question.required = value; }, `questions.${qi}.required`));
    if (question.type === 'single_choice' || question.type === 'multiple_choice') renderOptions(question, qi, card);
    renderValidation(question, qi, card);
    renderRules(question, qi, card);
    return card;
  });
  questionList.replaceChildren(...cards);
  if (!cards.length) questionList.append(el('p', '尚无题目，可先保存草稿。发布前请添加完整题目。', 'empty-questions'));
}
function patchBody() {
  const body = { revision: survey.revision };
  for (const [key, selector] of [['title', '#survey-title'], ['description', '#survey-description']]) {
    if ($(selector).value !== survey[key]) body[key] = $(selector).value;
  }
  // Retain server precision when a displayed local date was not changed.
  const local = $('#survey-deadline').value;
  const initial = localDate(survey.deadlineAt);
  if ((local ? localDate(new Date(local).toISOString()) : '') !== initial) body.deadlineAt = local ? new Date(local).toISOString() : null;
  if (!survey.firstPublishedAt) {
    const settings = { anonymityMode: $('#anonymity-mode').value, allowMultipleSubmissions: $('#allow-multiple').checked };
    if (settings.anonymityMode !== survey.settings.anonymityMode || settings.allowMultipleSubmissions !== survey.settings.allowMultipleSubmissions) body.settings = settings;
  }
  if (!survey.contentLocked && JSON.stringify(questions) !== JSON.stringify(survey.questions)) body.questions = questions;
  return body;
}
async function saveInternal() {
  if (!survey) {
    const data = await request('/surveys', { method: 'POST', body: {
      title: $('#survey-title').value,
      description: $('#survey-description').value,
      settings: { anonymityMode: $('#anonymity-mode').value, allowMultipleSubmissions: $('#allow-multiple').checked },
    } });
    applySurvey(data);
    history.replaceState(null, '', `/editor.html?id=${encodeURIComponent(data.id)}`);
    return;
  }
  const body = patchBody();
  if (Object.keys(body).length > 1) applySurvey(await request(`/surveys/${encodeURIComponent(survey.id)}`, { method: 'PATCH', body }));
  else {
    dirty = false;
    saveState.textContent = '已保存（无内容变化）';
    saveState.classList.remove('unsaved');
  }
}
async function perform(action) {
  if (busy || !ready) return;
  clearErrors();
  if (!form.reportValidity()) return;
  busy = true;
  updateControls();
  message.textContent = '正在保存当前编辑…';
  try {
    await saveInternal();
    if (action) {
      if (action === 'reopen' && survey.deadlineAt && new Date(survey.deadlineAt).getTime() <= Date.now()) {
        throw { message: '重开前请将截止时间改为未来时间或留空。当前修改已保存。', details: [{ field: 'deadlineAt', message: '请设置未来时间或留空，再重开。' }] };
      }
      applySurvey(await request(`/surveys/${encodeURIComponent(survey.id)}/${action}`, { method: 'POST', body: { revision: survey.revision } }));
    }
    message.textContent = action ? ({ publish: '发布成功。填写策略已冻结，可分享链接供填写。', close: '问卷已关闭。', reopen: '问卷已重开，可通过分享链接填写。' })[action] : '保存成功。';
  } catch (error) {
    message.textContent = '操作未完成，请查看提示后重试。';
    showError(error);
  } finally { busy = false; updateControls(); }
}
async function reload() {
  if (busy) return;
  if (dirty && !confirm('重新加载会丢弃本页所有未保存输入，是否继续？')) return;
  const id = survey?.id || idFromUrl;
  if (!id) return;
  busy = true;
  updateControls();
  clearErrors();
  message.textContent = '正在读取服务器版本…';
  try {
    applySurvey(await request(`/surveys/${encodeURIComponent(id)}`));
    message.textContent = '已加载服务器版本。修改后请手动保存。';
  } catch (error) {
    $('#reload-button').hidden = false;
    message.textContent = '读取未完成，可点击“重新加载服务器版本”重试。';
    showError(error);
  } finally { busy = false; updateControls(); }
}
for (const selector of ['#survey-title', '#survey-description', '#anonymity-mode', '#allow-multiple', '#survey-deadline']) $(selector).addEventListener('input', changed);
$('#add-question').addEventListener('click', () => {
  questions.push({ id: crypto.randomUUID(), type: 'single_choice', title: '', required: false, options: [], validation: {}, rules: [] });
  changed(); renderQuestions();
  questionList.lastElementChild?.querySelector('textarea')?.focus();
});
form.addEventListener('submit', event => { event.preventDefault(); void perform(); });
for (const action of ['publish', 'close', 'reopen']) $(`#${action}-button`).addEventListener('click', () => { void perform(action); });
$('#reload-button').addEventListener('click', () => { void reload(); });
$('#copy-share').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#share-url').value);
    $('#copy-status').textContent = '链接已复制。问卷开放期间可登录填写。';
  } catch {
    $('#share-url').focus(); $('#share-url').select();
    $('#copy-status').textContent = '无法自动复制，请复制已选中的链接。';
  }
});
window.addEventListener('beforeunload', event => {
  if (!dirty && !busy) return;
  event.preventDefault();
  event.returnValue = '';
});
window.addEventListener('focus', displayStatus);
$('#share-section .hint').textContent = '分享此链接供填写者登录填写；草稿、已关闭或已到截止时间的问卷不开放填写。';
if (idFromUrl) void reload();
else updateControls();
