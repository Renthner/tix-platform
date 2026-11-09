'use client';

import {
  TICKET_FIELD_KEYS,
  TICKET_FIELD_VARIABLES,
  TICKET_FONT_FAMILIES,
  TICKET_LABEL_KEYS,
  DEFAULT_TICKET_PAGE_MM,
  defaultTicketDesign,
  type TicketLayout,
  type TicketLayoutElement,
  type TicketTextElement,
} from '@tix/shared';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  ImagePlus,
  Minus,
  Redo2,
  RefreshCw,
  Save,
  Square,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
  Image as ImageIcon,
  QrCode,
  TextCursorInput,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { MediaPicker, type MediaPickerAsset } from '@/components/admin/media-picker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { saveTicketTemplateAction } from '@/server/admin/ticket-templates';
import { DesignerCanvas, QR_ID, type ElementPatch } from './canvas';

/**
 * Visual ticket designer: Konva canvas at millimetre scale, properties panel, page size
 * presets and a live PDF preview rendered by the server (the same renderer as real tickets).
 * The whole draft lives in client state, so nothing is lost on validation or network errors.
 */

export interface DesignerEventOption {
  id: string;
  title: string;
}

export interface TicketDesignerProps {
  templateId: string;
  initial: {
    name: string;
    description: string | null;
    pageWidthMm: number;
    pageHeightMm: number;
    background: MediaPickerAsset | null;
    layout: TicketLayout;
  };
  /** Event the template belongs to (library templates: null). */
  eventId: string | null;
  /** Cover image of that event for the canvas. */
  coverAssetId: string | null;
  /** Cover aspect ratio (width / height) for the "match cover" preset. */
  coverAspect: number | null;
  /** Events offered as preview data source (library templates). */
  events: DesignerEventOption[];
}

type Draft = TicketDesignerProps['initial'];

const HISTORY_LIMIT = 60;
const uid = () => Math.random().toString(36).slice(2, 10);
const round = (n: number) => Math.round(n * 100) / 100;

