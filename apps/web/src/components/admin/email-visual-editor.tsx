'use client';

import { protectEmailLogic, restoreEmailLogic } from '@tix/shared';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import {
  Bold,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  MousePointerClick,
  Redo2,
  Underline as UnderlineIcon,
  Undo2,
  Unlink,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
import { cn } from '@/lib/utils';
import {
  ALLOWED_LINK,
  BUTTON_STYLE,
  emailEditorExtensions,
  signature,
} from './email-editor-schema';

/**
 * Visual editor for the content region of an e-mail template (TipTap). E-mail HTML is table
 * based and carries inline styles, so the editor keeps `style` attributes and understands
 * tables; `{{placeholders}}` are plain text and valid link targets. Content the editor cannot
 * represent is detected by a round-trip check and left to the HTML source view (the admin can
 * still open it visually after a confirmation, `allowLossy`).
 */

export function EmailVisualEditor({
  content,
  onChange,
  onLossy,
  registerInsert,
  allowLossy = false,
}: {
  /** HTML of the editable content region. */
  content: string;
  onChange: (html: string) => void;
  /** Called once when the editor cannot represent `content` without losing information. */
  onLossy: () => void;
  /** Hands the placeholder inserter to the parent (picker). */
  registerInsert: (insert: ((text: string) => void) | null) => void;
  /** The admin accepted that unsupported markup may be simplified: skip the guard. */
  allowLossy?: boolean;
}) {
  const t = useTranslations('emailTemplates.editor');
  const checked = useRef(false);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: emailEditorExtensions(),
    content: protectEmailLogic(content),
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': t('visualLabel'),
        class: cn(
          'min-h-64 px-4 py-3 outline-none text-[15px] leading-relaxed',
          '[&_p]:my-3 [&_a]:text-blue-700 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6',
          '[&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold',
          '[&_.tpl-chip]:my-1 [&_.tpl-chip]:block [&_.tpl-chip]:w-fit [&_.tpl-chip]:cursor-default [&_.tpl-chip]:select-none [&_.tpl-chip]:rounded [&_.tpl-chip]:border [&_.tpl-chip]:border-violet-300 [&_.tpl-chip]:bg-violet-100 [&_.tpl-chip]:px-1.5 [&_.tpl-chip]:py-0.5 [&_.tpl-chip]:font-mono [&_.tpl-chip]:text-xs [&_.tpl-chip]:text-violet-900 [&_.tpl-chip]:before:content-[attr(data-tpl)]',
          '[&_table]:w-full [&_td]:align-top [&_td]:border [&_td]:border-dashed [&_td]:border-muted-foreground/30 [&_td]:px-1',
        ),
      },
    },
    onUpdate: ({ editor: e }) => onChange(restoreEmailLogic(e.getHTML())),
  });

  // Round-trip check once the document is loaded.
  useEffect(() => {
    if (!editor || checked.current) return;
    checked.current = true;
    if (!allowLossy && signature(restoreEmailLogic(editor.getHTML())) !== signature(content)) {
      onLossy();
    }
  }, [editor, content, onLossy, allowLossy]);

  useEffect(() => {
    if (!editor) return;
    registerInsert((text) => editor.chain().focus().insertContent(text).run());
    return () => registerInsert(null);
  }, [editor, registerInsert]);

  return (
    <div className="rounded-md border border-input bg-white text-zinc-900 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
      {editor ? <Toolbar editor={editor} /> : <div className="h-10 border-b" />}
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const t = useTranslations('emailTemplates.editor');
  const tr = useTranslations('admin.richText');
  const [linkOpen, setLinkOpen] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      link: e.isActive('link'),
      href: (e.getAttributes('link').href as string | undefined) ?? '',
      button: ((e.getAttributes('link').style as string | undefined) ?? '').includes(
        'display:inline-block',
      ),
      color: (e.getAttributes('textStyle').color as string | undefined) ?? '',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();

  return (
    <div
      className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 p-1 text-foreground"
      role="toolbar"
      aria-label={tr('toolbar')}
    >
      <Tool label={tr('bold')} active={state.bold} onClick={() => chain().toggleBold().run()}>
        <Bold />
      </Tool>
      <Tool label={tr('italic')} active={state.italic} onClick={() => chain().toggleItalic().run()}>
        <Italic />
      </Tool>
      <Tool
        label={tr('underline')}
        active={state.underline}
        onClick={() => chain().toggleUnderline().run()}
      >
        <UnderlineIcon />
      </Tool>
      <Sep />
      <Tool
        label={tr('heading2')}
        active={state.h2}
        onClick={() => chain().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 />
      </Tool>
      <Tool
        label={tr('heading3')}
        active={state.h3}
        onClick={() => chain().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 />
      </Tool>
      <Tool
        label={tr('bulletList')}
        active={state.bullet}
        onClick={() => chain().toggleBulletList().run()}
      >
        <List />
      </Tool>
      <Tool
        label={tr('orderedList')}
        active={state.ordered}
        onClick={() => chain().toggleOrderedList().run()}
      >
        <ListOrdered />
      </Tool>
      <Sep />
      <Tool
        label={state.link ? tr('editLink') : tr('addLink')}
        active={state.link}
        onClick={() => setLinkOpen(true)}
      >
        <Link2 />
      </Tool>
      <Tool
        label={tr('removeLink')}
        disabled={!state.link}
        onClick={() => chain().extendMarkRange('link').unsetLink().run()}
      >
        <Unlink />
      </Tool>
      <Tool
        label={t('linkAsButton')}
        active={state.button}
        disabled={!state.link}
        onClick={() =>
          chain()
            .extendMarkRange('link')
            .updateAttributes('link', { style: state.button ? null : BUTTON_STYLE })
            .run()
        }
      >
        <MousePointerClick />
      </Tool>
      <Sep />
      <label className="flex items-center gap-1 px-1" title={tr('color')}>
        <span className="sr-only">{tr('color')}</span>
        <input
          type="color"
          className="size-7 cursor-pointer rounded border bg-transparent p-0.5"
          value={/^#[0-9a-f]{6}$/i.test(state.color) ? state.color : '#000000'}
          onChange={(e) => chain().setColor(e.target.value).run()}
        />
      </label>
      <Tool label={tr('resetColor')} onClick={() => chain().unsetColor().run()}>
        <span className="text-xs font-semibold">A</span>
      </Tool>
      <Sep />
      <Tool label={tr('undo')} disabled={!state.canUndo} onClick={() => chain().undo().run()}>
        <Undo2 />
      </Tool>
      <Tool label={tr('redo')} disabled={!state.canRedo} onClick={() => chain().redo().run()}>
        <Redo2 />
      </Tool>
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

function Tool({
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

function Sep() {
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
  const t = useTranslations('emailTemplates.editor');
  const tr = useTranslations('admin.richText');
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
          <DialogTitle>{initial ? tr('editLink') : tr('addLink')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="email-link">{tr('linkUrl')}</Label>
          <Input
            id="email-link"
            value={href}
            placeholder="https:// · {{orderUrl}}"
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
            {t('linkHint', { example: '{{orderUrl}}' })}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" onClick={submit}>
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
