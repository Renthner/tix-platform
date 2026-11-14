import { describe, expect, it } from 'vitest';
import {
  EMAIL_OFF_CLOSE as C,
  EMAIL_OFF_OPEN as O,
  emailTextHtml,
  mailtoLinkHtml,
  protectEmailsInHtml,
} from '../src';

describe('protectEmailsInHtml', () => {
  it('wraps plain addresses in text', () => {
    expect(protectEmailsInHtml('<p>Write to info@example.org today</p>')).toBe(
      `<p>Write to ${O}info@example.org${C} today</p>`,
    );
  });

  it('wraps a whole mailto link once, not its text separately', () => {
    const html = '<p><a href="mailto:a@b.de">a@b.de</a></p>';
    expect(protectEmailsInHtml(html)).toBe(`<p>${O}<a href="mailto:a@b.de">a@b.de</a>${C}</p>`);
  });

  it('does not touch addresses in attributes of other tags', () => {
    const html = '<a href="/x?mail=a@b.de" title="a@b.de">go</a>';
    expect(protectEmailsInHtml(html)).toBe(html);
  });

  it('is idempotent', () => {
    const once = protectEmailsInHtml('<p>x@y.de <a href="mailto:z@y.de">mail</a></p>');
    expect(protectEmailsInHtml(once)).toBe(once);
  });

  it('leaves HTML without addresses untouched and handles several addresses', () => {
    expect(protectEmailsInHtml('<p>hello</p>')).toBe('<p>hello</p>');
    expect(protectEmailsInHtml('a@b.de, c@d.org')).toBe(`${O}a@b.de${C}, ${O}c@d.org${C}`);
  });

  it('closes an unclosed mailto link region', () => {
    expect(protectEmailsInHtml('<a href="mailto:a@b.de">a')).toBe(
      `${O}<a href="mailto:a@b.de">a${C}`,
    );
  });
});

describe('React helpers', () => {
  it('escapes text before protecting it', () => {
    expect(emailTextHtml('<b>x</b> a@b.de & co')).toBe(
      `&lt;b&gt;x&lt;/b&gt; ${O}a@b.de${C} &amp; co`,
    );
  });

  it('builds an escaped mailto link between the markers', () => {
    expect(mailtoLinkHtml('a@b.de')).toBe(`${O}<a href="mailto:a@b.de">a@b.de</a>${C}`);
    expect(mailtoLinkHtml('a@b.de', '"x"<', 'link')).toBe(
      `${O}<a href="mailto:a@b.de" class="link">&quot;x&quot;&lt;</a>${C}`,
    );
  });
});
