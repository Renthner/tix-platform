'use client';

import {
  TICKET_FIELD_KEYS,
  TICKET_FIELD_VARIABLES,
  TICKET_LABEL_KEYS,
  defaultTicketDesign,
  type TicketLayout,
  type TicketLayoutElement,
  type TicketTextElement,
} from '@tix/shared';
import { Redo2, Save, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useUnsavedChangesGuard } from '@/components/admin/unsaved-changes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { saveTicketTemplateAction } from '@/server/admin/ticket-templates';
import { DesignerCanvas, QR_ID, type ElementPatch } from './canvas';
import { ElementProps } from './parts/element-props';
import {
  HISTORY_LIMIT,
  PRESETS,
  matchCoverDraft,
  newImageElement,
  round,
  setPageSize,
  uid,
} from './parts/model';
import { PageProps, QrProps } from './parts/page-props';
import { PreviewCard } from './parts/preview-card';
import { ToolsPanel } from './parts/tools-panel';
import type { Draft, TicketDesignerProps } from './parts/types';
import { useLivePreview } from './parts/use-live-preview';

/**
 * Visual ticket designer: Konva canvas at millimetre scale, properties panel, page size
 * presets and a live PDF preview rendered by the server (the same renderer as real tickets).
 * The whole draft lives in client state, so nothing is lost on validation or network errors.
 */

export type { DesignerEventOption, TicketDesignerProps } from './parts/types';

