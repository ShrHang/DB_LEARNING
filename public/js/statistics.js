import { request } from './api.js';

const $ = selector => document.querySelector(selector);
const types = { single_choice: '单选题', multiple_choice: '多选题', text: '文本题', number: '数字题' };
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2, useGrouping: false });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const stale = Symbol('stale request');
let epoch = 0;
let surveyId = null;
let userId = null;
let statistics = null;
let selectedQuestion = null;
let expiryTimer;
let suspended = false;
let loginBusy = false;
const versions = { question: 0, answers: 0, submissions: 0, detail: 0 };
const retries = {};
const paging = { answers: freshPage(), submissions: freshPage() };

function freshPage() { return { page: 0, cursors: [null], nextCursor: null, busy: false }; }
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? numberFormat.format(value) : '暂无数据';
}
function formatPercentage(value) {
  return value === null || value === undefined ? '暂无数据' : `${formatNumber(value)}%`;
}
function dateLabel(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? dateFormat.format(date) : '时间未知';
}
function respondentLabel(item) {
  if (item.anonymous) return '匿名';
  return typeof item.respondent?.username === 'string' ? `实名：${item.respondent.username}` : '实名：用户名暂无数据';
}
function clearError(scope) {
  $(`#${scope}-error`).hidden = true;
  $(`#${scope}-error-text`).textContent = '';
  delete retries[scope];
}
function errorLabel(error) {
  if (error.status === 404) return '问卷或明细不存在，或当前账号无权查看。请确认账号后重试。';
  if (error.status === 503) return '服务暂时不可用，请稍后重试。';
  if (error.status === 0) return '无法连接服务器，请检查网络后重试。';
  if (error.status === 400) return '分页位置或请求已失效，请刷新统计后重试。';
  return '读取未完成，请稍后重试；也可以刷新统计重新加载。';
}
function showError(scope, error, retry) {
  $(`#${scope}-error-text`).textContent = errorLabel(error);
  $(`#${scope}-error`).hidden = false;
  retries[scope] = retry;
  if (scope === 'page') $('#page-retry').hidden = !retry;
}
function updatePagination(kind) {
  const state = paging[kind];
  $(`#${kind}-previous`).disabled = state.busy || state.page === 0;
  $(`#${kind}-next`).disabled = state.busy || !state.nextCursor;
  $(`#${kind}-page`).textContent = `第 ${state.page + 1} 页`;
  $(`#${kind}-list`).setAttribute('aria-busy', String(state.busy));
}

// Invalidate every pending read before removing any sensitive DOM or in-memory data.
function clearSensitive() {
  epoch++;
  clearTimeout(expiryTimer);
  userId = null;
  statistics = null;
  selectedQuestion = null;
  $('#main').setAttribute('aria-busy', 'false');
  $('#refresh-button').disabled = false;
  $('#statistics-content').hidden = true;
  $('#account-name').textContent = '';
  $('#edit-link').hidden = true;
  $('#edit-link').removeAttribute('href');
  document.title = '统计与答卷 · 问卷系统';
  for (const id of ['survey-title', 'survey-description', 'total-submissions', 'question-overview', 'question-select', 'question-statistics', 'answers-list', 'submissions-list', 'detail-content']) {
    $(`#${id}`).replaceChildren();
  }
  $('#question-select').disabled = true;
  $('#detail-panel').hidden = true;
  $('#login-password').value = '';
  for (const scope of ['page', 'question', 'answers', 'submissions', 'detail']) {
    clearError(scope);
    if (scope !== 'page') $(`#${scope}-status`).textContent = '';
  }
  for (const kind of ['answers', 'submissions']) {
    paging[kind] = freshPage();
    $(`#${kind}-pagination`).hidden = true;
    updatePagination(kind);
  }
  $('#question-statistics').setAttribute('aria-busy', 'false');
  $('#detail-content').setAttribute('aria-busy', 'false');
  return epoch;
}
function requireLogin(message = '登录已失效，请重新登录。登录后会重新检查原问卷的作者权限。') {
  clearSensitive();
  suspended = false;
  $('#login-panel').hidden = false;
  $('#login-notice').textContent = message;
  $('#login-error').hidden = true;
  $('#page-status').textContent = '请在本页登录后继续。';
  $('#main').setAttribute('aria-busy', 'false');
}
function handleFailure(scope, error, retry) {
  if (error === stale) return;
  if (error.status === 401) { requireLogin(); return; }
  if (error.status === 403) {
    requireLogin('当前会话无法读取此资源，请重新登录后重试。登录后会重新检查作者权限。');
    return;
  }
  if (error.status === 404) {
    clearSensitive();
    $('#page-status').textContent = '无法读取当前资源。';
    showError('page', error, reloadSurvey);
    return;
  }
  showError(scope, error, retry);
}
function identity(data) {
  if (typeof data?.user?.id !== 'string' || !data.user.id) throw new Error('Invalid session response');
  return data.user.id;
}
function armExpiry(expiresAt) {
  clearTimeout(expiryTimer);
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remaining)) return;
  const currentEpoch = epoch;
  expiryTimer = setTimeout(() => {
    if (epoch !== currentEpoch) return;
    if (remaining > 2147483647) armExpiry(expiresAt);
    else requireLogin();
  }, Math.min(2147483647, Math.max(0, remaining)));
}
function ticket(scope) {
  const currentEpoch = epoch;
  const version = ++versions[scope];
  return () => epoch === currentEpoch && versions[scope] === version;
}
async function confirmIdentity(isCurrent) {
  const session = await request('/auth/me');
  if (!isCurrent()) throw stale;
  if (identity(session) !== userId) {
    void reloadSurvey();
    throw stale;
  }
  return session;
}
async function protectedRead(path, isCurrent) {
  await confirmIdentity(isCurrent);
  const data = await request(path);
  if (!isCurrent()) throw stale;
  // A second check also covers an account switch while the response was in flight.
  await confirmIdentity(isCurrent);
  return data;
}
function surveyPath() { return `/surveys/${encodeURIComponent(surveyId)}`; }
function questionPath(questionId) { return `${surveyPath()}/questions/${encodeURIComponent(questionId)}`; }

