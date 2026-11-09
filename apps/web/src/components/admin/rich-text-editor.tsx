'use client';

import TextAlign from '@tiptap/extension-text-align';
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Undo2,
  Unlink,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RICH_TEXT_CLASS } from '@/lib/rich-text-styles';
import { cn } from '@/lib/utils';

/** Only these link targets are accepted (mirrors the server-side sanitiser). */
const ALLOWED_LINK = /^(https?:\/\/|mailto:|tel:)/i;

const FONT_FAMILIES = [
  { key: 'sans', value: 'Arial, Helvetica, sans-serif' },
  { key: 'serif', value: 'Georgia, "Times New Roman", serif' },
  { key: 'mono', value: '"Courier New", Courier, monospace' },
  { key: 'verdana', value: 'Verdana, Geneva, sans-serif' },
  { key: 'trebuchet', value: '"Trebuchet MS", Helvetica, sans-serif' },
  { key: 'palatino', value: '"Palatino Linotype", "Book Antiqua", Palatino, serif' },
] as const;

const FONT_SIZES = ['12px', '14px', '16px', '18px', '20px', '24px', '28px', '32px'] as const;

export function RichTextEditor({
  name,
  defaultValue,
  id,
  ariaLabel,
  invalid,
  compact,
}: {
  /** Name of the hidden input that carries the HTML on form submit. */
  name: string;
  defaultValue: string;
  id?: string;
  ariaLabel?: string;
  invalid?: boolean;
  /** Short texts (e.g. the shop footer): no headings / quotes, smaller editing area. */
  compact?: boolean;
}) {
  const [html, setHtml] = useState(defaultValue);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        codeBlock: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          protocols: ['mailto', 'tel'],
          isAllowedUri: (url, ctx) => ALLOWED_LINK.test(url) && ctx.defaultValidate(url),
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        },
      }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    content: defaultValue,
    editorProps: {
      attributes: {
        ...(id ? { id } : {}),
        ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        role: 'textbox',
        'aria-multiline': 'true',
        class: cn(compact ? 'min-h-24' : 'min-h-40', 'px-3 py-2 outline-none', RICH_TEXT_CLASS),
      },
    },
    onUpdate: ({ editor: e }) => setHtml(e.isEmpty ? '' : e.getHTML()),
  });

  return (
    <div
      className={cn(
        'rounded-md border border-input shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        invalid && 'border-destructive',
      )}
    >
      <input type="hidden" name={name} value={html} />
      {editor ? <Toolbar editor={editor} compact={compact} /> : <div className="h-10 border-b" />}
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor, compact }: { editor: Editor; compact?: boolean }) {
  const t = useTranslations('admin.richText');
  const [linkOpen, setLinkOpen] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      href: (e.getAttributes('link').href as string | undefined) ?? '',
      color: (e.getAttributes('textStyle').color as string | undefined) ?? '',
      fontFamily: (e.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
      fontSize: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      align:
        (['left', 'center', 'right', 'justify'] as const).find((a) =>
          e.isActive({ textAlign: a }),
        ) ?? 'left',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();

  return (
    <div
      className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 p-1"
      role="toolbar"
      aria-label={t('toolbar')}
    >
      <ToolButton label={t('bold')} active={state.bold} onClick={() => chain().toggleBold().run()}>
        <Bold />
      </ToolButton>
      <ToolButton
        label={t('italic')}
        active={state.italic}
        onClick={() => chain().toggleItalic().run()}
      >
        <Italic />
      </ToolButton>
      <ToolButton
        label={t('underline')}
        active={state.underline}
        onClick={() => chain().toggleUnderline().run()}
      >
        <Underline />
      </ToolButton>
      <ToolButton
        label={t('strike')}
        active={state.strike}
        onClick={() => chain().toggleStrike().run()}
      >
        <Strikethrough />
      </ToolButton>
      <Divider />
      {!compact && (
        <>
          <ToolButton
            label={t('heading2')}
            active={state.h2}
            onClick={() => chain().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 />
          </ToolButton>
          <ToolButton
            label={t('heading3')}
            active={state.h3}
            onClick={() => chain().toggleHeading({ level: 3 }).run()}
          >
            <Heading3 />
          </ToolButton>
        </>
      )}
      <ToolButton
        label={t('bulletList')}
        active={state.bullet}
        onClick={() => chain().toggleBulletList().run()}
      >
        <List />
      </ToolButton>
      <ToolButton
        label={t('orderedList')}
        active={state.ordered}
        onClick={() => chain().toggleOrderedList().run()}
      >
        <ListOrdered />
      </ToolButton>
      {!compact && (
        <ToolButton
          label={t('blockquote')}
          active={state.quote}
          onClick={() => chain().toggleBlockquote().run()}
        >
          <Quote />
        </ToolButton>
      )}
      <Divider />
      <ToolButton
        label={state.link ? t('editLink') : t('addLink')}
        active={state.link}
        onClick={() => setLinkOpen(true)}
      >
        <Link2 />
      </ToolButton>
      <ToolButton
        label={t('removeLink')}
        disabled={!state.link}
        onClick={() => chain().extendMarkRange('link').unsetLink().run()}
      >
        <Unlink />
      </ToolButton>
      <Divider />
      <label className="flex items-center gap-1 px-1" title={t('color')}>
        <span className="sr-only">{t('color')}</span>
        <input
          type="color"
          className="size-7 cursor-pointer rounded border bg-transparent p-0.5"
          value={/^#[0-9a-f]{6}$/i.test(state.color) ? state.color : '#000000'}
          onChange={(e) => chain().setColor(e.target.value).run()}
        />
      </label>
      <ToolButton label={t('resetColor')} onClick={() => chain().unsetColor().run()}>
        <span className="text-xs font-semibold">A</span>
      </ToolButton>
      <select
        aria-label={t('fontFamily')}
        className="h-8 rounded-md border bg-background px-1 text-xs"
        value={state.fontFamily}
        onChange={(e) =>
          e.target.value
            ? chain().setFontFamily(e.target.value).run()
            : chain().unsetFontFamily().run()
        }
      >
        <option value="">{t('defaultFont')}</option>
        {FONT_FAMILIES.map((f) => (
          <option key={f.key} value={f.value}>
            {t(`fonts.${f.key}`)}
          </option>
        ))}
      </select>
      <select
        aria-label={t('fontSize')}
        className="h-8 rounded-md border bg-background px-1 text-xs"
        value={state.fontSize}
        onChange={(e) =>
          e.target.value ? chain().setFontSize(e.target.value).run() : chain().unsetFontSize().run()
        }
      >
        <option value="">{t('defaultSize')}</option>
        {FONT_SIZES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <Divider />
      {(
        [
          ['left', AlignLeft],
          ['center', AlignCenter],
          ['right', AlignRight],
          ['justify', AlignJustify],
        ] as const
      ).map(([align, Icon]) => (
        <ToolButton
          key={align}
          label={t(`align.${align}`)}
          active={state.align === align}
          onClick={() => chain().setTextAlign(align).run()}
        >
          <Icon />
        </ToolButton>
      ))}
      <Divider />
      <ToolButton label={t('undo')} disabled={!state.canUndo} onClick={() => chain().undo().run()}>
        <Undo2 />
      </ToolButton>
      <ToolButton label={t('redo')} disabled={!state.canRedo} onClick={() => chain().redo().run()}>
        <Redo2 />
      </ToolButton>
      <ToolButton
        label={t('clear')}
        onClick={() => chain().unsetAllMarks().clearNodes().unsetTextAlign().run()}
      >
        <RemoveFormatting />
      </ToolButton>
      <LinkDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        initial={state.href}
        onSave={(href) => {
          if (!href) chain().extendMarkRange('link').unsetLink().run();
          else chain().extendMarkRange('link').setLink({ href }).run();
        }}
      />
    </div>
  );
}

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={active ? 'secondary' : 'ghost'}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />;
}

function LinkDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: string;
  onSave: (href: string) => void;
}) {
  const t = useTranslations('admin.richText');
  const tc = useTranslations('common.actions');
  const [href, setHref] = useState(initial);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (open) {
      setHref(initial);
      setError(false);
    }
  }, [open, initial]);

  const submit = () => {
    const value = href.trim();
    if (value && !ALLOWED_LINK.test(value)) {
      setError(true);
      return;
    }
    onSave(value);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? t('editLink') : t('addLink')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rte-link">{t('linkUrl')}</Label>
          <Input
            id="rte-link"
            value={href}
            placeholder="https://"
            aria-invalid={error}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
          <p className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
            {t('linkHint')}
          </p>
        </div>
        <DialogFooter>
          {initial && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onSave('');
                onOpenChange(false);
              }}
            >
              {t('removeLink')}
            </Button>
          )}
          <Button type="button" onClick={submit}>
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
