// Markdown mini (aman: semua teks di-escape dulu).

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function renderMarkdown(src) {
  const parts = escapeHtml(src || '').split(/```/);
  return parts
    .map((part, i) => {
      if (i % 2) {
        const code = part.replace(/^[\w+-]*\n/, '');
        return `<pre><code>${code}</code></pre>`;
      }
      const out = [];
      let list = null;
      for (const line of part.split('\n')) {
        const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
        if (li) {
          if (!list) {
            list = /^\s*\d/.test(line) ? 'ol' : 'ul';
            out.push(`<${list}>`);
          }
          out.push(`<li>${inline(li[1])}</li>`);
          continue;
        }
        if (list) {
          out.push(`</${list}>`);
          list = null;
        }
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) out.push(`<h4>${inline(h[2])}</h4>`);
        else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
      }
      if (list) out.push(`</${list}>`);
      return out.join('');
    })
    .join('');
}