function renderQuestion(question, index, canSelect = false) {
  const card = element('article', undefined, 'stat-card');
  card.dataset.questionId = question.questionId;
  card.append(element('h3', `${index + 1}. ${question.title || '未命名题目'}`));
  card.append(element('p', types[question.type] || '题目', 'hint'));
  const answered = element('p', `有效回答数：${formatNumber(question.answeredCount)}`, 'stat-count');
  answered.dataset.stat = 'answered-count';
  card.append(answered);
  if (question.type === 'single_choice' || question.type === 'multiple_choice') {
    const table = element('table', undefined, 'option-statistics');
    table.append(element('caption', question.type === 'multiple_choice'
      ? '各选项百分比以本题非空有效回答数为分母；多选百分比合计可超过 100%。'
      : '各选项百分比以本题非空有效回答数为分母。'));
    const head = element('thead');
    const heading = element('tr');
    for (const label of ['选项', '次数', '百分比']) {
      const cell = element('th', label);
      cell.scope = 'col';
      heading.append(cell);
    }
    head.append(heading);
    const body = element('tbody');
    for (const option of question.options || []) {
      const row = element('tr');
      row.dataset.optionId = option.id;
      row.append(element('td', option.label, 'option-label'), element('td', formatNumber(option.count)), element('td', formatPercentage(option.percentage)));
      body.append(row);
    }
    table.append(head, body);
    card.append(table);
  } else if (question.type === 'number') {
    const average = element('p', `平均值：${formatNumber(question.average)}`);
    average.dataset.stat = 'average';
    card.append(average);
  }
  if (canSelect) {
    const button = element('button', '查看单题统计与回答', 'secondary');
    button.type = 'button';
    button.dataset.action = 'question-details';
    button.addEventListener('click', () => {
      $('#question-select').value = question.questionId;
      selectQuestion(question.questionId);
      $('#question-heading').scrollIntoView({ block: 'start' });
      $('#question-select').focus({ preventScroll: true });
    });
    card.append(button);
  }
  return card;
}
function renderOverview() {
  const { survey, questions, totalSubmissions } = statistics;
  document.title = `${survey.title || '未命名问卷'} · 统计与答卷`;
  $('#survey-title').textContent = survey.title || '未命名问卷';
  $('#survey-description').textContent = survey.description || '暂无说明';
  $('#total-submissions').textContent = formatNumber(totalSubmissions);
  $('#zero-state').hidden = totalSubmissions !== 0;
  $('#edit-link').href = `/editor.html?id=${encodeURIComponent(surveyId)}`;
  $('#edit-link').hidden = false;
  $('#question-overview').replaceChildren(...questions.map((question, index) => renderQuestion(question, index, true)));
  if (!questions.length) $('#question-overview').append(element('p', '尚无题目。', 'muted'));
  for (const [index, question] of questions.entries()) {
    const option = element('option', `${index + 1}. ${question.title || '未命名题目'}（${types[question.type] || '题目'}）`);
    option.value = question.questionId;
    $('#question-select').append(option);
  }
  $('#question-select').disabled = questions.length === 0;
  if (!questions.length) $('#question-status').textContent = '尚无题目可供查看。';
}
async function reloadSurvey() {
  if (loginBusy) return;
  const currentEpoch = clearSensitive();
  const isCurrent = () => epoch === currentEpoch;
  suspended = false;
  $('#login-panel').hidden = true;
  $('#main').setAttribute('aria-busy', 'true');
  $('#refresh-button').disabled = true;
  $('#page-status').textContent = '正在确认身份并加载统计…';
  surveyId = new URLSearchParams(location.search).get('id');
  if (!surveyId) {
    $('#page-status').textContent = '请选择问卷。';
    $('#page-error-text').textContent = '缺少问卷链接，请从“我的问卷”进入统计。';
    $('#page-error').hidden = false;
    $('#page-retry').hidden = true;
    $('#main').setAttribute('aria-busy', 'false');
    $('#refresh-button').disabled = false;
    return;
  }
  try {
    const session = await request('/auth/me');
    if (!isCurrent()) return;
    userId = identity(session);
    const data = await protectedRead(`${surveyPath()}/statistics`, isCurrent);
    if (!isCurrent()) return;
    if (!data?.survey || !Array.isArray(data.questions)) throw new Error('Invalid statistics response');
    statistics = data;
    $('#account-name').textContent = session.user.username;
    renderOverview();
    $('#statistics-content').hidden = false;
    $('#page-status').textContent = '已加载。时间以本机时区显示。';
    armExpiry(session.expiresAt);
    if (data.questions.length) selectQuestion(data.questions[0].questionId);
    void loadPage('submissions', 0, [null]);
  } catch (error) {
    if (!isCurrent()) return;
    $('#page-status').textContent = '统计加载未完成。';
    handleFailure('page', error, reloadSurvey);
  } finally {
    if (isCurrent()) {
      $('#main').setAttribute('aria-busy', 'false');
      $('#refresh-button').disabled = false;
    }
  }
}

