export function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
export function contentEditor(host, initial = { type: 'single_choice', title: '', options: [], validation: {} }) {
  let content = structuredClone(initial);
  function draw() {
    host.replaceChildren();
    function field(label, input) {
      const wrap = node('label', undefined, input.type === 'checkbox' ? 'check-label' : 'field'); wrap.append(document.createTextNode(label), input); host.append(wrap); return input;
    }
    const type = node('select'); type.dataset.contentField = 'type';
    for (const [value, text] of [['single_choice', '单选'], ['multiple_choice', '多选'], ['text', '文本'], ['number', '数字']]) { const o = node('option', text); o.value = value; type.append(o); }
    type.value = content.type;
    type.addEventListener('change', () => {
      if (!confirm('更换题型会清空选项及答案限制，是否继续？')) { type.value = content.type; return; }
      content = { type: type.value, title: content.title, validation: {}, ...(['single_choice', 'multiple_choice'].includes(type.value) ? { options: [] } : {}) }; draw();
    });
    field('题型', type);
    const title = node('textarea'); title.dataset.contentField = 'title'; title.value = content.title; title.rows = 2; title.required = true;
    title.addEventListener('input', () => { content.title = title.value; }); field('题干', title);
    if (['single_choice', 'multiple_choice'].includes(content.type)) {
      const choices = node('div'); host.append(choices);
      for (const [index, option] of (content.options ?? []).entries()) {
        const row = node('div', undefined, 'toolbar');
        const label = node('label', `选项 ${index + 1}`);
        const input = node('input'); input.value = option.label; input.required = true; label.append(input);
        input.addEventListener('input', () => { option.label = input.value; });
        const remove = node('button', '移除选项', 'secondary'); remove.type = 'button'; remove.onclick = () => { content.options.splice(index, 1); draw(); };
        row.append(label, remove); choices.append(row);
      }
      const add = node('button', '添加选项', 'secondary'); add.type = 'button'; add.onclick = () => { (content.options ??= []).push({ id: crypto.randomUUID(), label: '' }); draw(); }; host.append(add);
    }
    const constraints = content.type === 'multiple_choice' ? [['minSelections', '最少选择数'], ['maxSelections', '最多选择数']]
      : content.type === 'text' ? [['minLength', '最短字符数'], ['maxLength', '最长字符数']]
        : content.type === 'number' ? [['min', '最小值'], ['max', '最大值']] : [];
    for (const [key, title] of constraints) {
      const input = node('input'); input.type = 'number'; input.dataset.contentField = key; input.step = content.type === 'number' ? 'any' : '1'; input.value = content.validation?.[key] ?? '';
      input.oninput = () => { content.validation ??= {}; if (input.value === '') delete content.validation[key]; else content.validation[key] = input.valueAsNumber; };
      field(title, input);
    }
    if (content.type === 'number') {
      const input = node('input'); input.type = 'checkbox'; input.checked = Boolean(content.validation.integer);
      input.onchange = () => { content.validation.integer = input.checked; }; field('仅接受整数', input);
    }
  }
  draw();
  return { read: () => structuredClone(content) };
}
