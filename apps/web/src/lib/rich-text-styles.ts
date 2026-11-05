/**
 * Typography for sanitised rich text (event descriptions) – shared by the admin editor and
 * the shop so both render identically. Tailwind's preflight resets headings and lists, so
 * the element styles are restored here.
 */
export const RICH_TEXT_CLASS = [
  'text-sm leading-relaxed',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold',
  '[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold',
  '[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:font-semibold',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-0.5',
  '[&_li>p]:my-0',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground',
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
  '[&_hr]:my-4 [&_hr]:border-border',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1',
].join(' ');