function selectQuestion(questionId) {
  if (!statistics?.questions.some(question => question.questionId === questionId)) return;
  selectedQuestion = questionId;
  // Reset the question cursor even when a previous page request is still pending.
  paging.answers = freshPage();
  $('#answers-list').replaceChildren();
  $('#answers-pagination').hidden = true;
  void loadQuestion();
  void loadPage('answers', 0, [null]);
}
async function loadQuestion() {
  if (!statistics || !selectedQuestion) return;
  const questionId = selectedQuestion;
  const isCurrent = ticket('question');
  clearError('question');
  $('#question-statistics').replaceChildren();
  $('#question-statistics').setAttribute('aria-busy', 'true');
  $('#question-status').textContent = '正在加载单题统计…';
  try {
    const data = await protectedRead(`${questionPath(questionId)}/statistics`, isCurrent);
    if (!isCurrent()) return;
    const index = statistics.questions.findIndex(question => question.questionId === questionId);
    if (data?.question?.questionId !== questionId) throw new Error('Invalid question response');
    $('#question-statistics').append(renderQuestion(data.question, index));
    $('#question-status').textContent = '已加载单题统计。';
  } catch (error) {
    if (!isCurrent()) return;
    $('#question-status').textContent = '单题统计加载未完成。';
    handleFailure('question', error, loadQuestion);
  } finally {
    if (isCurrent()) $('#question-statistics').setAttribute('aria-busy', 'false');
  }
}
function appendAnswer(container, question, value) {
  if (value === null || value === undefined) {
    container.append(element('p', '经过但未作答（空答）', 'answer-value muted'));
    return;
  }
  if (question.type === 'single_choice' || question.type === 'multiple_choice') {
    const selected = Array.isArray(value) ? value : [value];
    const labels = new Map((question.options || []).map(option => [option.id, option.label]));
    const list = element('div', undefined, 'answer-options');
    list.setAttribute('role', 'list');
    for (const optionId of selected) {
      const label = element('p', labels.get(optionId) ?? '选项暂无数据', 'answer-value');
      label.setAttribute('role', 'listitem');
      list.append(label);
    }
    if (!selected.length) container.append(element('p', '经过但未作答（空答）', 'muted'));
    else container.append(list);
  } else container.append(element('p', String(value), 'answer-value'));
}
function renderResponses(kind, items, question) {
  const cards = items.map((item, index) => {
    const card = element('li', undefined, 'response-card');
    card.dataset.submissionId = item.submissionId;
    card.append(element('p', `本页第 ${index + 1} 份 · ${respondentLabel(item)} · ${dateLabel(item.submittedAt)}`, 'response-meta'));
    if (kind === 'answers') appendAnswer(card, question, item.value);
    const open = element('button', '查看完整答卷', 'secondary');
    open.type = 'button';
    open.dataset.action = 'open-submission';
    open.addEventListener('click', () => { void loadDetail(item.submissionId); });
    card.append(open);
    return card;
  });
  $(`#${kind}-list`).replaceChildren(...cards);
}
async function loadPage(kind, targetPage, targetCursors) {
  if (!statistics) return;
  const question = statistics.questions.find(item => item.questionId === selectedQuestion);
  if (kind === 'answers' && !question) return;
  const isCurrent = ticket(kind);
  const state = paging[kind];
  state.busy = true;
  clearError(kind);
  $(`#${kind}-list`).replaceChildren();
  $(`#${kind}-status`).textContent = kind === 'answers' ? '正在加载非空有效回答…' : '正在加载答卷…';
  updatePagination(kind);
  const cursors = [...targetCursors];
  const retry = () => { void loadPage(kind, targetPage, cursors); };
  try {
    const params = new URLSearchParams({ limit: '20' });
    if (cursors[targetPage]) params.set('cursor', cursors[targetPage]);
    const path = kind === 'answers' ? `${questionPath(question.questionId)}/answers` : `${surveyPath()}/submissions`;
    const data = await protectedRead(`${path}?${params}`, isCurrent);
    if (!isCurrent()) return;
    if (!Array.isArray(data?.items) || !(data.nextCursor === null || typeof data.nextCursor === 'string')) throw new Error('Invalid list response');
    state.page = targetPage;
    state.cursors = cursors;
    state.nextCursor = data.nextCursor;
    renderResponses(kind, data.items, question);
    $(`#${kind}-pagination`).hidden = false;
    $(`#${kind}-status`).textContent = data.items.length
      ? `第 ${state.page + 1} 页，本页 ${data.items.length} 条。`
      : kind === 'answers' ? '本页暂无非空有效回答。' : '本页暂无答卷。';
  } catch (error) {
    if (!isCurrent()) return;
    $(`#${kind}-status`).textContent = '列表加载未完成。';
    handleFailure(kind, error, retry);
  } finally {
    if (isCurrent()) { state.busy = false; updatePagination(kind); }
  }
}
function renderDetail(data) {
  const container = $('#detail-content');
  container.append(element('h3', data.survey.title || '未命名问卷'));
  container.append(element('p', data.survey.description || '暂无说明', 'answer-value muted'));
  container.append(element('p', `${respondentLabel(data)} · ${dateLabel(data.submittedAt)}`, 'response-meta'));
  container.append(element('p', '以下按当前题目顺序展示最终有效答案；跳过的题目不显示历史暂存答案。', 'hint'));
  const path = new Set(data.effectivePath);
  const answers = new Map(data.answers.map(answer => [answer.questionId, answer.value]));
  const list = element('ol', undefined, 'detail-answers');
  for (const [index, question] of statistics.questions.entries()) {
    const item = element('li', undefined, 'detail-answer');
    item.dataset.questionId = question.questionId;
    item.append(element('h3', `${index + 1}. ${question.title || '未命名题目'}`));
    if (!path.has(question.questionId)) {
      item.dataset.answerState = 'skipped';
      item.append(element('p', '跳过（不在最终有效路径中）', 'muted'));
    } else {
      const value = answers.get(question.questionId) ?? null;
      item.dataset.answerState = value === null ? 'empty' : 'answered';
      appendAnswer(item, question, value);
    }
    list.append(item);
  }
  container.append(list);
}
async function loadDetail(submissionId) {
  if (!statistics) return;
  const isCurrent = ticket('detail');
  clearError('detail');
  $('#detail-panel').hidden = false;
  $('#detail-content').replaceChildren();
  $('#detail-content').setAttribute('aria-busy', 'true');
  $('#detail-status').textContent = '正在加载完整答卷…';
  $('#detail-heading').focus({ preventScroll: true });
  $('#detail-panel').scrollIntoView({ block: 'start' });
  try {
    const data = await protectedRead(`${surveyPath()}/submissions/${encodeURIComponent(submissionId)}`, isCurrent);
    if (!isCurrent()) return;
    if (!data?.survey || !Array.isArray(data.answers) || !Array.isArray(data.effectivePath)) throw new Error('Invalid detail response');
    renderDetail(data);
    $('#detail-status').textContent = '已加载完整有效答卷。';
  } catch (error) {
    if (!isCurrent()) return;
    $('#detail-status').textContent = '答卷详情加载未完成。';
    handleFailure('detail', error, () => { void loadDetail(submissionId); });
  } finally {
    if (isCurrent()) $('#detail-content').setAttribute('aria-busy', 'false');
  }
}