const PRESETS = [
  { key: 'default', width: DEFAULT_TICKET_PAGE_MM.width, height: DEFAULT_TICKET_PAGE_MM.height },
  { key: 'a6', width: 148, height: 105 },
  { key: 'wide', width: 210, height: 99 },
  { key: 'a5', width: 210, height: 148 },
  { key: 'portrait', width: 100, height: 210 },
] as const;

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.5,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={text}
        className="h-8 px-2"
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) onChange(round(n));
        }}
      />
    </label>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <select
        className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ColorField({
  label,
  value,
  onChange,
  clearable,
  clearLabel,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  clearable?: boolean;
  clearLabel?: string;
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={label}
          value={value ?? '#000000'}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-8 w-10 cursor-pointer rounded border bg-transparent p-0.5"
        />
        {clearable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            disabled={value === undefined}
            onClick={() => onChange(undefined)}
          >
            {clearLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

function PanelGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </div>
      {children}
    </div>
  );
}

export function TicketDesigner(props: TicketDesignerProps) {
  const t = useTranslations('ticketDesigner');
  const locale = useLocale();
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

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

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
      const width = 30;
      addElement({
        kind: 'image',
        id: uid(),
        assetId: json.asset.id,
        x: 10,
        y: 10,
        width,
        height: round(width / ratio),
        rotation: 0,
        opacity: 1,
      });
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
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [autoPreview, setAutoPreview] = useState(true);
  const [previewEvent, setPreviewEvent] = useState<string>(props.eventId ?? '');
  const previewSeq = useRef(0);

  const refreshPreview = useCallback(async () => {
    const seq = (previewSeq.current += 1);
    setPreviewBusy(true);
    setPreviewError(false);
    try {
      const d = draftRef.current;
      const res = await fetch('/api/admin/ticket-templates/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageWidthMm: d.pageWidthMm,
          pageHeightMm: d.pageHeightMm,
          backgroundAssetId: d.background?.id ?? null,
          layout: d.layout,
          eventId: previewEvent || null,
          locale: locale === 'de' ? 'de' : 'en',
        }),
      });
      if (!res.ok) throw new Error('preview');
      const blob = await res.blob();
      if (seq !== previewSeq.current) return;
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
    } catch {
      if (seq === previewSeq.current) setPreviewError(true);
    } finally {
      if (seq === previewSeq.current) setPreviewBusy(false);
    }
  }, [locale, previewEvent]);

  useEffect(() => {
    if (!autoPreview) return;
    const timer = setTimeout(() => void refreshPreview(), 900);
    return () => clearTimeout(timer);
  }, [draft, autoPreview, refreshPreview]);

  useEffect(
    () => () => {
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
    },
    [],
  );

  // ── derived ──────────────────────────────────────────────────────────────
  const fitScale = Math.max(1, (stageWidth - 2) / draft.pageWidthMm);
  const scale = fitScale * zoom;
  const selectedElement =
    selectedId && selectedId !== QR_ID
      ? draft.layout.elements.find((e) => e.id === selectedId)
      : undefined;
  const coverUrl = props.coverAssetId ? `/api/media/${props.coverAssetId}` : null;
  const backgroundUrl = draft.background ? `/api/media/${draft.background.id}` : null;

  const setPage = (width: number, height: number) =>
    commit((d) => ({
      ...d,
      pageWidthMm: Math.min(2000, Math.max(20, width)),
      pageHeightMm: Math.min(2000, Math.max(20, height)),
    }));

  /** Cover band at the page width with the cover's aspect; everything below moves with it. */
  const matchCover = () => {
    if (!props.coverAspect) return;
    commit((d) => {
      const width = d.pageWidthMm;
      const band = round(width / props.coverAspect!);
      const cover = d.layout.elements.find((e) => e.kind === 'cover');
      const oldBand = cover ? cover.y + cover.height : 0;
      const delta = round(band - oldBand);
      const shift = <T extends { y: number }>(item: T): T => ({
        ...item,
        y: Math.max(0, round(item.y + delta)),
      });
      const elements = d.layout.elements.map((e) =>
        e.id === cover?.id
          ? ({ ...e, x: 0, y: 0, width, height: band } as TicketLayoutElement)
          : shift(e),
      );
      return {
        ...d,
        pageHeightMm: Math.min(2000, Math.max(20, round(d.pageHeightMm + delta))),
        layout: {
          ...d.layout,
          qr: shift(d.layout.qr),
          elements: cover
            ? elements
            : [
                {
                  kind: 'cover',
                  id: uid(),
                  x: 0,
                  y: 0,
                  width,
                  height: band,
                  fit: 'cover',
                  opacity: 1,
                } as TicketLayoutElement,
                ...elements,
              ],
        },
      };
    });
  };

  const presetValue =
    PRESETS.find((p) => p.width === draft.pageWidthMm && p.height === draft.pageHeightMm)?.key ??
    'custom';

  const tool = (icon: ReactNode, label: string, onClick: () => void, disabled = false) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="justify-start gap-2"
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      {label}
    </Button>
  );

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
        {dirty && <span className="pb-2 text-xs text-amber-600">{t('unsaved')}</span>}
      </div>

      <div className="grid gap-4 xl:grid-cols-[13rem_minmax(0,1fr)_19rem]">
        {/* Tools */}
        <div className="flex flex-col gap-2">
          <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t('tools.add')}
          </div>
          {tool(<Type className="size-4" />, t('tools.field'), () =>
            addElement({
              kind: 'text',
              id: uid(),
              field: 'EVENT_TITLE',
              x: 10,
              y: 10,
              width: 80,
              height: 8,
              rotation: 0,
              fontFamily: 'Noto Sans',
              fontSize: 14,
              fontWeight: 'normal',
              color: '#111111',
              align: 'left',
              uppercase: false,
            }),
          )}
          {tool(<TextCursorInput className="size-4" />, t('tools.staticText'), () =>
            addElement({
              kind: 'text',
              id: uid(),
              field: 'STATIC_TEXT',
              text: t('tools.staticDefault'),
              x: 10,
              y: 10,
              width: 80,
              height: 8,
              rotation: 0,
              fontFamily: 'Noto Sans',
              fontSize: 10,
              fontWeight: 'normal',
              color: '#111111',
              align: 'left',
              uppercase: false,
            }),
          )}
          {tool(<Square className="size-4" />, t('tools.rect'), () =>
            addElement({
              kind: 'shape',
              id: uid(),
              shape: 'rect',
              x: 10,
              y: 10,
              width: 40,
              height: 10,
              fill: '#E5E7EB',
              strokeWidth: 0.3,
            }),
          )}
          {tool(<Minus className="size-4" />, t('tools.line'), () =>
            addElement({
              kind: 'shape',
              id: uid(),
              shape: 'line',
              x: 10,
              y: 10,
              width: 60,
              height: 0,
              stroke: '#9CA3AF',
              strokeWidth: 0.3,
            }),
          )}
          {tool(<ImageIcon className="size-4" />, t('tools.cover'), () =>
            addElement({
              kind: 'cover',
              id: uid(),
              x: 0,
              y: 0,
              width: draft.pageWidthMm,
              height: round(draft.pageWidthMm * 0.3),
              fit: 'cover',
              opacity: 1,
            }),
          )}
          {tool(<ImagePlus className="size-4" />, t('tools.image'), () =>
            uploadRef.current?.click(),
          )}
          <input
            ref={uploadRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => void uploadImage(e.target.files?.[0])}
          />
          <div className="mt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t('tools.selection')}
          </div>
          {tool(<QrCode className="size-4" />, t('tools.selectQr'), () => setSelectedId(QR_ID))}
          {tool(<Copy className="size-4" />, t('tools.duplicate'), duplicate, !selectedElement)}
          {tool(
            <ArrowUp className="size-4" />,
            t('tools.forward'),
            () => move(1),
            !selectedElement,
          )}
          {tool(
            <ArrowDown className="size-4" />,
            t('tools.backward'),
            () => move(-1),
            !selectedElement,
          )}
          {tool(<Trash2 className="size-4" />, t('tools.delete'), removeSelected, !selectedElement)}
          <p className="text-xs text-muted-foreground">{t('tools.keys')}</p>
        </div>

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

      {/* Live preview */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 pb-2">
          <CardTitle className="text-base">{t('preview.title')}</CardTitle>
          <div className="flex flex-wrap items-center gap-3">
            {!props.eventId && props.events.length > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t('preview.data')}</span>
                <select
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={previewEvent}
                  onChange={(e) => setPreviewEvent(e.target.value)}
                >
                  <option value="">{t('preview.sample')}</option>
                  {props.events.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={autoPreview} onCheckedChange={setAutoPreview} />
              {t('preview.auto')}
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refreshPreview()}
              disabled={previewBusy}
            >
              <RefreshCw className={previewBusy ? 'size-4 animate-spin' : 'size-4'} />
              {t('preview.refresh')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {previewError && <p className="mb-2 text-sm text-destructive">{t('preview.error')}</p>}
          <p className="mb-2 text-xs text-muted-foreground">{t('preview.hint')}</p>
          {previewUrl ? (
            <iframe
              title={t('preview.title')}
              src={`${previewUrl}#toolbar=0&navpanes=0`}
              className="h-[34rem] w-full rounded-md border bg-muted/30"
            />
          ) : (
            <div className="flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
              {previewBusy ? t('preview.loading') : t('preview.empty')}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PageProps({
  draft,
  presetValue,
  canMatchCover,
  onPreset,
  onSize,
  onBackground,
  onDescription,
}: {
  draft: Draft;
  presetValue: string;
  canMatchCover: boolean;
  onPreset: (key: string) => void;
  onSize: (w: number, h: number) => void;
  onBackground: (asset: MediaPickerAsset | null) => void;
  onDescription: (value: string) => void;
}) {
  const t = useTranslations('ticketDesigner');
  const options = [
    ...PRESETS.map((p) => ({
      value: p.key as string,
      label: t(`presets.${p.key}`, { w: p.width, h: p.height }),
    })),
    ...(canMatchCover ? [{ value: 'cover', label: t('presets.cover') }] : []),
    { value: 'custom', label: t('presets.custom') },
  ];
  return (
    <>
      <PanelGroup title={t('props.pageSize')}>
        <Select
          label={t('presets.label')}
          value={presetValue}
          options={options}
          onChange={onPreset}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t('props.width')}
            value={draft.pageWidthMm}
            min={20}
            max={2000}
            onChange={(v) => onSize(v, draft.pageHeightMm)}
          />
          <NumberField
            label={t('props.height')}
            value={draft.pageHeightMm}
            min={20}
            max={2000}
            onChange={(v) => onSize(draft.pageWidthMm, v)}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('props.sizeHint')}</p>
      </PanelGroup>
      <PanelGroup title={t('props.background')}>
        <MediaPicker
          name="backgroundAssetId"
          kind="TICKET_BACKGROUND"
          initialAsset={draft.background}
          aspectRatio={draft.pageWidthMm / draft.pageHeightMm}
          previewClassName="max-w-full"
          fit="cover"
          onChange={onBackground}
        />
        <p className="text-xs text-muted-foreground">{t('props.backgroundHint')}</p>
      </PanelGroup>
      <PanelGroup title={t('props.description')}>
        <Textarea
          rows={2}
          maxLength={500}
          defaultValue={draft.description ?? ''}
          onChange={(e) => onDescription(e.target.value)}
        />
      </PanelGroup>
      <p className="text-xs text-muted-foreground">
        {t('props.placeholders', { example: '{{eventTitle}}' })}
      </p>
    </>
  );
}

function QrProps({
  qr,
  onChange,
}: {
  qr: TicketLayout['qr'];
  onChange: (patch: ElementPatch) => void;
}) {
  const t = useTranslations('ticketDesigner.props');
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="X (mm)" value={qr.x} min={0} onChange={(x) => onChange({ x })} />
        <NumberField label="Y (mm)" value={qr.y} min={0} onChange={(y) => onChange({ y })} />
        <NumberField
          label={t('size')}
          value={qr.size}
          min={10}
          max={300}
          onChange={(size) => onChange({ size })}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select
          label={t('errorCorrection')}
          value={qr.errorCorrection}
          options={(['L', 'M', 'Q', 'H'] as const).map((v) => ({ value: v, label: v }))}
          onChange={(errorCorrection) => onChange({ errorCorrection })}
        />
        <NumberField
          label={t('margin')}
          value={qr.margin}
          min={0}
          max={10}
          step={1}
          onChange={(margin) => onChange({ margin: Math.round(margin) })}
        />
        <ColorField
          label={t('foreground')}
          value={qr.foreground}
          onChange={(v) => v && onChange({ foreground: v })}
        />
        <ColorField
          label={t('qrBackground')}
          value={qr.background}
          onChange={(v) => v && onChange({ background: v })}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('qrHint')}</p>
    </div>
  );
}