export function TicketDesigner(props: TicketDesignerProps) {
  const t = useTranslations('ticketDesigner');
  const [draft, setDraft] = useState<Draft>(props.initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [past, setPast] = useState<Draft[]>([]);
  const [future, setFuture] = useState<Draft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [stageWidth, setStageWidth] = useState(720);
  const wrapRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  // ── state helpers ────────────────────────────────────────────────────────
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const commit = useCallback((next: Draft | ((d: Draft) => Draft), record = true) => {
    const current = draftRef.current;
    const value = typeof next === 'function' ? next(current) : next;
    if (record) {
      setPast((p) => [...p.slice(-HISTORY_LIMIT), current]);
      setFuture([]);
    }
    draftRef.current = value;
    setDraft(value);
    setDirty(true);
  }, []);

  const undo = () => {
    const previous = past[past.length - 1];
    if (!previous) return;
    setPast(past.slice(0, -1));
    setFuture([draft, ...future]);
    draftRef.current = previous;
    setDraft(previous);
    setDirty(true);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setPast([...past, draft]);
    setFuture(future.slice(1));
    draftRef.current = next;
    setDraft(next);
    setDirty(true);
  };

  const updateLayout = useCallback(
    (fn: (layout: TicketLayout) => TicketLayout) => commit((d) => ({ ...d, layout: fn(d.layout) })),
    [commit],
  );

  const patchElement = useCallback(
    (id: string, patch: ElementPatch) => {
      if (id === QR_ID) {
        updateLayout((l) => ({ ...l, qr: { ...l.qr, ...patch } as TicketLayout['qr'] }));
        return;
      }
      updateLayout((l) => ({
        ...l,
        elements: l.elements.map((e) =>
          e.id === id ? ({ ...e, ...patch } as TicketLayoutElement) : e,
        ),
      }));
    },
    [updateLayout],
  );

  const addElement = (element: TicketLayoutElement) => {
    updateLayout((l) => ({ ...l, elements: [...l.elements, element] }));
    setSelectedId(element.id);
  };

  const removeSelected = useCallback(() => {
    if (!selectedId || selectedId === QR_ID) return;
    updateLayout((l) => ({ ...l, elements: l.elements.filter((e) => e.id !== selectedId) }));
    setSelectedId(null);
  }, [selectedId, updateLayout]);

  const move = (delta: -1 | 1) => {
    if (!selectedId || selectedId === QR_ID) return;
    updateLayout((l) => {
      const index = l.elements.findIndex((e) => e.id === selectedId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= l.elements.length) return l;
      const elements = [...l.elements];
      [elements[index], elements[target]] = [elements[target]!, elements[index]!];
      return { ...l, elements };
    });
  };

  const duplicate = () => {
    const el = draft.layout.elements.find((e) => e.id === selectedId);
    if (!el) return;
    addElement({ ...el, id: uid(), x: round(el.x + 3), y: round(el.y + 3) });
  };

  // ── keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.closest?.('[role="dialog"], [role="alertdialog"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (!selectedId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeSelected();
      }
      const step = e.shiftKey ? 5 : 0.5;
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const delta = arrows[e.key];
      if (delta) {
        e.preventDefault();
        const current =
          selectedId === QR_ID
            ? draft.layout.qr
            : draft.layout.elements.find((x) => x.id === selectedId);
        if (current) {
          patchElement(selectedId, {
            x: Math.max(0, round(current.x + delta[0])),
            y: Math.max(0, round(current.y + delta[1])),
          });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useUnsavedChangesGuard(dirty);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setStageWidth(el.clientWidth));
    observer.observe(el);
    setStageWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // ── save ─────────────────────────────────────────────────────────────────
  const save = async () => {
    setSaving(true);
    try {
      const result = await saveTicketTemplateAction(props.templateId, {
        name: draft.name,
        description: draft.description,
        pageWidthMm: draft.pageWidthMm,
        pageHeightMm: draft.pageHeightMm,
        backgroundAssetId: draft.background?.id ?? null,
        layout: draft.layout,
      });
      if (result.status === 'saved') {
        setDirty(false);
        toast.success(t('saved'));
      } else {
        toast.error(
          result.code === 'VALIDATION_FAILED' ? t('errors.validation') : t('errors.save'),
        );
      }
    } catch {
      toast.error(t('errors.save'));
    } finally {
      setSaving(false);
    }
  };

  // ── image upload (logo etc.) ─────────────────────────────────────────────
  const uploadImage = async (file: File | undefined) => {
    if (!file) return;
    const body = new FormData();
    body.set('kind', 'TICKET_BACKGROUND');
    body.set('file', file);
    try {
      const res = await fetch('/api/admin/media', { method: 'POST', body });
      const json = (await res.json()) as {
        asset?: { id: string; width: number | null; height: number | null };
      };
      if (!res.ok || !json.asset) throw new Error('upload');
      const ratio =
        json.asset.width && json.asset.height ? json.asset.width / json.asset.height : 1;
      addElement(newImageElement(json.asset.id, ratio));
    } catch {
      toast.error(t('errors.upload'));
    } finally {
      if (uploadRef.current) uploadRef.current.value = '';
    }
  };

  // ── sample texts for the canvas ──────────────────────────────────────────
  const sampleVars = useMemo(() => {
    const vars: Record<string, string> = {};
    for (const [field, name] of Object.entries(TICKET_FIELD_VARIABLES)) {
      vars[name] = t(`sample.${field as keyof typeof TICKET_FIELD_VARIABLES}`);
    }
    for (const key of TICKET_LABEL_KEYS) vars[`label.${key}`] = t(`labels.${key}`);
    return vars;
  }, [t]);

  const textFor = useCallback(
    (element: TicketTextElement) => {
      const raw =
        element.field === 'STATIC_TEXT'
          ? (element.text ?? '').replace(
              /\{\{\s*([\w.]+)\s*\}\}/g,
              (_m, n: string) => sampleVars[n] ?? '',
            )
          : (sampleVars[TICKET_FIELD_VARIABLES[element.field]] ?? '');
      return element.uppercase ? raw.toLocaleUpperCase() : raw;
    },
    [sampleVars],
  );

  // ── live preview ─────────────────────────────────────────────────────────
  const preview = useLivePreview(draft, draftRef, props.eventId);

  // ── derived ──────────────────────────────────────────────────────────────
  const fitScale = Math.max(1, (stageWidth - 2) / draft.pageWidthMm);
  const scale = fitScale * zoom;
  const selectedElement =
    selectedId && selectedId !== QR_ID
      ? draft.layout.elements.find((e) => e.id === selectedId)
      : undefined;
  const coverUrl = props.coverAssetId ? `/api/media/${props.coverAssetId}` : null;
  const backgroundUrl = draft.background ? `/api/media/${draft.background.id}` : null;

  const setPage = (width: number, height: number) => commit((d) => setPageSize(d, width, height));

  const matchCover = () => {
    if (!props.coverAspect) return;
    const aspect = props.coverAspect;
    commit((d) => matchCoverDraft(d, aspect));
  };

  const presetValue =
    PRESETS.find((p) => p.width === draft.pageWidthMm && p.height === draft.pageHeightMm)?.key ??
    'custom';

  const fieldOptions = TICKET_FIELD_KEYS.map((key) => ({ value: key, label: t(`fields.${key}`) }));

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1 space-y-1">
          <Label htmlFor="td-name">{t('name')}</Label>
          <Input
            id="td-name"
            value={draft.name}
            maxLength={120}
            onChange={(e) => commit((d) => ({ ...d, name: e.target.value }), false)}
          />
        </label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t('undo')}
            onClick={undo}
            disabled={past.length === 0}
          >
            <Undo2 className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t('redo')}
            onClick={redo}
            disabled={future.length === 0}
          >
            <Redo2 className="size-4" />
          </Button>
          <Button type="button" onClick={save} disabled={saving || draft.name.trim() === ''}>
            <Save className="size-4" />
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
        {dirty && <span className="pb-2 text-xs text-warning">{t('unsaved')}</span>}
      </div>

      <div className="grid gap-4 xl:grid-cols-[13rem_minmax(0,1fr)_19rem]">
        <ToolsPanel
          pageWidthMm={draft.pageWidthMm}
          hasSelectedElement={!!selectedElement}
          uploadRef={uploadRef}
          addElement={addElement}
          onUpload={(file) => void uploadImage(file)}
          selectQr={setSelectedId}
          duplicate={duplicate}
          move={move}
          removeSelected={removeSelected}
        />

        {/* Canvas */}
        <div className="min-w-0 space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {draft.pageWidthMm} × {draft.pageHeightMm} mm
            </span>
            <span className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t('zoomOut')}
                onClick={() => setZoom((z) => Math.max(0.4, round(z - 0.2)))}
              >
                <ZoomOut className="size-4" />
              </Button>
              <button type="button" className="w-12 tabular-nums" onClick={() => setZoom(1)}>
                {Math.round(zoom * 100)} %
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t('zoomIn')}
                onClick={() => setZoom((z) => Math.min(3, round(z + 0.2)))}
              >
                <ZoomIn className="size-4" />
              </Button>
            </span>
          </div>
          <div ref={wrapRef} className="overflow-auto rounded-md border bg-muted/40 p-0">
            <div className="inline-block shadow-md" style={{ width: draft.pageWidthMm * scale }}>
              <DesignerCanvas
                pageWidthMm={draft.pageWidthMm}
                pageHeightMm={draft.pageHeightMm}
                layout={draft.layout}
                backgroundUrl={backgroundUrl}
                coverUrl={coverUrl}
                textFor={textFor}
                selectedId={selectedId}
                scale={scale}
                coverLabel={t('coverPlaceholder')}
                onSelect={setSelectedId}
                onChange={patchElement}
              />
            </div>
          </div>
        </div>

        {/* Properties */}
        <Card className="h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {selectedId === QR_ID
                ? t('props.qr')
                : selectedElement
                  ? t(`props.${selectedElement.kind}`)
                  : t('props.page')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!selectedId && (
              <PageProps
                draft={draft}
                presetValue={presetValue}
                canMatchCover={props.coverAspect !== null}
                onPreset={(key) => {
                  const p = PRESETS.find((x) => x.key === key);
                  if (p) setPage(p.width, p.height);
                  if (key === 'cover') matchCover();
                }}
                onSize={setPage}
                onBackground={(asset) => commit((d) => ({ ...d, background: asset }))}
                onDescription={(description) => commit((d) => ({ ...d, description }), false)}
              />
            )}
            {selectedId === QR_ID && (
              <QrProps qr={draft.layout.qr} onChange={(patch) => patchElement(QR_ID, patch)} />
            )}
            {selectedElement && (
              <ElementProps
                element={selectedElement}
                fieldOptions={fieldOptions}
                baseLocale={props.baseLocale}
                translationLocales={props.translationLocales}
                onChange={(patch) => patchElement(selectedElement.id, patch)}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                const fresh = defaultTicketDesign(props.coverAspect ?? undefined);
                commit((d) => ({
                  ...d,
                  layout: fresh.layout,
                  pageWidthMm: fresh.pageWidthMm,
                  pageHeightMm: fresh.pageHeightMm,
                }));
                setSelectedId(null);
              }}
            >
              {t('resetToDefault')}
            </Button>
          </CardContent>
        </Card>
      </div>

      <PreviewCard
        eventId={props.eventId}
        events={props.events}
        previewEvent={preview.previewEvent}
        setPreviewEvent={preview.setPreviewEvent}
        autoPreview={preview.autoPreview}
        setAutoPreview={preview.setAutoPreview}
        previewUrl={preview.previewUrl}
        previewBusy={preview.previewBusy}
        previewError={preview.previewError}
        refreshPreview={preview.refreshPreview}
      />
    </div>
  );
}
