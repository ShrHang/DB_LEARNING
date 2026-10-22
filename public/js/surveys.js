import { request } from './api.js';

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
}

function showError(error) {
  errorBox.textContent = error.message || '无法加载问卷，请稍后刷新重试。';
  errorBox.hidden = false;
  errorBox.focus();
}

async function loadPage(targetPage, targetCursors) {
  if (busy) return;
  setBusy(true);
  errorBox.hidden = true;
  status.textContent = '正在加载问卷…';
  try {
    const { user } = await request('/auth/me');
    authenticated = true;
    account.textContent = user.username;
    const params = new URLSearchParams({ limit: '20' });
    const cursor = targetCursors[targetPage];
    if (cursor) params.set('cursor', cursor);
    const data = await request(`/surveys?${params}`);
    if (!Array.isArray(data?.items) || !(data.nextCursor === null || typeof data.nextCursor === 'string')) {
      throw new Error('服务器返回的列表格式有误，请稍后刷新重试。');
    }
    page = targetPage;
    cursors = targetCursors;
    nextCursor = data.nextCursor;
    render(data.items);
    status.textContent = data.items.length ? `第 ${page + 1} 页，共 ${data.items.length} 份问卷。时间以本机时区显示，是否可填写以服务端为准。` : '本页暂无问卷。';
  } catch (error) {
    if (error.status === 401) {
      authenticated = false;
      account.textContent = '';
      list.replaceChildren();
      empty.hidden = true;
      pagination.hidden = true;
      location.replace('/login.html?expired=1');
      return;
    }
    status.textContent = '加载未完成，可点击“刷新列表”重试。';
    showError(error);
  } finally {
    setBusy(false);
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
  list.replaceChildren();
  account.textContent = '';
  empty.hidden = true;
  pagination.hidden = true;
  void loadPage(0, [null]);
});

void loadPage(0, [null]);
