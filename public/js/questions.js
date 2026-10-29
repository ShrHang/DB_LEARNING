import { request } from './api.js';
import { node, contentEditor } from './content-editor.js';
const $ = s => document.querySelector(s);
let user, selected = null, base = null, editor, busy = false, generation = 0, questionCursor = null, bankCursor = null, versionCursor = null;
const selectedStats = new Map();
function button(text, action, disabled = false) { const b = node('button', text, 'secondary'); b.type = 'button'; b.disabled = disabled; b.onclick = () => run(action); return b; }
function link(text, href) { const a = node('a', text); a.href = href; return a; }
function error(e) {
  $('#library-error').hidden = false; $('#library-error').textContent = `${e.message || '操作失败'}${e.details?.length ? '：' + e.details.map(d => d.message).join('；') : ''}`;
  if (!e.status || e.status >= 500) $('#library-error').textContent += ' 操作结果尚未确认，请刷新列表或详情核对后再试。';
  if (e.status === 404 && e.requestPath?.startsWith('/questions/')) { $('#question-detail').hidden = true; $('#comparison-panel').hidden = true; selectedStats.clear(); }
  if (e.status === 401 || e.code === 'ACCOUNT_CHANGED') { generation++; $('#question-detail').hidden = true; $('#comparison-panel').hidden = true; $('#question-list').replaceChildren(); $('#banks').replaceChildren(); $('#bank-items').replaceChildren(); }
}
async function sameAccount() {
  const current = await request('/auth/me');
  if (!user || current.user.id !== user.id) throw { code: 'ACCOUNT_CHANGED', message: '账号已变化，请登录原账号或刷新页面。' };
}
async function run(action) {
  if (busy) return;
  busy = true; $('#library-error').hidden = true;
  const controls = [...document.querySelectorAll('button')].map(b => [b, b.disabled]); controls.forEach(([b]) => { b.disabled = true; });
  try { await sameAccount(); await action(); } catch (e) { error(e); }
  finally { busy = false; controls.forEach(([b, disabled]) => { if (b.isConnected) b.disabled = disabled; }); }
}
async function allPages(path) { let cursor = null; const items = []; do { const r = await request(`${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`); items.push(...r.items); cursor = r.nextCursor; } while (cursor); return items; }
async function listQuestions(next = false) {
  const g = ++generation;
  const r = await request(`/questions?scope=${$('#scope').value}&archived=${$('#archived').checked}${next && questionCursor ? '&cursor=' + encodeURIComponent(questionCursor) : ''}`);
  if (g !== generation) return;
  questionCursor = r.nextCursor; $('#next-questions').hidden = !questionCursor; $('#question-list').replaceChildren();
  for (const q of r.items) { const row = node('div', undefined, 'library-row'); row.append(node('p', `${q.latest.content.title} · v${q.latestNumber}${q.archived ? ' · 已归档' : ''}`), button('查看题目', () => detail(q.id))); $('#question-list').append(row); }
  if (!r.items.length) $('#question-list').append(node('p', '暂无题目。'));
}
function edit(version = null) {
  $('#content-fields').disabled = false;
  $('#content-form button[type=submit]').hidden = false;
  base = version;
  $('#content-panel').hidden = false; $('#content-heading').textContent = version ? `基于 v${version.number} 创建新版本` : '创建独立题目';
  editor = contentEditor($('#content-editor'), version?.content);
  $('#content-panel').scrollIntoView({ block: 'start' });
}
async function detail(questionId) {
  $('#question-detail').hidden = true; $('#comparison-panel').hidden = true;
  const g = ++generation;
  const q = await request(`/questions/${questionId}`);
  if (g !== generation) return;
  selected = q; selectedStats.clear(); $('#comparisons').replaceChildren(); $('#comparison-panel').hidden = true;
  history.replaceState(null, '', `/questions.html?id=${q.id}`);
  $('#question-detail').hidden = false; $('#detail-title').textContent = `${q.latest.content.title}${q.archived ? '（已归档）' : ''}`;
  $('#content-panel').hidden = true;
  const actions = $('#question-actions'); actions.replaceChildren();
  if (q.owned) {
    actions.append(button(q.archived ? '恢复归档' : '归档题目', async () => { await request(`/questions/${q.id}/${q.archived ? 'restore' : 'archive'}`, { method: 'POST', body: { revision: q.revision } }); await detail(q.id); await listQuestions(); }));
    if (!q.archived) actions.append(button('编辑最新版本', () => edit(q.latest)));
    actions.append(button('管理共享', shares));
  }
  actions.append(button('查看我的引用问卷', usage), button('加入题库', addToBank, q.archived));
  $('#shares').replaceChildren(); $('#usage').replaceChildren(); $('#versions').replaceChildren();
  await loadVersions(false);
}
async function loadVersions(next) {
  const q = selected; const g = generation;
  const r = await request(`/questions/${q.id}/versions${next && versionCursor ? '?cursor=' + encodeURIComponent(versionCursor) : ''}`);
  if (g !== generation) return;
  versionCursor = r.nextCursor; $('#next-versions').hidden = !versionCursor;
  if (!next) $('#versions').replaceChildren();
  const all = await allPages(`/questions/${q.id}/versions`); if (g !== generation) return;
  const names = new Map(all.map(v => [v.id, `v${v.number}`]));
  for (const v of r.items) {
    const row = node('div', undefined, 'library-row');
    row.append(node('p', `v${v.number} · ${v.content.title} · ${({create:'创建',edit:'修改',restore:'恢复',fork:'另存'})[v.operation]}${v.parentVersionId ? ' · 基于 ' + (names.get(v.parentVersionId) ?? '历史版本') : ''}${v.sourceVersionId ? ' · 另存自来源题目' : ''}`));
    if (v.source) row.append(link(`来源：${v.source.title} v${v.source.number}`, `/questions.html?id=${v.source.questionId}`));
    const toolbar = node('div', undefined, 'toolbar');
    toolbar.append(button('查看内容', () => { $('#content-panel').hidden = false; $('#content-heading').textContent = `查看 v${v.number}`; contentEditor($('#content-editor'), v.content); $('#content-form button[type=submit]').hidden = true; $('#content-editor').querySelectorAll('input,select,textarea,button').forEach(n => { n.disabled = true; }); }));
    if (q.owned && !q.archived) toolbar.append(button('基于此版修改', () => { $('#content-fields').disabled = false; edit(v); }), button('恢复此版为新版', async () => { await request(`/questions/${q.id}/versions`, { method: 'POST', body: { revision: selected.revision, parentVersionId: v.id, operation: 'restore' } }); await detail(q.id); await listQuestions(); }));
    toolbar.append(button('另存为我的题目', async () => { const created = await request(`/questions/${q.id}/fork`, { method: 'POST', body: { versionId: v.id } }); await listQuestions(); await detail(created.question.id); }, q.archived));
    const label = node('label', undefined, 'check-label'); const check = node('input'); check.type = 'checkbox'; check.onchange = () => run(async () => { if (check.checked) selectedStats.set(v.id, v); else selectedStats.delete(v.id); await comparisons(); }); label.append(check, document.createTextNode('对比统计')); toolbar.append(label); row.append(toolbar); $('#versions').append(row);
  }
}
async function shares() {
  const q = selected; const host = $('#shares'); host.replaceChildren(node('h3', '指定用户共享'));
  const form = node('form', undefined, 'toolbar'); const label = node('label', '接收用户名'); const input = node('input'); input.required = true; label.append(input); const submit = node('button', '授权'); submit.type = 'submit'; form.append(label, submit);
  form.onsubmit = e => { e.preventDefault(); run(async () => { await request(`/questions/${q.id}/shares`, { method: 'POST', body: { revision: selected.revision, username: input.value } }); await detail(q.id); await shares(); }); }; host.append(form);
  for (const grant of await allPages(`/questions/${q.id}/shares`)) { const row = node('p', grant.username ?? '账号不可用'); row.append(button('撤销共享', async () => { await request(`/questions/${q.id}/shares/${grant.id}`, { method: 'DELETE', body: { revision: selected.revision } }); await detail(q.id); await shares(); })); host.append(row); }
}
async function usage() {
  const host = $('#usage'); host.replaceChildren(node('h3', '我的引用问卷'));
  for (const s of await allPages(`/questions/${selected.id}/usage`)) { const row = node('p'); row.append(link(`${s.title || '未命名问卷'} · ${s.status}`, `/editor.html?id=${s.id}`)); host.append(row); }
}
async function listBanks(next = false) {
  const r = await request(`/question-banks${next && bankCursor ? '?cursor=' + encodeURIComponent(bankCursor) : ''}`); bankCursor = r.nextCursor; $('#next-banks').hidden = !bankCursor; $('#banks').replaceChildren();
  for (const bank of r.items) {
    const row = node('div', undefined, 'library-row'); row.append(node('strong', bank.name), button('查看题目', () => bankItems(bank)), button('重命名', async () => { const name = prompt('题库名称', bank.name); if (name === null) return; await request(`/question-banks/${bank.id}`, { method: 'PATCH', body: { revision: bank.revision, name } }); await listBanks(); }), button('删除分类', async () => { if (!confirm('只删除题库分类，不删除题目，是否继续？')) return; await request(`/question-banks/${bank.id}`, { method: 'DELETE', body: { revision: bank.revision } }); $('#bank-items').replaceChildren(); await listBanks(); })); $('#banks').append(row);
  }
}
async function bankItems(bank) {
  const host = $('#bank-items'); host.replaceChildren(node('h3', bank.name));
  const first = await request(`/question-banks/${bank.id}/items?limit=100`); const rows = [...first.items]; let cursor = first.nextCursor;
  while (cursor) { const r = await request(`/question-banks/${bank.id}/items?limit=100&cursor=${encodeURIComponent(cursor)}`); rows.push(...r.items); cursor = r.nextCursor; }
  for (const item of rows) {
    const row = node('p', item.question?.latest.content.title ?? '共享已撤销，题目不可用');
    if (item.question) row.append(button('查看', () => detail(item.questionId)));
    if (!item.available) row.append(document.createTextNode(' · 不可新增选用'));
    row.append(button('移出题库', async () => { await request(`/question-banks/${bank.id}/items/${item.questionId}`, { method: 'DELETE', body: { revision: first.bank.revision } }); await listBanks(); await bankItems(bank); })); host.append(row);
  }
}
async function addToBank() {
  const banks = await allPages('/question-banks'); const host = $('#shares'); host.replaceChildren(node('h3', '选择题库'));
  for (const bank of banks) host.append(button(bank.name, async () => { await request(`/question-banks/${bank.id}/items`, { method: 'POST', body: { revision: bank.revision, questionId: selected.id } }); $('#library-message').textContent = '已加入题库。'; await listBanks(); host.replaceChildren(); }));
  if (!banks.length) host.append(node('p', '请先创建题库。'));
}
async function comparisons() {
  const g = generation; const q = selected; const host = $('#comparisons'); host.replaceChildren(); $('#comparison-panel').hidden = !selectedStats.size;
  for (const v of selectedStats.values()) {
    const path = `/questions/${q.id}/versions/${v.id}`; const stats = await request(`${path}/statistics`); if (g !== generation) return;
    const card = node('article', undefined, 'panel'); card.append(node('h3', `v${v.number} · ${stats.title}`), node('p', `有效回答：${stats.answeredCount}`));
    for (const o of stats.options ?? []) card.append(node('p', `${o.label}：${o.count}（${o.percentage === null ? '暂无数据' : o.percentage.toFixed(2) + '%'}）`));
    if (stats.type === 'number') card.append(node('p', `平均值：${stats.average ?? '暂无数据'}`));
    async function pages(kind) {
      const section = node('section'); let cursor = null;
      async function load() {
        const r = await request(`${path}/${kind}${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`); if (g !== generation) return;
        for (const item of r.items) {
          const value = Array.isArray(item.value) ? item.value.map(id => v.content.options?.find(o => o.id === id)?.label ?? id).join('、') : stats.options ? v.content.options.find(o => o.id === item.value)?.label ?? item.value : item.value;
          const row = node('p', kind === 'frequencies' ? `${item.value}：${item.count} 次` : `${value} · ${item.anonymous ? '匿名' : item.respondent?.username ?? '账号不可用'} · ${item.submittedAt}`);
          if (item.survey) row.append(document.createTextNode(' · '), link(item.survey.title, `/statistics.html?id=${item.survey.id}`)); section.append(row);
        }
        cursor = r.nextCursor; more.hidden = !cursor;
      }
      const more = button('加载更多', load); section.append(more); await load(); card.append(section);
    }
    if (stats.type === 'number') { card.append(node('h4', '数值频次')); await pages('frequencies'); }
    card.append(node('h4', '回答明细')); await pages('answers'); if (g !== generation) return; host.append(card);
  }
}
$('#content-form').onsubmit = e => { e.preventDefault(); run(async () => {
  const result = base ? await request(`/questions/${selected.id}/versions`, { method: 'POST', body: { revision: selected.revision, parentVersionId: base.id, operation: 'edit', content: editor.read() } }) : await request('/questions', { method: 'POST', body: { content: editor.read() } });
  $('#library-message').textContent = result.unchanged ? '内容未变化，未创建新版本。' : '版本已保存。';
  await listQuestions(); await detail(base ? selected.id : result.question.id);
}); };
$('#new-question').onclick = () => { $('#content-fields').disabled = false; edit(); };
$('#cancel-content').onclick = () => { $('#content-panel').hidden = true; };
$('#refresh').onclick = () => run(listQuestions);
$('#scope').onchange = () => run(() => listQuestions()); $('#archived').onchange = () => run(() => listQuestions());
$('#next-questions').onclick = () => run(() => listQuestions(true)); $('#next-versions').onclick = () => run(() => loadVersions(true)); $('#next-banks').onclick = () => run(() => listBanks(true));
$('#bank-form').onsubmit = e => { e.preventDefault(); run(async () => { await request('/question-banks', { method: 'POST', body: { name: $('#bank-name').value } }); $('#bank-name').value = ''; await listBanks(); }); };
try { const me = await request('/auth/me'); user = me.user; $('#account').textContent = `当前账号：${user.username}`; await listQuestions(); await listBanks(); const params = new URLSearchParams(location.search); const id = params.get('id'); const versionId = params.get('version');
  if (id && versionId) {
    // A retained reference permits this version's statistics without reopening
    // the original library or exposing its other versions after revocation.
    const stats = await request(`/questions/${id}/versions/${versionId}/statistics`);
    selected = { id }; selectedStats.set(versionId, { id: versionId, number: stats.number, content: { options: stats.options } });
    await comparisons(); await usage(); $('#question-detail').hidden = false; $('#detail-title').textContent = '我的问卷所引用的版本';
  } else if (id) await detail(id); } catch (e) { error(e); }
