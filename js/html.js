import { CAT_EMOJI } from './constants.js';
import { formatMoney } from './model.js';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

export function txRowHTML(t) {
  const emoji = CAT_EMOJI[t.category] || '•';
  const sign = t.type === 'income' ? '+' : '−';
  const note = [t.note, t.date].filter(Boolean).join(' · ');
  const badge = t.recurring || t.recurringInstance ? '<span class="badge">Monthly</span>' : '';
  const id = escapeHtml(t.templateId || t.id);
  return `<button type="button" class="tx-item" data-tx-id="${id}" data-instance="${t.recurringInstance ? '1' : '0'}">
      <div class="tx-icon">${emoji}</div>
      <div class="tx-meta">
        <div class="tx-cat">${escapeHtml(t.category)}${badge}</div>
        <div class="tx-note">${escapeHtml(note)}</div>
      </div>
      <div class="tx-amt ${t.type === 'income' ? 'income' : 'expense'}">${sign}${escapeHtml(formatMoney(t.amount))}</div>
    </button>`;
}
