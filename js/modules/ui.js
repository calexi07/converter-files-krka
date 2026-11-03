// Small DOM helpers shared by the app.
export const $ = (s, root = document) => root.querySelector(s);

export function el(tag, props = {}) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (v != null) e.setAttribute(k, v);
  }
  return e;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// Modal dialog. Resolves with the chosen action value ('input' -> the typed text).
export function showModal({ icon, iconClass = 'info', title, body, input, actions }) {
  return new Promise(resolve => {
    const root = document.getElementById('modal-root');
    const colors = { info: 'background:var(--info-bg);color:#24384C', warn: 'background:var(--warn-bg);color:var(--warn)', err: 'background:var(--error-bg);color:var(--error)' };
    const back = el('div', { class: 'modal-back', role: 'dialog', 'aria-modal': 'true' });
    const box = el('div', { class: 'modal card' });
    box.innerHTML = `<div class="card-b">${icon ? `<div class="err-ic" style="${colors[iconClass] || ''}">${esc(icon)}</div>` : ''}<h3>${esc(title)}</h3><p>${body}</p>${input ? `<div class="pw"><input type="${input.type || 'text'}" placeholder="${esc(input.placeholder || '')}" autocomplete="off"></div>` : ''}<div class="modal-actions"></div></div>`;
    const inp = box.querySelector('input');
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v === 'input' ? (inp?.value || null) : v); };
    const acts = box.querySelector('.modal-actions');
    for (const a of actions) {
      const b = el('button', { class: 'btn' + (a.primary ? ' btn-primary' : ''), type: 'button', text: a.label });
      b.addEventListener('click', () => done(a.value));
      acts.append(b);
    }
    const onKey = (e) => {
      if (e.key === 'Escape') done(actions[0].value);
      if (e.key === 'Enter' && inp && document.activeElement === inp) done('input');
    };
    document.addEventListener('keydown', onKey);
    back.append(box); root.append(back);
    (inp || acts.lastElementChild).focus();
  });
}

export function toast(msg, ms = 3200) {
  const root = document.getElementById('toast-root');
  const t = el('div', { class: 'toast', text: msg, role: 'status' });
  root.append(t);
  setTimeout(() => t.remove(), ms);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
