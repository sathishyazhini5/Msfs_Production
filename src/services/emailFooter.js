export const EXPLORE_URL = 'https://msfs.adminpro.co.in/';
export function withExploreMore(options) {
  if(String(options.html || '').includes('>Explore More</a>') && String(options.text || '').includes(`Explore More: ${EXPLORE_URL}`))return options;
  const footer = `<p style="margin:24px 0;text-align:center;font-family:Arial,sans-serif"><a href="${EXPLORE_URL}" style="display:inline-block;padding:12px 24px;background:#12345b;color:#ffffff;text-decoration:none;border-radius:4px">Explore More</a></p>`;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const html = options.html || (options.text ? `<p>${escape(options.text).replace(/\n/g, '<br>')}</p>` : '');
  const text = options.text || html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return { ...options, text: `${text}\n\nExplore More: ${EXPLORE_URL}`, html: /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${footer}</body>`) : `${html}${footer}` };
}
