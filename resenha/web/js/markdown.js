import { escapeHtml } from './util.js';

// Markdown no estilo do Discord. Tudo é escapado ANTES de formatar, então
// ninguém consegue injetar HTML/JS numa mensagem.
export function renderMarkdown(text, { users = [], meId } = {}) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;

  let s = String(text ?? '');

  // Blocos de código ```lang\n...```
  s = s.replace(/```(?:([\w+-]{1,20})\n)?([\s\S]*?)```/g, (_, lang, code) =>
    keep(`<pre class="code-block"><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(code.replace(/^\n+|\n+$/g, ''))}</code></pre>`),
  );
  // Código inline
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code class="inline">${escapeHtml(code)}</code>`));
  // Links
  s = s.replace(/https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,!?;:]/g, (url) =>
    keep(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`),
  );

  s = escapeHtml(s);

  // Citação "> texto" no começo da linha
  s = s.replace(/(^|\n)&gt; ([^\n]*)/g, (_, pre, body) => `${pre}<blockquote>${body}</blockquote>`);

  s = s
    .replace(/\*\*\*(.+?)\*\*\*/gs, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    .replace(/__(.+?)__/gs, '<u>$1</u>')
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/gs, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/gs, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/gs, '<s>$1</s>')
    .replace(/\|\|(.+?)\|\|/gs, '<span class="spoiler" tabindex="0">$1</span>');

  // Menções @nome e @everyone
  const names = new Map(users.map((u) => [u.username.toLowerCase(), u]));
  s = s.replace(/(^|[\s(])@([\p{L}\p{N}_.-]{2,32})/gu, (m, pre, name) => {
    if (name === 'everyone' || name === 'here') return `${pre}<span class="mention everyone">@${name}</span>`;
    const u = names.get(name.toLowerCase());
    if (!u) return m;
    return `${pre}<span class="mention ${u.id === meId ? 'me' : ''}" data-user="${u.id}">@${escapeHtml(u.username)}</span>`;
  });

  s = s.replace(/\n/g, '<br>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
  return s;
}

export function mentionsUser(text, user) {
  if (!text || !user) return false;
  const lower = text.toLowerCase();
  return lower.includes('@everyone') || lower.includes('@here') || new RegExp(`(^|[\\s(])@${user.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_.-])`, 'iu').test(text);
}

// Mensagem só com emojis fica grande, igual ao Discord
export function isEmojiOnly(text) {
  const t = (text || '').replace(/\s/g, '');
  return t.length > 0 && t.length <= 30 && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️)+$/u.test(t);
}
