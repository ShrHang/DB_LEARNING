import { ApiError, request } from './api.js';
import { validateAnswer } from '/shared/answers.js';
import { getNextQuestion } from '/shared/rules.js';
import { resolveFinalPath } from '/shared/path.js';

const $ = selector => document.querySelector(selector);
const slug = location.pathname.match(/^\/survey\/([^/]+)\/?$/)?.[1];
const endpoint = slug ? `/fill/${slug}` : null;
const cache = new Map();
// Raw numeric input is retained separately so incomplete input survives navigation.
const numberDrafts = new Map();
let survey = null;
let expectedUserId = null;
let originalUsername = '';
let visits = [];
let cursor = 0;
let reviewing = false;
let finalResult = null;
let anonymousChoice = '';
let pending = null;
let busy = false;
let authRequired = false;
let needsReload = false;
let succeeded = false;
let touched = false;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function currentQuestion() {
  return survey?.questions.find(question => question.id === visits[cursor]);
}
function clearError() {
  $('#fill-error').hidden = true;
  $('#fill-error').replaceChildren();
  $('#fill-answer-error').hidden = true;
  $('#fill-answer').removeAttribute('aria-invalid');
  $('#fill-anonymous').removeAttribute('aria-invalid');
}
function questionForError(detail) {
  const id = detail?.questionId;
  if (id) return survey?.questions.find(question => question.id === id);
  const field = detail?.field || '';
  const byId = survey?.questions.find(question => field === `answers.${question.id}` || field.startsWith(`answers.${question.id}.`));
  if (byId) return byId;
  const index = /^answers\.(\d+)(?:\.|$)/.exec(field)?.[1];
  const answer = index === undefined ? null : pending?.body.answers[Number(index)];
  return survey?.questions.find(question => question.id === answer?.questionId);
}
function showError(message, details = []) {
  const box = $('#fill-error');
  box.replaceChildren(el('p', message));
  if (details.length) {
    const list = el('ul');
    for (const detail of details) {
      const item = el('li');
      const question = questionForError(detail);
      if (question) {
        const index = survey.questions.indexOf(question);
        const link = el('a', `第 ${index + 1} 题：${detail.message || '请检查答案。'}`);
        link.href = '#fill-question';
        link.addEventListener('click', event => {
          event.preventDefault();
          if (pending || busy || authRequired) return;
          goToQuestion(question.id);
          showAnswerError(detail.message || '请检查答案。');
        });
        item.append(link);
      } else item.textContent = detail.message || '请检查填写内容。';
      list.append(item);
    }
    box.append(list);
  }
  box.hidden = false;
  box.focus();
}
function showAnswerError(message) {
  $('#fill-answer-error').textContent = message;
  $('#fill-answer-error').hidden = false;
  $('#fill-answer').setAttribute('aria-invalid', 'true');
  $('#fill-answer').querySelector('input, textarea')?.focus();
}
function updateControls() {
  const locked = busy || authRequired || Boolean(pending) || succeeded;
  $('#fill-question-fields').disabled = locked;
  $('#fill-login-fields').disabled = busy;
  $('#fill-anonymous-fields').disabled = locked;
  $('#fill-previous').disabled = locked || cursor === 0;
  $('#fill-back').disabled = locked;
  $('#fill-submit').hidden = Boolean(pending);
  $('#fill-submit').disabled = locked || needsReload || !finalResult?.valid;
  $('#fill-retry-submission').disabled = busy || authRequired;
  $('#fill-review-list').querySelectorAll('button').forEach(button => { button.disabled = locked; });
  $('#fill-pending').hidden = !pending;
  $('#fill-reload').hidden = !needsReload || Boolean(pending) || succeeded;
  $('#fill-reload').disabled = busy || authRequired;
  $('#fill-load-retry').disabled = busy;
  $('#fill-auth').hidden = !authRequired;
  $('#fill-question').setAttribute('aria-busy', String(busy));
  $('#fill-review').setAttribute('aria-busy', String(busy));
}
function requireLogin() {
  authRequired = true;
  $('#fill-auth-title').textContent = expectedUserId ? '恢复原账号登录' : '登录后填写';
  $('#fill-auth-note').textContent = expectedUserId
    ? `请使用最初填写的账号${originalUsername ? `「${originalUsername}」` : ''}登录。答案、导航和待确认的提交均已保留。`
    : '请在本页登录后继续；注册会在新标签页打开。';
  if (originalUsername && !$('#fill-username').value) $('#fill-username').value = originalUsername;
  updateControls();
  $('#fill-username').focus();
}
async function checkIdentity() {
  const data = await request('/auth/me');
  if (typeof data?.user?.id !== 'string' || !data.user.id) {
    throw new ApiError(200, 'INVALID_RESPONSE', '无法确认当前登录账号，请重试。');
  }
  if (expectedUserId && data.user.id !== expectedUserId) {
    throw new ApiError(409, 'ACCOUNT_CHANGED', '当前账号已变化，请恢复最初填写的账号。');
  }
  if (!expectedUserId) {
    expectedUserId = data.user.id;
    originalUsername = data.user.username || '';
  }
  $('#fill-account').textContent = originalUsername ? `填写账号：${originalUsername}` : '已登录';
  return data;
}
function constraintsText(question) {
  const validation = question.validation || {};
  const parts = [question.required ? '必答' : '可选，可留空'];
  const between = (min, max, unit) => {
    if (min !== undefined && min !== null) parts.push(`至少 ${min}${unit}`);
    if (max !== undefined && max !== null) parts.push(`至多 ${max}${unit}`);
  };
  if (question.type === 'multiple_choice') between(validation.minSelections, validation.maxSelections, ' 项');
  if (question.type === 'text') between(validation.minLength, validation.maxLength, ' 个字符');
  if (question.type === 'number') {
    if (validation.integer) parts.push('仅接受整数');
    if (validation.min !== undefined && validation.min !== null) parts.push(`不小于 ${validation.min}`);
    if (validation.max !== undefined && validation.max !== null) parts.push(`不大于 ${validation.max}`);
  }
  return parts.join('；');
}
function captureAnswer() {
  const question = currentQuestion();
  if (!question || reviewing) return;
  const container = $('#fill-answer');
  let value;
  if (question.type === 'single_choice') value = container.querySelector('input:checked')?.value ?? null;
  else if (question.type === 'multiple_choice') value = [...container.querySelectorAll('input:checked')].map(input => input.value);
  else if (question.type === 'number') {
    const input = container.querySelector('input');
    numberDrafts.set(question.id, input.value);
    // Accept complete decimal input, including exponents; never parse only a prefix.
    const raw = input.value.trim();
    value = raw === '' ? null : /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ? Number(raw) : NaN;
  } else value = container.querySelector('textarea').value;
  cache.set(question.id, value);
}
function renderQuestion(focus = true) {
  const question = currentQuestion();
  if (!question) return;
  reviewing = false;
  $('#fill-question').hidden = false;
  $('#fill-review').hidden = true;
  $('#fill-question-title').textContent = `第 ${survey.questions.indexOf(question) + 1} 题 · ${question.title}`;
  $('#fill-question-help').textContent = constraintsText(question);
  const answer = $('#fill-answer');
  answer.replaceChildren();
  answer.setAttribute('role', 'group');
  answer.setAttribute('aria-labelledby', 'fill-question-title');
  answer.setAttribute('aria-describedby', 'fill-question-help fill-answer-error');
  const value = cache.get(question.id);
  if (question.type === 'single_choice' || question.type === 'multiple_choice') {
    for (const option of question.options) {
      const label = el('label', undefined, 'fill-choice');
      const input = el('input');
      input.type = question.type === 'single_choice' ? 'radio' : 'checkbox';
      input.name = 'fill-choice';
      input.value = option.id;
      input.checked = question.type === 'single_choice' ? value === option.id : Array.isArray(value) && value.includes(option.id);
      label.append(input, el('span', option.label));
      answer.append(label);
    }
    if (question.type === 'single_choice' && !question.required) {
      const clear = el('button', '清空选择', 'secondary');
      clear.type = 'button';
      clear.addEventListener('click', () => {
        answer.querySelectorAll('input').forEach(input => { input.checked = false; });
        captureAnswer(); touched = true; clearError();
      });
      answer.append(clear);
    }
  } else {
    const input = el(question.type === 'text' ? 'textarea' : 'input');
    input.id = 'fill-answer-input';
    input.setAttribute('aria-labelledby', 'fill-question-title');
    input.setAttribute('aria-describedby', 'fill-question-help fill-answer-error');
    if (question.type === 'text') { input.rows = 5; input.value = value ?? ''; }
    else {
      // A text control also preserves incomplete numbers when going to the previous question.
      input.type = 'text';
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.value = numberDrafts.get(question.id) ?? (value === undefined || value === null ? '' : String(value));
    }
    answer.append(input);
  }
  updateControls();
  if (focus) $('#fill-question-title').focus();
}
function goToQuestion(id) {
  if (pending || busy || authRequired) return;
  captureAnswer();
  let index = visits.lastIndexOf(id, cursor);
  if (index < 0) {
    visits = visits.slice(0, cursor + 1);
    visits.push(id);
    index = visits.length - 1;
  }
  cursor = index;
  clearError();
  renderQuestion();
}
function recomputePath() {
  finalResult = resolveFinalPath(survey.questions, [...cache].map(([questionId, value]) => ({ questionId, value })), { rejectOutside: false });
  return finalResult;
}
function answerText(question, value) {
  if (value === null || value === undefined) return '（未填写）';
  if (question.type === 'single_choice') return question.options.find(option => option.id === value)?.label || '（未选择）';
  if (question.type === 'multiple_choice') return question.options.filter(option => value.includes(option.id)).map(option => option.label).join('、') || '（未选择）';
  return String(value);
}
function renderReview() {
  reviewing = true;
  $('#fill-question').hidden = true;
  $('#fill-review').hidden = false;
  const result = recomputePath();
  const list = $('#fill-review-list');
  list.replaceChildren();
  $('#fill-review-note').textContent = result.valid
    ? '这里只列出根据最终答案重新计算的有效题目。此前其他分支的答案保留在本页，提交时会排除。'
    : '最终答案尚不能形成完整结束路径，请按提示返回修改。';
  if (result.valid) {
    const answers = new Map(result.answers.map(answer => [answer.questionId, answer.value]));
    for (const id of result.effectivePath) {
      const question = survey.questions.find(item => item.id === id);
      const item = el('li');
      item.append(el('h3', `第 ${survey.questions.indexOf(question) + 1} 题 · ${question.title}`), el('p', answerText(question, answers.get(id))));
      const edit = el('button', '修改此题', 'secondary');
      edit.type = 'button';
      edit.addEventListener('click', () => goToQuestion(id));
      item.append(edit);
      list.append(item);
    }
  }
  const mode = survey.settings.anonymityMode;
  $('#fill-anonymous-choice').hidden = mode !== 'optional';
  $('#fill-anonymous').value = anonymousChoice;
  $('#fill-anonymous-note').textContent = mode === 'forced'
    ? '本问卷强制匿名。作者看不到你的账号身份。'
    : mode === 'forbidden' ? '本问卷以实名提交，作者可看到你的用户名。'
      : '请选择提交方式。匿名时作者看不到你的账号身份，实名时作者可看到你的用户名。';
  updateControls();
  if (!result.valid) showError(result.code === 'PATH_NOT_COMPLETE' ? '当前最终答案仍会循环，尚不能结束。请修改相关答案后再确认。' : '请先修正最终路径中的答案。', result.errors);
  else $('#fill-review-title').focus();
}
function nextQuestion() {
  if (busy || pending || authRequired || succeeded) return;
  clearError();
  captureAnswer();
  touched = true;
  const question = currentQuestion();
  const result = validateAnswer(question, cache.get(question.id));
  if (!result.valid) {
    showAnswerError(result.errors.map(error => error.message).join(' '));
    return;
  }
  cache.set(question.id, result.value);
  const target = getNextQuestion(survey.questions, question.id, result.value);
  visits = visits.slice(0, cursor + 1);
  if (target === 'END') { renderReview(); return; }
  visits.push(target);
  cursor += 1;
  renderQuestion();
}
function isUnknown(error) {
  return !error.status || error.status >= 500 || error.code === 'INVALID_RESPONSE' || (error.status >= 200 && error.status < 300);
}
const failureMessages = {
  DEFINITION_CHANGED: '题目已更新，当前答案不能提交。请重新载入并填写新版问卷。',
  SURVEY_NOT_OPEN: '问卷已关闭或已到截止时间，当前不能提交。',
  ALREADY_SUBMITTED: '此账号已经成功提交过，本问卷每个账号只允许提交一次。',
  IDEMPOTENCY_CONFLICT: '提交请求与服务器记录冲突，请联系问卷作者确认。',
  ANSWER_INVALID: '答案不符合要求，请按提示检查并修改。',
  VALIDATION_FAILED: '填写内容不符合要求，请按提示检查并修改。',
  PATH_NOT_COMPLETE: '当前最终答案仍会循环，尚不能结束，请返回修改。',
  ANSWER_OUTSIDE_PATH: '答卷包含最终路径之外的内容，请返回修改后再次确认。',
  INVALID_REQUEST: '提交内容不符合要求，请检查填写内容。',
  CSRF_INVALID: '会话验证未通过，请重试或恢复原账号登录。',
  NOT_FOUND: '问卷不存在或尚未开放填写。',
};
async function sendPending() {
  if (!pending || busy || authRequired || succeeded) return;
  busy = true;
  clearError();
  $('#fill-pending-note').textContent = '正在确认提交结果，请保持本页打开。';
  $('#fill-status').textContent = '正在提交，请稍候…';
  updateControls();
  try {
    await checkIdentity();
    pending.sent = true;
    const data = await request(`${endpoint}/submissions`, { method: 'POST', body: pending.body });
    if (typeof data?.submissionId !== 'string' || !data.submissionId || typeof data?.submittedAt !== 'string' || !Number.isFinite(Date.parse(data.submittedAt)) || typeof data?.replayed !== 'boolean') {
      throw new ApiError(200, 'INVALID_RESPONSE', '提交响应无法确认。');
    }
    succeeded = true;
    pending = null;
    $('#fill-review').hidden = true;
    $('#fill-auth').hidden = true;
    $('#fill-success').hidden = false;
    $('#fill-success-note').textContent = `${data.replayed ? '已确认此前的提交成功保存。' : '答卷已保存。'}提交时间：${new Date(data.submittedAt).toLocaleString('zh-CN')}。`;
    $('#fill-status').textContent = '提交成功。';
    clearError();
    $('#fill-success').focus();
  } catch (error) {
    if (error.status === 401 || error.code === 'ACCOUNT_CHANGED') {
      $('#fill-pending-note').textContent = '原提交已保留。恢复原账号后，请点击“重试确认提交结果”。';
      $('#fill-status').textContent = '请恢复原账号登录后继续。';
      requireLogin();
    } else if (isUnknown(error) || pending.uncertain) {
      pending.uncertain ||= pending.sent;
      $('#fill-pending-note').textContent = `${failureMessages[error.code] || ''} 原提交结果仍待确认，请重试确认。原提交和答案已锁定；确认前不能修改答案或发起新的提交。`;
      $('#fill-status').textContent = '尚未确认答卷是否保存。';
    } else {
      // Resolve field indices before releasing the original request body.
      const details = (error.details || []).map(detail => ({ ...detail, questionId: questionForError(detail)?.id }));
      pending = null;
      needsReload = error.code === 'DEFINITION_CHANGED';
      $('#fill-status').textContent = '本次提交未受理，答案已保留。';
      showError(failureMessages[error.code] || '提交未完成，请检查填写内容后重试。', details);
    }
  } finally { busy = false; updateControls(); }
}
function startSubmission() {
  if (busy || pending || authRequired || needsReload || succeeded) return;
  clearError();
  const result = recomputePath();
  if (!result.valid) { renderReview(); return; }
  const mode = survey.settings.anonymityMode;
  if (mode === 'optional' && !['true', 'false'].includes(anonymousChoice)) {
    showError('请先选择匿名或实名提交。');
    $('#fill-anonymous').setAttribute('aria-invalid', 'true');
    $('#fill-anonymous').focus();
    return;
  }
  // This snapshot is never edited or replaced during uncertain/authentication retries.
  pending = { body: JSON.parse(JSON.stringify({
    requestId: crypto.randomUUID(),
    expectedUserId,
    definitionRevision: survey.definitionRevision,
    anonymous: mode === 'forced' || (mode === 'optional' && anonymousChoice === 'true'),
    answers: result.answers,
  })) };
  void sendPending();
}
async function readDefinition() {
  const data = await request(endpoint);
  if (!Array.isArray(data?.questions) || !data.questions.length || !data.settings || !['forced', 'optional', 'forbidden'].includes(data.settings.anonymityMode)) {
    throw new ApiError(200, 'INVALID_RESPONSE', '问卷内容无法读取，请重试。');
  }
  survey = data;
  visits = [survey.questions[0].id];
  cursor = 0;
  $('#fill-title').textContent = survey.title;
  document.title = `${survey.title} · 填写问卷`;
  $('#fill-description').textContent = survey.description || '';
  $('#fill-description').hidden = !survey.description;
  $('#fill-policy').textContent = survey.settings.allowMultipleSubmissions ? '此问卷允许同一账号多次提交。' : '此问卷每个账号仅允许成功提交一次。';
  $('#fill-policy').hidden = false;
  $('#fill-deadline').textContent = survey.deadlineAt ? `截止时间：${new Date(survey.deadlineAt).toLocaleString('zh-CN')}（以服务器受理时为准）` : '不设截止时间。';
  $('#fill-deadline').hidden = false;
  $('#fill-load-retry').hidden = true;
  $('#fill-status').textContent = '请逐题填写；每次点击“下一题”只跳转一次。';
  renderQuestion(false);
}
function handleLoadError(error) {
  if (error.status === 401 || error.code === 'ACCOUNT_CHANGED') {
    requireLogin();
    $('#fill-status').textContent = '登录后在本页继续。';
  } else {
    $('#fill-title').textContent = '读取问卷';
    $('#fill-status').textContent = '尚未读取问卷。';
    $('#fill-load-retry').hidden = false;
    showError(failureMessages[error.code] || '暂时无法读取问卷，请稍后重试。');
  }
}
async function load() {
  if (busy) return;
  if (!endpoint) {
    $('#fill-title').textContent = '无法打开问卷';
    showError('问卷链接不完整，请使用作者提供的分享链接。');
    $('#fill-status').textContent = '';
    return;
  }
  busy = true;
  clearError();
  updateControls();
  try {
    await checkIdentity();
    authRequired = false;
    if (!survey) await readDefinition();
  } catch (error) { handleLoadError(error); }
  finally { busy = false; updateControls(); }
}
async function restoreLogin(login) {
  if (busy) return;
  let identityConfirmed = false;
  busy = true;
  $('#fill-login-error').hidden = true;
  updateControls();
  $('#fill-status').textContent = '正在确认登录账号…';
  try {
    if (login) {
      await request('/auth/login', { method: 'POST', body: { username: $('#fill-username').value, password: $('#fill-password').value } });
      $('#fill-password').value = '';
    }
    // Never adopt a replacement identity, even if POST login succeeded.
    await checkIdentity();
    identityConfirmed = true;
    authRequired = false;
    clearError();
    if (!survey) await readDefinition();
    $('#fill-status').textContent = pending ? '原账号已恢复，请重试确认原提交结果。' : '登录已确认，已保留填写进度。';
  } catch (error) {
    if (!identityConfirmed || error.status === 401 || error.code === 'ACCOUNT_CHANGED') {
      requireLogin();
      $('#fill-login-error').textContent = error.code === 'ACCOUNT_CHANGED' ? '登录的账号与最初填写账号不同，请登录原账号。' : error.code === 'INVALID_CREDENTIALS' ? '用户名或密码不正确，请重试。' : '未能确认原账号登录，请检查后重试。';
      $('#fill-login-error').hidden = false;
      $('#fill-status').textContent = '登录尚未恢复，请在本页重试。';
      $('#fill-login-error').focus();
    } else handleLoadError(error);
  } finally { busy = false; updateControls(); }
}
$('#fill-answer').addEventListener('input', () => { captureAnswer(); touched = true; clearError(); });
$('#fill-answer').addEventListener('change', () => { captureAnswer(); touched = true; clearError(); });
$('#fill-answer-form').addEventListener('submit', event => { event.preventDefault(); nextQuestion(); });
$('#fill-previous').addEventListener('click', () => {
  if (busy || pending || authRequired || cursor === 0) return;
  captureAnswer();
  cursor -= 1;
  clearError();
  renderQuestion();
});
$('#fill-back').addEventListener('click', () => {
  if (busy || pending || authRequired) return;
  clearError();
  renderQuestion();
});
$('#fill-anonymous').addEventListener('change', () => { anonymousChoice = $('#fill-anonymous').value; clearError(); touched = true; });
$('#fill-submit').addEventListener('click', startSubmission);
$('#fill-retry-submission').addEventListener('click', () => { void sendPending(); });
$('#fill-login-form').addEventListener('submit', event => { event.preventDefault(); void restoreLogin(true); });
$('#fill-check-session').addEventListener('click', () => { void restoreLogin(false); });
$('#fill-load-retry').addEventListener('click', () => { void load(); });
$('#fill-reload').addEventListener('click', () => {
  if (!pending && !busy && confirm('重新载入会清除当前填写进度，改为填写新版问卷。是否继续？')) location.reload();
});
window.addEventListener('beforeunload', event => {
  if (succeeded || (!touched && !pending)) return;
  event.preventDefault();
  event.returnValue = '';
});
void load();