const PLACEHOLDER_NAME_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Free-text editor with a placeholder picker (inserts `{{name}}` at the cursor). */
function StaticTextField({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const t = useTranslations('ticketDesigner');
  const tp = useTranslations('ticketDesigner.props');
  const ref = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);

  const fieldItems = (
    Object.entries(TICKET_FIELD_VARIABLES) as [keyof typeof TICKET_FIELD_VARIABLES, string][]
  ).map(([field, name]) => ({
    name,
    label: t(`fields.${field}`),
    example: t(`sample.${field}`),
  }));
  const labelItems = TICKET_LABEL_KEYS.map((key) => ({
    name: `label.${key}`,
    label: t(`labels.${key}`),
    example: t(`labels.${key}`),
  }));

  const known = new Set([...fieldItems, ...labelItems].map((i) => i.name));
  const unknown = [
    ...new Set(
      [...value.matchAll(PLACEHOLDER_NAME_RE)].map((m) => m[1] ?? '').filter((n) => !known.has(n)),
    ),
  ];

  const insert = (name: string) => {
    const token = `{{${name}}}`;
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    if (next.length > 2000) return;
    onChange(next);
    const caret = start + token.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const renderGroup = (title: string, items: typeof fieldItems) => (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <div className="flex flex-wrap gap-1">
        {items.map((v) => (
          <button
            key={v.name}
            type="button"
            title={`${v.label} – ${t('placeholders.example', { value: v.example })}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(v.name)}
            className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent"
          >
            {v.name}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{tp('text')}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
        >
          {t('placeholders.insert')}
        </Button>
      </div>
      <Textarea
        ref={ref}
        rows={3}
        maxLength={2000}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {open && (
        <div className="space-y-2 rounded-md border p-2">
          <p className="text-xs text-muted-foreground">
            {t('placeholders.hint', { example: '{{eventTitle}}' })}
          </p>
          {renderGroup(t('placeholders.fields'), fieldItems)}
          {renderGroup(t('placeholders.labelsGroup'), labelItems)}
        </div>
      )}
      {unknown.length > 0 && (
        <p role="alert" className="text-xs text-amber-600 dark:text-amber-500">
          {t('placeholders.unknown', { names: unknown.map((n) => `{{${n}}}`).join(', ') })}
        </p>
      )}
    </div>
  );
}

function ElementProps({
  element,
  fieldOptions,
  onChange,
}: {
  element: TicketLayoutElement;
  fieldOptions: { value: TicketTextElement['field']; label: string }[];
  onChange: (patch: ElementPatch) => void;
}) {
  const t = useTranslations('ticketDesigner.props');
  const geometry = (
    <div className="grid grid-cols-4 gap-2">
      <NumberField label="X" value={element.x} min={0} onChange={(x) => onChange({ x })} />
      <NumberField label="Y" value={element.y} min={0} onChange={(y) => onChange({ y })} />
      <NumberField
        label="W"
        value={element.width}
        min={0}
        onChange={(width) => onChange({ width })}
      />
      <NumberField
        label="H"
        value={element.height}
        min={0}
        onChange={(height) => onChange({ height })}
      />
    </div>
  );
  const rotation =
    'rotation' in element ? (
      <NumberField
        label={t('rotation')}
        value={element.rotation}
        min={-360}
        max={360}
        step={1}
        onChange={(rotation) => onChange({ rotation })}
      />
    ) : null;

  if (element.kind === 'text') {
    return (
      <div className="space-y-3">
        <Select
          label={t('field')}
          value={element.field}
          options={fieldOptions}
          onChange={(field) => onChange({ field })}
        />
        {element.field === 'STATIC_TEXT' && (
          <StaticTextField value={element.text ?? ''} onChange={(text) => onChange({ text })} />
        )}
        {geometry}
        <div className="grid grid-cols-2 gap-2">
          {rotation}
          <NumberField
            label={t('fontSize')}
            value={element.fontSize}
            min={3}
            max={200}
            step={0.5}
            onChange={(fontSize) => onChange({ fontSize })}
          />
          <Select
            label={t('fontFamily')}
            value={
              (TICKET_FONT_FAMILIES as readonly string[]).includes(element.fontFamily)
                ? element.fontFamily
                : TICKET_FONT_FAMILIES[0]
            }
            options={TICKET_FONT_FAMILIES.map((f) => ({ value: f as string, label: f }))}
            onChange={(fontFamily) => onChange({ fontFamily })}
          />
          <Select
            label={t('weight')}
            value={element.fontWeight}
            options={[
              { value: 'normal', label: t('normal') },
              { value: 'bold', label: t('bold') },
            ]}
            onChange={(fontWeight) => onChange({ fontWeight })}
          />
          <Select
            label={t('align')}
            value={element.align}
            options={[
              { value: 'left', label: t('left') },
              { value: 'center', label: t('center') },
              { value: 'right', label: t('right') },
            ]}
            onChange={(align) => onChange({ align })}
          />
          <ColorField
            label={t('color')}
            value={element.color}
            onChange={(v) => v && onChange({ color: v })}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={element.uppercase}
            onCheckedChange={(uppercase) => onChange({ uppercase })}
          />
          {t('uppercase')}
        </label>
        {['EVENT_DATE', 'EVENT_TIME', 'DOORS_TIME', 'STATIC_TEXT'].includes(element.field) && (
          <div className="grid grid-cols-2 gap-2">
            <Select
              label={t('dateStyle')}
              value={element.dateStyle ?? 'long'}
              options={(['short', 'medium', 'long', 'full'] as const).map((v) => ({
                value: v,
                label: t(`dateStyles.${v}`),
              }))}
              onChange={(dateStyle) => onChange({ dateStyle })}
            />
            <Select
              label={t('timeStyle')}
              value={element.timeStyle ?? 'short'}
              options={(['short', 'medium'] as const).map((v) => ({
                value: v,
                label: t(`timeStyles.${v}`),
              }))}
              onChange={(timeStyle) => onChange({ timeStyle })}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('fitHint')}</p>
      </div>
    );
  }
  if (element.kind === 'shape') {
    return (
      <div className="space-y-3">
        {geometry}
        <div className="grid grid-cols-2 gap-2">
          <ColorField
            label={t('fill')}
            value={element.fill}
            clearable
            clearLabel={t('none')}
            onChange={(fill) => onChange({ fill })}
          />
          <ColorField
            label={t('stroke')}
            value={element.stroke}
            clearable
            clearLabel={t('none')}
            onChange={(stroke) => onChange({ stroke })}
          />
          <NumberField
            label={t('strokeWidth')}
            value={element.strokeWidth}
            min={0}
            max={20}
            step={0.1}
            onChange={(strokeWidth) => onChange({ strokeWidth })}
          />
        </div>
      </div>
    );
  }
  if (element.kind === 'cover') {
    return (
      <div className="space-y-3">
        {geometry}
        <div className="grid grid-cols-2 gap-2">
          <Select
            label={t('fit')}
            value={element.fit}
            options={[
              { value: 'cover', label: t('fitCover') },
              { value: 'contain', label: t('fitContain') },
            ]}
            onChange={(fit) => onChange({ fit })}
          />
          <NumberField
            label={t('opacity')}
            value={element.opacity}
            min={0}
            max={1}
            step={0.1}
            onChange={(opacity) => onChange({ opacity: Math.min(1, Math.max(0, opacity)) })}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t('coverHint')}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {geometry}
      <div className="grid grid-cols-2 gap-2">
        {rotation}
        <NumberField
          label={t('opacity')}
          value={element.opacity}
          min={0}
          max={1}
          step={0.1}
          onChange={(opacity) => onChange({ opacity: Math.min(1, Math.max(0, opacity)) })}
        />
      </div>
    </div>
  );
}
