'use client';

import { seatMapDocumentSchema, type Point, type SeatMapSaveError } from '@tix/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { EditorCanvas, nudge, type CanvasHandle, type CreateRequest } from './canvas';
import {
  EntranceDialog,
  IssuesDialog,
  LabelDialog,
  RowDialog,
  SectionDialog,
  TableDialog,
  type IssueItem,
} from './dialogs';
import {
  buildRows,
  buildTable,
  computeStats,
  deleteSelection,
  newElement,
  newEntrance,
  newSection,
  normalizeCompanions,
} from './doc-ops';
import { sectionAt } from './geometry';
import {
  EMPTY_SELECTION,
  ENTITY_KINDS,
  STICKY_TOOLS,
  selectOnly,
  selectionCount,
  type Doc,
  type EntityKind,
  type Tool,
  type View,
} from './model';
import { PropertiesPanel } from './properties-panel';
import { useEditorState } from './state';
import { useSymbolImagesVersion } from './symbols';
import { StatusBar, TOOL_SHORTCUTS, ToolPalette, TopBar } from './toolbar';
import type { SeatMapEditorProps } from './types';

type Pending =
  | { kind: 'section'; request: Extract<CreateRequest, { kind: 'section' }> }
  | { kind: 'row'; request: Extract<CreateRequest, { kind: 'row' }>; sectionId: string }
  | { kind: 'table'; request: Extract<CreateRequest, { kind: 'table' }>; sectionId: string }
  | {
      kind: 'label';
      request: Extract<CreateRequest, { kind: 'element' }>;
      variant: 'TEXT' | 'EXIT' | 'FACILITY' | 'STAGE';
    }
  | { kind: 'entrance'; request: Extract<CreateRequest, { kind: 'entrance' }> };

/**
 * Re-inserts seats (and their missing parents) from the last saved document – used when
 * the server refuses to delete seats that are sold or reserved.
 */
