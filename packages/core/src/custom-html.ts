import sanitizeHtml from 'sanitize-html';

/**
 * Wide allow-list sanitiser for the admin-authored custom shop start page. Layout, text,
 * media, `<style>` elements and `style` attributes are kept; scripts, frames, plugins, forms,
 * `<base>`/`<meta>`/`<link>`, event handlers and script-capable URLs are removed. Applied on
 * save AND on render.
 */

export const CUSTOM_HTML_MAX_LENGTH = 200_000;

const TAGS = [
  'div',
  'section',
  'header',
  'footer',
  'main',
  'article',
  'aside',
  'nav',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'span',
  'a',
  'img',
  'picture',
  'source',
  'figure',
  'figcaption',
  'video',
  'audio',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
  'blockquote',
  'hr',
  'br',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'mark',
  'code',
  'pre',
  'button',
  'style',
  'details',
  'summary',
];

const COMMON = ['class', 'id', 'style', 'title', 'lang', 'dir', 'role', 'aria-*', 'data-*'];
const BAD_CSS = /@import|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding/i;
const SAFE_DATA_IMAGE = /^\s*data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: TAGS,
  allowVulnerableTags: true, // <style> is intended
  allowedAttributes: {
    '*': COMMON,
    a: ['href', 'target', 'rel', 'name', 'download'],
    img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
    source: ['src', 'srcset', 'sizes', 'media', 'type', 'width', 'height'],
    video: [
      'src',
      'poster',
      'controls',
      'muted',
      'autoplay',
      'loop',
      'playsinline',
      'preload',
      'width',
      'height',
    ],
    audio: ['src', 'controls', 'muted', 'loop', 'preload'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    col: ['span'],
    colgroup: ['span'],
    ol: ['start', 'type', 'reversed'],
    li: ['value'],
    button: ['type', 'disabled'],
    details: ['open'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'poster', 'cite'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  // Contents of these are dropped together with the tag (`style` is allowed, so it stays).
  nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'object', 'embed', 'noscript'],
  transformTags: {
    '*': (tagName, attribs) => {
      const a = { ...attribs };
      if (a.style && BAD_CSS.test(a.style)) delete a.style;
      if (tagName === 'a') {
        if (a.target && a.target !== '_blank' && a.target !== '_self') delete a.target;
        if (a.target === '_blank') a.rel = 'noopener noreferrer';
        else delete a.rel;
      }
      if (tagName === 'img' && a.src && /^\s*data:/i.test(a.src) && !SAFE_DATA_IMAGE.test(a.src))
        delete a.src;
      if (tagName === 'button') a.type = 'button';
      // Autoplay only without sound.
      if ((tagName === 'video' || tagName === 'audio') && 'autoplay' in a && !('muted' in a))
        delete a.autoplay;
      return { tagName, attribs: a };
    },
  },
};

const STYLE_BLOCK = /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi;

export function sanitizeCustomHtml(html: string | null | undefined): string {
  if (!html) return '';
  return sanitizeHtml(html.slice(0, CUSTOM_HTML_MAX_LENGTH), OPTIONS)
    .replace(
      STYLE_BLOCK,
      (_m, open: string, css: string, close: string) =>
        `${open}${css.replace(/@import[^;]*;?/gi, '').replace(new RegExp(BAD_CSS.source, 'gi'), '')}${close}`,
    )
    .trim();
}
