import { request } from './api.js';
import { node } from './content-editor.js';
export async function pickQuestion(onPick, onlyQuestion = null) {
  const dialog = node('dialog'); const title = node('h2', onlyQuestion ? '选择题目版本' : '从题库选题');
  const status = node('p'); status.setAttribute('role', 'alert');
  const controls = node('div', undefined, 'toolbar'); const list = node('div');
  const close = node('button', '取消', 'secondary'); close.type = 'button'; close.onclick = () => dialog.close();
  dialog.append(title, controls, status, list, close); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove()); dialog.showModal();
  let generation = 0;
  async function run(work) { try { status.textContent = ''; await work(); } catch (e) { status.textContent = e.message; } }
  function button(text, work) { const b = node('button', text, 'secondary'); b.type = 'button'; b.onclick = () => run(work); return b; }
  async function versions(qid, cursor = null) {
    const g = ++generation; const r = await request(`/questions/${qid}/versions${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`); if (g !== generation || !dialog.isConnected) return;
    list.replaceChildren();
    for (const v of r.items) { const row = node('div', undefined, 'library-row'); row.append(node('p', `v${v.number} · ${v.content.title}`), button('使用此版本', async () => { await onPick(qid, v); dialog.close(); })); list.append(row); }
    if (r.nextCursor) list.append(button('下一页版本', () => versions(qid, r.nextCursor)));
  }
  if (onlyQuestion) { await run(() => versions(onlyQuestion)); return; }
  const scope = node('select'); scope.setAttribute('aria-label', '选题来源');
  for (const [value, text] of [['own', '我的题目'], ['shared', '共享给我']]) { const o = node('option', text); o.value = value; scope.append(o); } controls.append(scope);
  async function load(cursor = null) {
    const g = ++generation;
    const path = scope.value.startsWith('bank:') ? `/question-banks/${scope.value.slice(5)}/items` : `/questions?scope=${scope.value}`;
    const r = await request(`${path}${path.includes('?') ? '&' : '?'}limit=20${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`); if (g !== generation || !dialog.isConnected) return;
    list.replaceChildren();
    for (const item of r.items) {
      const q = scope.value.startsWith('bank:') ? item.question : item;
      if (!q || q.archived) continue;
      const row = node('div', undefined, 'library-row'); row.append(node('p', q.latest.content.title), button('选择版本', () => versions(q.id))); list.append(row);
    }
    if (!list.children.length) list.append(node('p', '暂无可用题目。'));
    if (r.nextCursor) list.append(button('下一页题目', () => load(r.nextCursor)));
  }
  scope.onchange = () => run(() => load());
  await run(async () => {
    let cursor = null;
    do {
      const r = await request(`/question-banks?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
      for (const b of r.items) { const o = node('option', `题库：${b.name}`); o.value = `bank:${b.id}`; scope.append(o); }
      cursor = r.nextCursor;
    } while (cursor);
    await load();
  });
}
