import { ApiError, request } from './api.js';

const list = document.querySelector('#survey-list');
const empty = document.querySelector('#empty-state');
const region = document.querySelector('#list-region');
const status = document.querySelector('#list-status');
const errorBox = document.querySelector('#list-error');
const account = document.querySelector('#account-name');
const pagination = document.querySelector('#pagination');
const previous = document.querySelector('#previous-button');
const next = document.querySelector('#next-button');
const refresh = document.querySelector('#refresh-button');
const logout = document.querySelector('#logout-button');
let cursors = [null];
let page = 0;
let nextCursor = null;
let busy = false;
let authenticated = false;
let currentUserId = null;
let generation = 0;
let deletion = null;
const dialog = document.querySelector('#delete-dialog');
const confirmation = document.querySelector('#delete-confirmation');
const deleteSubmit = document.querySelector('#delete-submit');
const deleteRetry = document.querySelector('#delete-retry');
const deleteCancel = document.querySelector('#delete-cancel');
const deleteStatus = document.querySelector('#delete-status');
const statuses = { draft: '草稿', published: '已发布', closed: '已关闭' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

function dateLabel(value, fallback = '—') {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : dateFormat.format(date);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render(items) {
  const cards = items.map((survey) => {
    const card = element('li', undefined, 'survey-card');
    card.dataset.surveyId = survey.id;
    const heading = element('div', undefined, 'survey-card-heading');
    heading.append(element('h2', survey.title || '未命名问卷'));
    const badge = element('span', statuses[survey.status] || '状态未知', 'badge');
    if (survey.status === 'published' && survey.deadlineAt && new Date(survey.deadlineAt).getTime() <= Date.now()) {
      badge.textContent = '已发布 · 已到期';
    }
    if (Object.hasOwn(statuses, survey.status)) badge.classList.add(survey.status);
    heading.append(badge);
    card.append(heading, element('p', survey.description || '暂无说明', 'survey-description'));
    const metadata = element('dl', undefined, 'survey-meta');
    for (const [label, value] of [
      ['创建时间', dateLabel(survey.createdAt)],
      ['更新时间', dateLabel(survey.updatedAt)],
      ['截止时间', dateLabel(survey.deadlineAt, '未设置')],
    ]) {
      const pair = element('div');
      pair.append(element('dt', label), element('dd', value));
      metadata.append(pair);
    }
    const edit = element('a', '编辑问卷', 'button secondary');
    edit.href = `/editor.html?id=${encodeURIComponent(survey.id)}`;
    const actions = element('div', undefined, 'toolbar');
    actions.append(edit);
    if (survey.id) {
      const statistics = element('a', '统计与答卷', 'button secondary');
      statistics.href = `/statistics.html?id=${encodeURIComponent(survey.id)}`;
      statistics.dataset.action = 'statistics';
      actions.append(statistics);
      const expired = survey.status === 'published' && survey.deadlineAt && Date.parse(survey.deadlineAt) <= Date.now();
      if (survey.status === 'draft' || survey.status === 'closed' || expired) {
        const remove = element('button', '删除问卷', 'secondary');
        remove.type = 'button';
        remove.dataset.action = 'delete';
        remove.addEventListener('click', () => { void openDeletion(survey.id); });
        actions.append(remove);
      }
    }
    card.append(metadata, actions);
    return card;
  });
  list.replaceChildren(...cards);
  empty.hidden = items.length !== 0 || page !== 0;
  pagination.hidden = items.length === 0 && page === 0;
  document.querySelector('#page-number').textContent = `第 ${page + 1} 页`;
}

function setBusy(value) {
  busy = value;
  region.setAttribute('aria-busy', String(value));
  previous.disabled = value || page === 0;
  next.disabled = value || !nextCursor;
  refresh.disabled = value;
  logout.disabled = value || !authenticated;
  list.querySelectorAll('[data-action="delete"]').forEach(button => { button.disabled = value; });
}

async function identity(expected) {
  const { user } = await request('/auth/me');
  if (typeof user?.id !== 'string' || !user.id) throw new ApiError(200, 'INVALID_RESPONSE', '无法确认当前账号，请重试。');
  if (expected && user.id !== expected) throw new ApiError(409, 'ACCOUNT_CHANGED', '账号已变化，请恢复原账号后重试确认。');
  return user;
}

function clearList() {
  list.replaceChildren();
  empty.hidden = true;
  pagination.hidden = true;
  account.textContent = '';
}

function active(context) {
  return deletion === context && context.generation === generation && dialog.open;
}

function deletionControls(context) {
  const working = context.busy;
  dialog.setAttribute('aria-busy', String(working));
  deleteCancel.disabled = working;
  confirmation.disabled = working || context.phase !== 'confirm';
  deleteSubmit.disabled = working || context.phase !== 'confirm' || confirmation.value !== '删除';
  deleteRetry.hidden = !['retry', 'uncertain'].includes(context.phase);
  deleteRetry.disabled = working;
}

// Both success and resource errors need a fresh identity check. An auth failure
// must never become evidence that the original resource disappeared.
async function deletionRequest(context, options) {
  await identity(context.userId);
  if (!active(context)) return;
  if (options) context.sent = true;
  const targetPath = `/surveys/${encodeURIComponent(context.id)}${options ? '' : '/deletion-preview'}`;
  let result, failure;
  try { result = await request(targetPath, options); }
  catch (error) { failure = error; }
  await identity(context.userId);
  if (!active(context)) return;
  if (failure) {
    if (failure.status === 404 && failure.code === 'NOT_FOUND' && failure.requestPath === targetPath
      && ['问卷不存在或无权访问', '问卷不存在或已删除'].includes(failure.message)) failure.resourceMissing = true;
    throw failure;
  }
  return result;
}

function deletionError(context, error) {
  if (!active(context)) return;
  document.querySelector('#delete-preview').hidden = true;
  context.phase = context.sent ? 'uncertain' : 'retry';
  if (error.status === 401 || error.status === 403 || error.code === 'ACCOUNT_CHANGED') {
    clearList();
    authenticated = false;
    deleteStatus.textContent = `${context.sent ? '删除结果待确认。' : ''}无法确认原账号授权，请在其他页面恢复原账号后点击“重试确认”，或取消后刷新列表。`;
  } else {
    deleteStatus.textContent = context.sent
      ? '删除结果待确认。请检查连接后点击“重试确认”，页面将核验原账号并重试同一请求。'
      : `${error.message || '无法读取删除预览。'} 请点击“重试确认”重新读取。`;
  }
}

async function finishDeletion(context, missing = false) {
  if (!active(context)) return;
  deletion = null;
  dialog.close();
  for (const item of list.children) {
    if (item.dataset.surveyId === context.id) item.remove();
  }
  const refreshedGeneration = generation + 1;
  await loadPage(page, cursors);
  if (refreshedGeneration !== generation) return;
  if (currentUserId === context.userId && authenticated) {
    status.textContent = `${missing ? '已确认问卷不存在或已删除，操作完成。' : '问卷及全部答卷已永久删除。'} ${status.textContent}`;
  }
}

async function previewDeletion(context, message = '') {
  context.busy = true;
  context.phase = 'preview';
  context.body = null;
  context.sent = false;
  confirmation.value = '';
  document.querySelector('#delete-preview').hidden = true;
  deleteStatus.textContent = `${message}正在核验账号并读取删除预览…`;
  deletionControls(context);
  try {
    const data = await deletionRequest(context);
    if (!active(context)) return;
    if (data?.id !== context.id || typeof data.title !== 'string' || !Number.isSafeInteger(data.revision) || data.revision < 1 || !Number.isSafeInteger(data.totalSubmissions) || data.totalSubmissions < 0 || typeof data.canDelete !== 'boolean') {
      throw new Error('删除预览格式有误，请重试。');
    }
    context.body = { revision: data.revision, expectedUserId: context.userId, confirmation: '删除' };
    if (data.canDelete) {
      document.querySelector('#delete-title').textContent = data.title || '未命名问卷';
      document.querySelector('#delete-count').textContent = String(data.totalSubmissions);
      document.querySelector('#delete-preview').hidden = false;
      context.phase = 'confirm';
      deleteStatus.textContent = `${message}请核对标题与答卷数，再输入“删除”。`;
    } else {
      context.phase = 'retry';
      deleteStatus.textContent = `${message}问卷仍开放，当前不能删除。请先关闭问卷，再重新读取预览。`;
    }
  } catch (error) { deletionError(context, error); }
  finally {
    if (active(context)) {
      context.busy = false;
      deletionControls(context);
      if (context.phase === 'confirm') confirmation.focus();
    }
  }
}

async function openDeletion(id) {
  if (busy || deletion || !currentUserId || !authenticated) return;
  const context = { id, userId: currentUserId, generation, busy: false, phase: 'preview', sent: false };
  deletion = context;
  dialog.showModal();
  await previewDeletion(context);
}

async function sendDeletion(context) {
  if (!active(context) || context.busy || !context.body) return;
  context.busy = true;
  deleteStatus.textContent = '正在核验原账号并永久删除，请稍候…';
  deletionControls(context);
  try {
    // Preserve the exact payload through network/authentication retries.
    await deletionRequest(context, { method: 'DELETE', body: context.body });
    if (!active(context)) return;
    await finishDeletion(context);
  } catch (error) {
    if (!active(context)) return;
    if (error.resourceMissing) {
      await finishDeletion(context, true);
    } else if (error.status === 409 && ['REVISION_CONFLICT', 'SURVEY_STILL_OPEN'].includes(error.code)) {
      await previewDeletion(context, '问卷状态已变化，原确认已失效。');
    } else deletionError(context, error);
  } finally {
    if (active(context)) { context.busy = false; deletionControls(context); }
  }
}

confirmation.addEventListener('input', () => { if (deletion) deletionControls(deletion); });
document.querySelector('#delete-form').addEventListener('submit', event => {
  event.preventDefault();
  if (deletion?.phase === 'confirm' && confirmation.value === '删除') void sendDeletion(deletion);
});
deleteRetry.addEventListener('click', () => {
  if (!deletion || deletion.busy) return;
  if (deletion.sent && deletion.body) void sendDeletion(deletion);
  else void previewDeletion(deletion);
});
function cancelDeletion() {
  if (deletion?.busy) return;
  deletion = null;
  dialog.close();
}
deleteCancel.addEventListener('click', cancelDeletion);
dialog.addEventListener('cancel', event => { event.preventDefault(); cancelDeletion(); });

function showError(error) {
  errorBox.textContent = error.message || '无法加载问卷，请稍后刷新重试。';
  errorBox.hidden = false;
  errorBox.focus();
}

async function loadPage(targetPage, targetCursors) {
  if (busy) return;
  const version = ++generation;
  setBusy(true);
  errorBox.hidden = true;
  status.textContent = '正在加载问卷…';
  try {
    const user = await identity();
    if (version !== generation) return;
    if (currentUserId && user.id !== currentUserId) {
      clearList();
      targetPage = 0;
      targetCursors = [null];
    }
    let data;
    do {
      const params = new URLSearchParams({ limit: '20' });
      const cursor = targetCursors[targetPage];
      if (cursor) params.set('cursor', cursor);
      data = await request(`/surveys?${params}`);
      await identity(user.id);
      if (version !== generation) return;
      if (!Array.isArray(data?.items)) break;
      if (data.items.length || targetPage === 0) break;
      targetPage -= 1;
      targetCursors = targetCursors.slice(0, targetPage + 1);
    } while (true);
    if (!Array.isArray(data?.items) || !(data.nextCursor === null || typeof data.nextCursor === 'string')) {
      throw new Error('服务器返回的列表格式有误，请稍后刷新重试。');
    }
    page = targetPage;
    cursors = targetCursors;
    nextCursor = data.nextCursor;
    currentUserId = user.id;
    authenticated = true;
    account.textContent = user.username;
    render(data.items);
    status.textContent = data.items.length ? `第 ${page + 1} 页，共 ${data.items.length} 份问卷。时间以本机时区显示，是否可填写以服务端为准。` : '本页暂无问卷。';
  } catch (error) {
    if (version !== generation) return;
    if (error.status === 401) {
      authenticated = false;
      account.textContent = '';
      list.replaceChildren();
      empty.hidden = true;
      pagination.hidden = true;
      location.replace('/login.html?expired=1');
      return;
    }
    if (error.status === 403 || error.code === 'ACCOUNT_CHANGED') {
      clearList();
      authenticated = false;
    }
    status.textContent = '加载未完成，可点击“刷新列表”重试。';
    showError(error);
  } finally {
    if (version === generation) setBusy(false);
  }
}

previous.addEventListener('click', () => {
  if (page > 0) void loadPage(page - 1, cursors);
});
next.addEventListener('click', () => {
  if (nextCursor) void loadPage(page + 1, [...cursors.slice(0, page + 1), nextCursor]);
});
refresh.addEventListener('click', () => { void loadPage(0, [null]); });
logout.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  errorBox.hidden = true;
  status.textContent = '正在退出登录…';
  try {
    await request('/auth/logout', { method: 'POST' });
    location.replace('/login.html?logout=1');
  } catch (error) {
    if (error.status === 401) {
      location.replace('/login.html?expired=1');
      return;
    }
    status.textContent = '退出尚未确认，请重试。';
    showError(error);
  } finally {
    setBusy(false);
  }
});

// A restored browser history page must recheck the current session and reload its list.
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  generation += 1;
  deletion = null;
  if (dialog.open) dialog.close();
  busy = false;
  authenticated = false;
  clearList();
  void loadPage(0, [null]);
});

void loadPage(0, [null]);
