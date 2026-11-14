'use client';

import {
  EMAIL_HELPER_SNIPPETS,
  joinEmailContent,
  splitEmailContent,
  type EmailContentParts,
  type EmailVariableGroup,
  type EmailVariableInfo,
} from '@tix/shared';
import { Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { IDLE, type ActionState } from '@/lib/action-state';
import { cn } from '@/lib/utils';
import type { TemplateIssue } from '@tix/core';
import type {
  PreviewResult,
  TemplateActionState,
  TemplateDraftInput,
  TemplateTestResult,
} from '@/server/admin/email-templates';
import { ConfirmAction } from './confirm-action';
import { EmailVisualEditor } from './email-visual-editor';
import { ActionFeedback, ActionForm, Field, SubmitButton, errorOf } from './form-controls';

type Target = 'subject' | 'visual' | 'source' | 'text';
type Mode = 'visual' | 'source';

export interface EmailTemplateEditorProps {
  initial: { subject: string; bodyHtml: string; bodyText: string; isActive: boolean };
  variables: EmailVariableInfo[];
  isDefault: boolean;
  save: (state: TemplateActionState, fd: FormData) => Promise<TemplateActionState>;
  reset: (state: ActionState) => Promise<ActionState>;
  preview: (draft: TemplateDraftInput) => Promise<PreviewResult>;
  generateText: (bodyHtml: string) => Promise<string>;
  sendTest: (draft: TemplateDraftInput) => Promise<TemplateTestResult>;
  adminEmail: string;
}

const GROUP_ORDER: EmailVariableGroup[] = [
  'order',
  'tickets',
  'customer',
  'account',
  'smtpTest',
  'shop',
];

export function EmailTemplateEditor({
  initial,
  variables,
  isDefault,
  save,
  reset,
  preview,
  generateText,
  sendTest,
  adminEmail,
}: EmailTemplateEditorProps) {
  const t = useTranslations('emailTemplates');
  const [state, formAction] = useActionState(save, IDLE as TemplateActionState);
  const [subject, setSubject] = useState(initial.subject);
  const [doc, setDoc] = useState(initial.bodyHtml);
  const [text, setText] = useState(initial.bodyText);
  const [active, setActive] = useState(initial.isActive);
  const [mode, setMode] = useState<Mode>(() =>
    splitEmailContent(initial.bodyHtml) ? 'visual' : 'source',
  );
  const [lossy, setLossy] = useState(false);
  const [acceptLossy, setAcceptLossy] = useState(false);
  const [visualKey, setVisualKey] = useState(0);
  const parts = useRef<EmailContentParts | null>(null);
  const [visualContent, setVisualContent] = useState(() => {
    const split = splitEmailContent(initial.bodyHtml);
    parts.current = split;
    return split?.content ?? '';
  });

  // The server re-renders after saving / resetting: adopt the stored (sanitised) values.
  const lastInitial = useRef(JSON.stringify(initial));
  useEffect(() => {
    const next = JSON.stringify(initial);
    if (next === lastInitial.current) return;
    lastInitial.current = next;
    setSubject(initial.subject);
    setDoc(initial.bodyHtml);
    setText(initial.bodyText);
    setActive(initial.isActive);
    setLossy(false);
    if (mode === 'visual') enterVisual(initial.bodyHtml);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const dirty =
    subject !== initial.subject ||
    doc !== initial.bodyHtml ||
    text !== initial.bodyText ||
    active !== initial.isActive;

  // ─── Insertion of placeholders at the cursor ──────────────────────────────
  const subjectRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const visualInsert = useRef<((value: string) => void) | null>(null);
  const lastTarget = useRef<Target | null>(null);
  const registerInsert = useCallback((fn: ((value: string) => void) | null) => {
    visualInsert.current = fn;
  }, []);

  const insert = (value: string) => {
    const target: Target = lastTarget.current ?? (mode === 'visual' ? 'visual' : 'source');
    if (target === 'visual' && mode === 'visual' && visualInsert.current) {
      visualInsert.current(value);
      return;
    }
    const field =
      target === 'subject'
        ? subjectRef.current
        : target === 'text'
          ? textRef.current
          : sourceRef.current;
    const setter = target === 'subject' ? setSubject : target === 'text' ? setText : setDoc;
    if (!field || (target === 'source' && mode !== 'source')) return;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    setter(field.value.slice(0, start) + value + field.value.slice(end));
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + value.length, start + value.length);
    });
  };

  // ─── Visual / source switch ───────────────────────────────────────────────
  function enterVisual(html: string) {
    const split = splitEmailContent(html);
    if (!split) {
      setMode('source');
      return;
    }
    parts.current = split;
    setVisualContent(split.content);
    setVisualKey((k) => k + 1);
    setMode('visual');
  }

  const canVisual = splitEmailContent(doc) !== null;

  // ─── Preview ──────────────────────────────────────────────────────────────
  const [previewData, setPreviewData] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewTab, setPreviewTab] = useState<'html' | 'text'>('html');
  const requestId = useRef(0);
  useEffect(() => {
    const id = ++requestId.current;
    setPreviewing(true);
    const timer = setTimeout(() => {
      preview({ subject, bodyHtml: doc, bodyText: text })
        .then((result) => {
          if (id === requestId.current) setPreviewData(result);
        })
        .catch(() => {
          if (id === requestId.current) setPreviewData({ ok: false });
        })
        .finally(() => {
          if (id === requestId.current) setPreviewing(false);
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [subject, doc, text, preview]);

  // ─── Test e-mail & text generation ────────────────────────────────────────
  const [testing, startTest] = useTransition();
  const [testResult, setTestResult] = useState<TemplateTestResult | null>(null);
  const [generating, startGenerate] = useTransition();

  const issues = state.status === 'error' ? (state.issues ?? []) : [];
  const warnings =
    state.status === 'success'
      ? (state.warnings ?? [])
      : previewData?.ok
        ? previewData.warnings
        : [];
  const liveErrors = previewData?.ok ? previewData.errors : [];
  const blocking = issues.length > 0 ? issues : liveErrors;
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    items: variables.filter((v) => v.group === group),
  })).filter((g) => g.items.length > 0);

  const track = (target: Target) => () => {
    lastTarget.current = target;
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
      <ActionForm action={formAction} className="min-w-0 space-y-5">
        <ActionFeedback state={state} />
        {state.status === 'success' && (state.warnings?.length ?? 0) > 0 && (
          <Alert>
            <AlertDescription>{t('editor.savedWarnings')}</AlertDescription>
          </Alert>
        )}
        <IssueList errors={blocking} warnings={warnings} />

        <Field
          label={t('editor.subject')}
          htmlFor="tpl-subject"
          error={errorOf(state, 'subject')}
          hint={t('editor.subjectHint', { example: '{{orderNumber}}' })}
        >
          <Input
            id="tpl-subject"
            name="subject"
            ref={subjectRef}
            value={subject}
            maxLength={300}
            required
            onFocus={track('subject')}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>

        <label className="flex items-start gap-3 text-sm">
          <Switch name="isActive" checked={active} onCheckedChange={setActive} className="mt-0.5" />
          <span>
            <span className="font-medium">{t('editor.active')}</span>
            <span className="block text-xs text-muted-foreground">{t('editor.activeHint')}</span>
          </span>
        </label>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">{t('editor.body')}</span>
            <div className="inline-flex rounded-md border p-0.5" role="group">
              <ModeButton
                active={mode === 'visual'}
                disabled={!canVisual}
                onClick={() => {
                  setLossy(false);
                  setAcceptLossy(false);
                  enterVisual(doc);
                }}
              >
                {t('editor.modeVisual')}
              </ModeButton>
              <ModeButton active={mode === 'source'} onClick={() => setMode('source')}>
                {t('editor.modeSource')}
              </ModeButton>
            </div>
          </div>
          {lossy && (
            <Alert>
              <AlertDescription className="space-y-2">
                <span className="block">{t('editor.lossy')}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setLossy(false);
                    setAcceptLossy(true);
                    enterVisual(doc);
                  }}
                >
                  {t('editor.lossyAnyway')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!canVisual && <p className="text-xs text-muted-foreground">{t('editor.noVisual')}</p>}
          {mode === 'visual' ? (
            <>
              <EmailVisualEditor
                key={visualKey}
                allowLossy={acceptLossy}
                content={visualContent}
                registerInsert={registerInsert}
                onChange={(html) => {
                  if (parts.current) setDoc(joinEmailContent(parts.current, html));
                }}
                onLossy={() => {
                  setLossy(true);
                  setMode('source');
                }}
              />
              <p className="text-xs text-muted-foreground" onFocus={track('visual')}>
                {t('editor.visualScope')}
              </p>
            </>
          ) : (
            <>
              <Textarea
                ref={sourceRef}
                value={doc}
                spellCheck={false}
                rows={22}
                aria-label={t('editor.sourceLabel')}
                aria-invalid={Boolean(errorOf(state, 'bodyHtml'))}
                className="font-mono text-xs leading-relaxed"
                onFocus={track('source')}
                onChange={(e) => {
                  setDoc(e.target.value);
                  setLossy(false);
                }}
              />
              <p className="text-xs text-muted-foreground">{t('editor.sourceHint')}</p>
            </>
          )}
          <input type="hidden" name="bodyHtml" value={doc} />
          {errorOf(state, 'bodyHtml') && state.status === 'error' && issues.length === 0 && (
            <p className="text-xs text-destructive" role="alert">
              {t('issues.errorsTitle')}
            </p>
          )}
        </div>

        <Field
          label={t('editor.plainText')}
          htmlFor="tpl-text"
          error={errorOf(state, 'bodyText')}
          hint={t('editor.plainTextHint')}
        >
          <Textarea
            id="tpl-text"
            name="bodyText"
            ref={textRef}
            value={text}
            rows={10}
            className="font-mono text-xs"
            onFocus={track('text')}
            onChange={(e) => setText(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={generating}
            onClick={() => startGenerate(async () => setText(await generateText(doc)))}
          >
            {t('editor.generateText')}
          </Button>
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton>{t('editor.save')}</SubmitButton>
          <ConfirmAction
            action={reset}
            variant="destructive"
            size="default"
            title={t('editor.resetTitle')}
            description={t('editor.resetDescription')}
            confirmLabel={t('editor.resetConfirm')}
          >
            {t('editor.resetToDefault')}
          </ConfirmAction>
          <span className="text-xs text-muted-foreground">
            {dirty ? (
              <Badge variant="secondary">{t('editor.unsaved')}</Badge>
            ) : isDefault ? (
              t('editor.isDefault')
            ) : (
              t('editor.customized')
            )}
          </span>
        </div>
      </ActionForm>

      <aside className="min-w-0 space-y-5 xl:sticky xl:top-4 xl:self-start">
        <section className="space-y-2 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">{t('placeholders.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('placeholders.hint')}</p>
          <div className="space-y-3">
            {grouped.map(({ group, items }) => (
              <div key={group}>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {t(`placeholders.groups.${group}`)}
                </div>
                <div className="flex flex-wrap gap-1">
                  {items.map((v) => (
                    <button
                      key={v.name}
                      type="button"
                      title={v.kind === 'html' ? t('placeholders.html') : undefined}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insert(`{{${v.name}}}`)}
                      className={cn(
                        'rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent',
                        v.kind === 'html' && 'border-dashed',
                      )}
                    >
                      {v.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="space-y-1 border-t pt-3">
            <div className="text-xs font-medium text-muted-foreground">
              {t('placeholders.helpersTitle')}
            </div>
            <div className="flex flex-wrap gap-1">
              {EMAIL_HELPER_SNIPPETS.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert(h.snippet)}
                  className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent"
                >
                  {h.snippet}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('placeholders.helpersHint', {
                ifExample: '{{#if name}}…{{/if}}',
                unlessExample: '{{#unless name}}…{{/unless}}',
              })}
            </p>
          </div>
        </section>

        <section className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">{t('preview.title')}</h2>
              <p className="text-xs text-muted-foreground">
                {previewing ? t('preview.loading') : t('preview.hint')}
              </p>
            </div>
            <div className="inline-flex rounded-md border p-0.5" role="group">
              <ModeButton active={previewTab === 'html'} onClick={() => setPreviewTab('html')}>
                {t('preview.html')}
              </ModeButton>
              <ModeButton active={previewTab === 'text'} onClick={() => setPreviewTab('text')}>
                {t('preview.text')}
              </ModeButton>
            </div>
          </div>
          {previewData?.ok && previewData.errors.length === 0 ? (
            <>
              <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
                <span className="text-xs text-muted-foreground">{t('preview.subject')}: </span>
                <span className="font-medium">{previewData.subject}</span>
              </div>
              {previewTab === 'html' ? (
                // Sandboxed (no scripts, no same-origin access): the mail is untrusted markup.
                <iframe
                  title={t('preview.title')}
                  sandbox=""
                  srcDoc={previewData.html}
                  className="h-[34rem] w-full rounded-md border bg-paper"
                />
              ) : (
                <pre className="max-h-[34rem] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
                  {previewData.text || t('preview.emptyText')}
                </pre>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('preview.unavailable')}</p>
          )}
          <div className="space-y-2 border-t pt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={testing || blocking.length > 0}
              onClick={() =>
                startTest(async () =>
                  setTestResult(await sendTest({ subject, bodyHtml: doc, bodyText: text })),
                )
              }
            >
              <Send className="size-4" /> {t('preview.sendTest')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t('preview.sendTestHint', { email: adminEmail })}
            </p>
            {testResult && (
              <Alert variant={testResult.status === 'success' ? 'default' : 'destructive'}>
                <AlertDescription>
                  {testResult.status === 'success'
                    ? t('preview.testSent', { to: testResult.to })
                    : testResult.code === 'invalid'
                      ? t('preview.testInvalid')
                      : testResult.code === 'notConfigured'
                        ? t('preview.testNotConfigured')
                        : t(`preview.testKinds.${testResult.kind ?? 'other'}`)}
                  {testResult.status === 'error' && testResult.code === 'failed' && (
                    <span className="mt-1 block font-mono text-xs break-all">
                      {t('preview.testDetail')} {testResult.message}
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50',
        active ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
      )}
    >
      {children}
    </button>
  );
}

type Issue = Pick<TemplateIssue, 'field' | 'code' | 'detail' | 'syntax'>;

function IssueList({ errors, warnings }: { errors: Issue[]; warnings: Issue[] }) {
  const t = useTranslations('emailTemplates.issues');
  if (errors.length === 0 && warnings.length === 0) return null;
  const line = (i: Issue) => {
    const field = t(`fields.${i.field as 'subject' | 'bodyHtml' | 'bodyText'}`);
    return i.code === 'syntax'
      ? t('syntax', {
          field,
          detail: i.syntax
            ? t(`syntaxErrors.${i.syntax.code}` as 'syntaxErrors.unexpectedElse', i.syntax.params)
            : i.detail,
        })
      : t(i.code === 'unavailablePlaceholder' ? 'unavailablePlaceholder' : 'unknownPlaceholder', {
          field,
          placeholder: `{{${i.detail}}}`,
        });
  };
  return (
    <div className="space-y-2">
      {errors.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>{t('errorsTitle')}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {errors.map((e, i) => (
                <li key={i}>{line(e)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {warnings.length > 0 && (
        <Alert>
          <AlertTitle>{t('warningsTitle')}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {warnings.map((w, i) => (
                <li key={i}>{line(w)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