$('#refresh-button').addEventListener('click', () => { void reloadSurvey(); });
$('#change-account').addEventListener('click', () => {
  requireLogin('可在本页重新登录。登录后将重新检查当前账号是否为本问卷作者。');
  $('#login-username').focus();
});
$('#question-select').addEventListener('change', event => { selectQuestion(event.target.value); });
for (const scope of ['page', 'question', 'answers', 'submissions', 'detail']) {
  $(`#${scope}-retry`).addEventListener('click', () => { retries[scope]?.(); });
}
for (const kind of ['answers', 'submissions']) {
  $(`#${kind}-previous`).addEventListener('click', () => {
    const state = paging[kind];
    if (!state.busy && state.page > 0) void loadPage(kind, state.page - 1, state.cursors);
  });
  $(`#${kind}-next`).addEventListener('click', () => {
    const state = paging[kind];
    if (!state.busy && state.nextCursor) void loadPage(kind, state.page + 1, [...state.cursors.slice(0, state.page + 1), state.nextCursor]);
  });
}
$('#detail-close').addEventListener('click', () => {
  versions.detail++;
  $('#detail-content').replaceChildren();
  $('#detail-panel').hidden = true;
  clearError('detail');
});
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (loginBusy) return;
  const username = $('#login-username').value;
  const password = $('#login-password').value;
  // No old author content survives a login attempt, including a failed one.
  const currentEpoch = clearSensitive();
  loginBusy = true;
  $('#login-error').hidden = true;
  $('#login-submit').disabled = true;
  $('#login-username').readOnly = true;
  $('#login-password').readOnly = true;
  $('#login-form').setAttribute('aria-busy', 'true');
  $('#login-status').textContent = '正在登录…';
  try {
    await request('/auth/login', { method: 'POST', body: { username, password } });
    if (epoch !== currentEpoch) return;
    loginBusy = false;
    await reloadSurvey();
  } catch (error) {
    if (epoch !== currentEpoch) return;
    $('#login-error').textContent = error.code === 'INVALID_CREDENTIALS' ? '用户名或密码不正确，请重试。' : errorLabel(error);
    $('#login-error').hidden = false;
  } finally {
    loginBusy = false;
    $('#login-password').value = '';
    $('#login-submit').disabled = false;
    $('#login-username').readOnly = false;
    $('#login-password').readOnly = false;
    $('#login-form').setAttribute('aria-busy', 'false');
    $('#login-status').textContent = '';
    if (suspended && !document.hidden) void reloadSurvey();
  }
});

// Scrub before a page enters history cache, then reauthorize on restoration.
window.addEventListener('pagehide', () => {
  clearSensitive();
  $('#login-panel').hidden = true;
  suspended = true;
});
window.addEventListener('pageshow', event => {
  if (event.persisted) void reloadSurvey();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearSensitive();
    suspended = true;
    $('#page-status').textContent = '返回页面后将重新确认身份并加载。';
  } else if (suspended && !loginBusy) void reloadSurvey();
});
window.addEventListener('focus', () => {
  if (suspended && !document.hidden && !loginBusy) void reloadSurvey();
});
window.addEventListener('popstate', () => { void reloadSurvey(); });

void reloadSurvey();
