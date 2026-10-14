// The one modal form used throughout the page.
//
// ask(title, fields, okText, note) resolves to { key: value } or null (cancelled).
// A field is { key, label, value, placeholder } plus one of:
//   type: 'password' | options: { value: label } (a select) | textarea: true
//   browse: (current) => Promise<{ path } | { error }>  adds a "Browse…" button
//   showIf: [selectKey, value]  shows the field only while that select has that value
// note is a string or a DOM node shown above the fields.
import { $ } from './dom.js';

export function ask(title, fields, okText = 'OK', note = '') {
  return new Promise((resolve) => {
    $('#mtitle').textContent = title; $('#mOk').textContent = okText;
    const noteText = typeof note === 'string' ? note : note.textContent; // note may be a string or a DOM node
    $('#mbox').classList.toggle('wide', fields.some((f) => f.textarea) || noteText.length > 160);
    $('#mnote').replaceChildren(note); $('#mnote').style.display = noteText ? 'block' : 'none';
    const box = $('#mfields'); box.innerHTML = '';
    fields.forEach((f) => {
      const l = document.createElement('label'); l.textContent = f.label;
      let i;
      if (f.textarea) {
        i = document.createElement('textarea');
        i.value = f.value ?? ''; i.rows = 6; i.spellcheck = false; if (f.placeholder) i.placeholder = f.placeholder;
      } else if (f.options) {
        i = document.createElement('select');
        Object.entries(f.options).forEach(([v, t]) => i.add(new Option(t, v)));
        i.value = f.value in f.options ? f.value : Object.keys(f.options)[0];
      } else {
        i = document.createElement('input');
        i.type = f.type || 'text'; i.value = f.value ?? ''; if (f.placeholder) i.placeholder = f.placeholder;
        i.autocomplete = f.type === 'password' ? 'new-password' : 'off'; i.spellcheck = false;
      }
      i.name = f.key;
      if (f.browse) {
        const row = document.createElement('div'); row.className = 'browse';
        const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Browse…';
        b.onclick = async () => {
          b.disabled = true; b.textContent = 'Choose in dialog…';
          const r = await f.browse(i.value).catch(() => ({}));
          b.disabled = false; b.textContent = 'Browse…';
          if (r.path) i.value = r.path;
          else if (r.error) { $('#mnote').textContent = r.error; $('#mnote').style.display = 'block'; }
          i.focus();
        };
        row.append(i, b); l.appendChild(row);
      } else l.appendChild(i);
      box.appendChild(l);
      f.el = l;
    });
    // showIf: [otherKey, value] shows a field only while that select has that value.
    fields.filter((f) => f.showIf).forEach((f) => {
      const sel = box.querySelector(`[name="${f.showIf[0]}"]`);
      const sync = () => { f.el.style.display = sel.value === f.showIf[1] ? '' : 'none'; };
      sel.addEventListener('change', sync); sync();
    });
    const done = (v) => { $('#modal').style.display = 'none'; $('#mbox').onsubmit = null; $('#mCancel').onclick = null; resolve(v); };
    $('#mbox').onsubmit = (e) => { e.preventDefault(); const o = {}; box.querySelectorAll('input,select,textarea').forEach((i) => (o[i.name] = i.value.trim() === i.value || i.type === 'password' ? i.value : i.value.trim())); done(o); };
    $('#mCancel').onclick = () => done(null);
    $('#modal').style.display = 'flex';
    const inputs = Array.from(box.querySelectorAll('input,textarea')).filter((i) => i.closest('label').style.display !== 'none');
    (inputs.find((i) => !i.value) || inputs[0] || $('#mOk')).focus();
  });
}
