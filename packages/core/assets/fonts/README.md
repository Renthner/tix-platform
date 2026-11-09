# Bundled PDF fonts

Noto Sans Regular and Bold, used for invoice and ticket PDFs (embedded as subsets by
`src/pdf/fonts.ts`).

- Source: https://github.com/notofonts/latin-greek-cyrillic/releases/tag/NotoSans-v2.015
  (`NotoSans/unhinted/ttf/NotoSans-Regular.ttf` and `NotoSans-Bold.ttf`, release NotoSans-v2.015)
- Licence: SIL Open Font License 1.1, see `OFL.txt`
- Coverage: Latin, Latin Extended, Greek, Cyrillic, Vietnamese. No CJK, Arabic or Hebrew;
  such characters print as `?`.
- Size: about 430 KB per file; a PDF only embeds the glyphs it uses.
- Override the lookup directory with the `TIX_FONT_DIR` environment variable.
- **Glyph padding (important):** both files were re-packed with fontTools (`glyf.padding = 4`,
  outlines unchanged). The upstream files store odd-length glyph records; `@pdf-lib/fontkit`
  subsets write a short-format `loca` and drop the last byte of every odd-length glyph, so
  letters/digits vanished in rendered PDFs (text layer intact). `test/pdf-fonts.test.ts` guards
  this; re-pack any replacement font the same way (`t['glyf'].padding = 4`, expand all glyphs, save).