function restoreFromSaved(doc: Doc, saved: Doc, seatIds: ReadonlySet<string>): Doc {
  const present = new Set(doc.seats.map((s) => s.id));
  const restore = saved.seats.filter((s) => seatIds.has(s.id) && !present.has(s.id));
  if (restore.length === 0) return doc;
  const sectionIds = new Set(doc.sections.map((s) => s.id));
  const rowIds = new Set(doc.rows.map((r) => r.id));
  const elementIds = new Set(doc.elements.map((e) => e.id));
  const sections = saved.sections.filter(
    (s) => !sectionIds.has(s.id) && restore.some((x) => x.sectionId === s.id),
  );
  const rows = saved.rows.filter((r) => !rowIds.has(r.id) && restore.some((x) => x.rowId === r.id));
  const elements = saved.elements.filter(
    (e) => !elementIds.has(e.id) && restore.some((x) => x.tableElementId === e.id),
  );
  return {
    ...doc,
    sections: [...doc.sections, ...sections],
    rows: [...doc.rows, ...rows],
    elements: [...doc.elements, ...elements],
    seats: [...doc.seats, ...restore],
  };
}

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function SeatMapEditor(props: SeatMapEditorProps) {
  const t = useTranslations('editor');
  const { state, dispatch, apply, select } = useEditorState(props.initialDocument);
  const { doc, selection } = state;
  const isEventMap = props.kind === 'EVENT';
  const [tool, setTool] = useState<Tool>('select');
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [pending, setPending] = useState<Pending | null>(null);
  const [issues, setIssues] = useState<IssueItem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [pointer, setPointer] = useState<Point | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);

  const dirty = doc !== state.saved;
  const categoryColors = useMemo(
    () => new Map(props.categories.map((c) => [c.id, c.color])),
    [props.categories],
  );
  const stats = useMemo(() => computeStats(doc), [doc]);
  const symbolMap = useMemo(() => new Map(props.symbols.map((s) => [s.id, s])), [props.symbols]);
  const imagesVersion = useSymbolImagesVersion();
  const modalOpen = pending !== null || issues !== null;

  // ── Unsaved changes guard ─────────────────────────────────────────────────
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (saving) return;
    const payload: Doc = { ...normalizeCompanions(doc), version: state.version };
    const parsed = seatMapDocumentSchema.safeParse(payload);
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.map((i) => ({
          path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
          message: i.message,
        })),
      );
      toast.error(t('errors.invalidLocal'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/seat-maps/${props.seatMapId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as {
        version?: number;
        error?: SeatMapSaveError;
      } | null;
      if (res.ok && typeof body?.version === 'number') {
        dispatch({ type: 'saved', doc, version: body.version });
        toast.success(t('messages.saved'));
        return;
      }
      const error = body?.error;
      switch (error?.code) {
        case 'VERSION_CONFLICT':
          toast.error(t('errors.VERSION_CONFLICT'), {
            duration: Infinity,
            action: { label: t('actions.reload'), onClick: () => window.location.reload() },
          });
          break;
        case 'SEATS_IN_USE': {
          const ids = new Set(error.seatIds ?? []);
          apply((d) => restoreFromSaved(d, state.saved, ids), undefined, selectOnly('seats', ids));
          dispatch({ type: 'highlight', ids });
          toast.error(t('errors.SEATS_IN_USE', { count: ids.size }), { duration: 10_000 });
          break;
        }
        case 'VALIDATION_FAILED':
          setIssues(error.issues?.length ? error.issues : [{ path: [], message: error.message }]);
          break;
        case 'NOT_FOUND':
          toast.error(t('errors.NOT_FOUND'));
          break;
        default:
          toast.error(t('errors.unknown'));
      }
    } catch {
      toast.error(t('errors.network'));
    } finally {
      setSaving(false);
    }
  }, [saving, doc, state.version, state.saved, props.seatMapId, dispatch, apply, t]);

  // ── Creation flow ─────────────────────────────────────────────────────────
  const finishCreation = useCallback(() => {
    setPending(null);
    if (!STICKY_TOOLS.has(tool)) setTool('select');
  }, [tool]);

  const seatedSectionFor = useCallback(
    (p: Point): string | null => {
      const hit = sectionAt(doc, p, 'SEATED');
      if (hit) return hit.id;
      const selected = [...selection.sections].find(
        (id) => doc.sections.find((s) => s.id === id)?.type === 'SEATED',
      );
      return selected ?? doc.sections.find((s) => s.type === 'SEATED')?.id ?? null;
    },
    [doc, selection.sections],
  );

  const onCreate = useCallback(
    (request: CreateRequest) => {
      switch (request.kind) {
        case 'section':
          setPending({ kind: 'section', request });
          return;
        case 'row':
        case 'table': {
          const anchor =
            request.kind === 'row'
              ? {
                  x: (request.curve.start.x + request.curve.end.x) / 2,
                  y: (request.curve.start.y + request.curve.end.y) / 2,
                }
              : request.point;
          const sectionId = seatedSectionFor(anchor);
          if (!sectionId) {
            toast.error(t('errors.needSeatedSection'));
            return;
          }
          setPending(
            request.kind === 'row'
              ? { kind: 'row', request, sectionId }
              : { kind: 'table', request, sectionId },
          );
          return;
        }
        case 'entrance':
          setPending({ kind: 'entrance', request });
          return;
        case 'element': {
          const type = request.elementType;
          if (type === 'TEXT' || type === 'EXIT' || type === 'FACILITY' || type === 'STAGE') {
            setPending({ kind: 'label', request, variant: type });
            return;
          }
          const element = newElement(type, request.geometry, doc);
          apply(
            (d) => ({ ...d, elements: [...d.elements, element] }),
            undefined,
            selectOnly('elements', [element.id]),
          );
          if (!STICKY_TOOLS.has(tool)) setTool('select');
        }
      }
    },
    [doc, apply, seatedSectionFor, t, tool],
  );

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen || isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
      } else if (mod && key === 'y') {
        e.preventDefault();
        dispatch({ type: 'redo' });
      } else if (mod && key === 's') {
        e.preventDefault();
        void save();
      } else if (mod && key === 'a') {
        e.preventDefault();
        select(
          selectOnly(
            'seats',
            doc.seats.map((s) => s.id),
          ),
        );
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectionCount(selection) === 0) return;
        e.preventDefault();
        apply((d) => deleteSelection(d, selection), undefined, EMPTY_SELECTION);
      } else if (e.key === 'Escape') {
        if (canvasRef.current?.cancel()) return;
        if (tool !== 'select') setTool('select');
        else select(EMPTY_SELECTION);
      } else if (e.key === 'Enter') {
        canvasRef.current?.finish();
      } else if (e.key.startsWith('Arrow')) {
        if (selectionCount(selection) === 0) return;
        e.preventDefault();
        const step = (doc.settings.snapToGrid ? doc.settings.gridSize : 1) * (e.shiftKey ? 10 : 1);
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        apply((d) => nudge(d, selection, dx, dy), 'nudge');
      } else if (!mod && !e.altKey) {
        if (key === 'f') canvasRef.current?.fit();
        else if (key === '+' || key === '=') canvasRef.current?.zoomBy(1.25);
        else if (key === '-') canvasRef.current?.zoomBy(0.8);
        else if (TOOL_SHORTCUTS[key]) setTool(TOOL_SHORTCUTS[key]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen, dispatch, save, select, apply, selection, doc, tool]);

  const focusIssue = (issue: IssueItem) => {
    const [collection, index] = issue.path;
    if (
      typeof collection === 'string' &&
      (ENTITY_KINDS as readonly string[]).includes(collection) &&
      typeof index === 'number'
    ) {
      const kind = collection as EntityKind;
      const entity = (doc[kind] as { id: string }[])[index];
      if (entity) select(selectOnly(kind, [entity.id]));
    }
    setIssues(null);
  };

  const hintKey = tool;

  return (
    <div className="flex h-dvh flex-col">
      <TopBar
        title={props.title}
        planName={doc.name}
        isEventMap={isEventMap}
        backHref={props.backHref}
        dirty={dirty}
        saving={saving}
        canUndo={state.past.length > 0}
        canRedo={state.future.length > 0}
        zoom={view.scale}
        onUndo={() => dispatch({ type: 'undo' })}
        onRedo={() => dispatch({ type: 'redo' })}
        onZoomIn={() => canvasRef.current?.zoomBy(1.25)}
        onZoomOut={() => canvasRef.current?.zoomBy(0.8)}
        onFit={() => canvasRef.current?.fit()}
        onSave={() => void save()}
        confirmLeave={dirty ? t('confirm.leave') : null}
      />
      <div className="flex min-h-0 flex-1">
        <ToolPalette tool={tool} onTool={setTool} />
        <div className="relative min-w-0 flex-1">
          <EditorCanvas
            ref={canvasRef}
            doc={doc}
            selection={selection}
            highlight={state.highlight}
            categoryColors={categoryColors}
            tool={tool}
            view={view}
            onViewChange={setView}
            onSelect={select}
            onApply={apply}
            onCreate={onCreate}
            onPointerWorld={setPointer}
            symbols={symbolMap}
            imagesVersion={imagesVersion}
            hiddenNameSuffix={t('canvas.hiddenName')}
          />
        </div>
        <aside
          className="w-80 shrink-0 overflow-y-auto border-l bg-background"
          aria-label={t('panel.label')}
        >
          <PropertiesPanel
            doc={doc}
            selection={selection}
            isEventMap={isEventMap}
            categories={props.categories}
            symbols={props.symbols}
            apply={apply}
            select={select}
          />
        </aside>
      </div>
      <StatusBar
        stats={stats}
        isEventMap={isEventMap}
        categories={props.categories}
        hint={t(`hints.tools.${hintKey}`)}
        selectedCount={selectionCount(selection)}
        pointer={pointer}
      />

      {pending?.kind === 'section' && (
        <SectionDialog
          doc={doc}
          onCancel={() => setPending(null)}
          onConfirm={(values) => {
            const section = newSection({ ...values, geometry: pending.request.geometry }, doc);
            apply(
              (d) => ({ ...d, sections: [...d.sections, section] }),
              undefined,
              selectOnly('sections', [section.id]),
            );
            finishCreation();
          }}
        />
      )}
      {pending?.kind === 'row' && (
        <RowDialog
          doc={doc}
          curve={pending.request.curve}
          defaultSectionId={pending.sectionId}
          onCancel={() => setPending(null)}
          onConfirm={(values) => {
            const created = buildRows(doc, { ...values, curve: pending.request.curve });
            apply(
              (d) => ({
                ...d,
                rows: [...d.rows, ...created.rows],
                seats: [...d.seats, ...created.seats],
              }),
              undefined,
              selectOnly(
                'rows',
                created.rows.map((r) => r.id),
              ),
            );
            finishCreation();
          }}
        />
      )}
      {pending?.kind === 'table' && (
        <TableDialog
          doc={doc}
          defaultSectionId={pending.sectionId}
          onCancel={() => setPending(null)}
          onConfirm={(values) => {
            const created = buildTable(doc, { ...values, center: pending.request.point });
            apply(
              (d) => ({
                ...d,
                elements: [...d.elements, created.element],
                seats: [...d.seats, ...created.seats],
              }),
              undefined,
              selectOnly('elements', [created.element.id]),
            );
            finishCreation();
          }}
        />
      )}
      {pending?.kind === 'label' && (
        <LabelDialog
          variant={pending.variant}
          onCancel={() => setPending(null)}
          onConfirm={(values) => {
            const element = newElement(pending.variant, pending.request.geometry, doc, {
              label: values.label || null,
              style: {
                ...(pending.variant === 'TEXT' || pending.variant === 'STAGE'
                  ? { fontSize: values.fontSize }
                  : {}),
                ...(values.icon ? { icon: values.icon } : {}),
              },
            });
            apply(
              (d) => ({ ...d, elements: [...d.elements, element] }),
              undefined,
              selectOnly('elements', [element.id]),
            );
            finishCreation();
          }}
        />
      )}
      {pending?.kind === 'entrance' && (
        <EntranceDialog
          doc={doc}
          onCancel={() => setPending(null)}
          onConfirm={(values) => {
            const entrance = newEntrance(values.name, values.code, pending.request.point, doc);
            apply(
              (d) => ({ ...d, entrances: [...d.entrances, entrance] }),
              undefined,
              selectOnly('entrances', [entrance.id]),
            );
            finishCreation();
          }}
        />
      )}
      {issues && (
        <IssuesDialog issues={issues} onClose={() => setIssues(null)} onFocus={focusIssue} />
      )}
    </div>
  );
}
