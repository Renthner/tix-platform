'use client';

import {
  Armchair,
  ArrowLeft,
  Circle,
  DoorOpen,
  Hand,
  Hexagon,
  LoaderCircle,
  LogOut,
  MapPin,
  Maximize,
  Minus,
  MousePointer2,
  PenLine,
  Pentagon,
  RectangleHorizontal,
  Redo2,
  Save,
  Spline,
  Square,
  Theater,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import type { DocStats } from './doc-ops';
import type { Tool } from './model';

// ─── Top bar ────────────────────────────────────────────────────────────────

export function TopBar({
  title,
  planName,
  isEventMap,
  backHref,
  dirty,
  saving,
  canUndo,
  canRedo,
  zoom,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onFit,
  onSave,
  confirmLeave,
  localeSlot,
}: {
  title: string;
  planName: string;
  isEventMap: boolean;
  backHref: string;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onSave: () => void;
  /** Confirmation text when leaving with unsaved changes (null = no prompt). */
  confirmLeave: string | null;
  /** Content language dropdown. */
  localeSlot?: ReactNode;
}) {
  const t = useTranslations('editor.toolbar');
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3">
      <Button asChild variant="ghost" size="icon-sm" aria-label={t('back')}>
        <Link
          href={backHref}
          onClick={(e) => {
            if (confirmLeave && !window.confirm(confirmLeave)) e.preventDefault();
          }}
        >
          <ArrowLeft />
        </Link>
      </Button>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-sm font-semibold">{planName}</h1>
          <Badge variant={isEventMap ? 'default' : 'secondary'}>
            {isEventMap ? t('eventMap') : t('template')}
          </Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">{title}</p>
      </div>
      <div className="ml-auto flex items-center gap-1">
        {localeSlot}
        <IconButton
          icon={Undo2}
          label={t('undo')}
          shortcut="Ctrl+Z"
          onClick={onUndo}
          disabled={!canUndo}
        />
        <IconButton
          icon={Redo2}
          label={t('redo')}
          shortcut="Ctrl+Shift+Z"
          onClick={onRedo}
          disabled={!canRedo}
        />
        <Separator orientation="vertical" className="mx-1 h-6" />
        <IconButton icon={ZoomOut} label={t('zoomOut')} onClick={onZoomOut} />
        <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <IconButton icon={ZoomIn} label={t('zoomIn')} onClick={onZoomIn} />
        <IconButton icon={Maximize} label={t('fit')} shortcut="F" onClick={onFit} />
        <Separator orientation="vertical" className="mx-1 h-6" />
        <span
          className={cn('px-2 text-xs', dirty ? 'text-amber-600' : 'text-muted-foreground')}
          aria-live="polite"
        >
          {saving ? t('saving') : dirty ? t('unsaved') : t('saved')}
        </span>
        <Button size="sm" onClick={onSave} disabled={saving || !dirty}>
          {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
          {t('save')}
        </Button>
      </div>
    </header>
  );
}

function IconButton({
  icon: Icon,
  label,
  shortcut,
  onClick,
  disabled,
  active,
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? 'secondary' : 'ghost'}
          size="icon-sm"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          disabled={disabled}
          className={cn(active && 'ring-2 ring-primary/40')}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {shortcut && <span className="ml-2 text-muted-foreground">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

// ─── Tool palette ───────────────────────────────────────────────────────────

export const TOOL_SHORTCUTS: Readonly<Record<string, Tool>> = {
  v: 'select',
  h: 'hand',
  s: 'section-rect',
  p: 'section-polygon',
  n: 'entrance',
  r: 'row-straight',
  a: 'row-arc',
  t: 'table',
  g: 'stage',
  x: 'text',
  m: 'shape-rect',
  o: 'shape-ellipse',
  y: 'shape-polygon',
  l: 'line',
  e: 'exit',
  c: 'facility',
};

const TOOL_GROUPS: {
  group: 'navigate' | 'structure' | 'seating' | 'decoration';
  tools: [Tool, LucideIcon][];
}[] = [
  {
    group: 'navigate',
    tools: [
      ['select', MousePointer2],
      ['hand', Hand],
    ],
  },
  {
    group: 'structure',
    tools: [
      ['section-rect', Square],
      ['section-polygon', Pentagon],
      ['entrance', DoorOpen],
    ],
  },
  {
    group: 'seating',
    tools: [
      ['row-straight', Minus],
      ['row-arc', Spline],
      ['table', Armchair],
    ],
  },
  {
    group: 'decoration',
    tools: [
      ['stage', Theater],
      ['text', Type],
      ['shape-rect', RectangleHorizontal],
      ['shape-ellipse', Circle],
      ['shape-polygon', Hexagon],
      ['line', PenLine],
      ['exit', LogOut],
      ['facility', MapPin],
    ],
  },
];

const shortcutFor = (tool: Tool) =>
  Object.entries(TOOL_SHORTCUTS)
    .find(([, v]) => v === tool)?.[0]
    ?.toUpperCase();

export function ToolPalette({ tool, onTool }: { tool: Tool; onTool: (tool: Tool) => void }) {
  const t = useTranslations('editor.tools');
  return (
    <nav
      aria-label={t('label')}
      className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r bg-background py-2"
    >
      {TOOL_GROUPS.map(({ group, tools }, gi) => (
        <div key={group} className="flex flex-col items-center gap-1">
          {gi > 0 && <Separator className="my-1 w-6" />}
          {tools.map(([id, icon]) => (
            <IconButton
              key={id}
              icon={icon}
              label={t(id)}
              shortcut={shortcutFor(id)}
              active={tool === id}
              onClick={() => onTool(id)}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

// ─── Status / statistics bar ────────────────────────────────────────────────

export function StatusBar({
  stats,
  isEventMap,
  categories,
  hint,
  selectedCount,
  pointer,
}: {
  stats: DocStats;
  isEventMap: boolean;
  categories: { id: string; name: string; color: string }[];
  hint: string;
  selectedCount: number;
  pointer: { x: number; y: number } | null;
}) {
  const t = useTranslations('editor.stats');
  return (
    <footer className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t bg-background px-3 py-1.5 text-xs text-muted-foreground">
      <span className="text-foreground">{t('seats', { count: stats.seats })}</span>
      {isEventMap &&
        categories.map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-full" style={{ background: c.color }} />
            {c.name}: {stats.byCategory.get(c.id) ?? 0}
          </span>
        ))}
      {isEventMap && stats.unassigned > 0 && (
        <span className="text-amber-600">{t('unassigned', { count: stats.unassigned })}</span>
      )}
      {stats.blocked > 0 && <span>{t('blocked', { count: stats.blocked })}</span>}
      {stats.wheelchair > 0 && <span>{t('wheelchair', { count: stats.wheelchair })}</span>}
      {stats.standingCapacity > 0 && (
        <span>{t('standing', { count: stats.standingCapacity })}</span>
      )}
      <span>{t('structure', { sections: stats.sections, rows: stats.rows })}</span>
      {selectedCount > 0 && (
        <span className="text-primary">{t('selected', { count: selectedCount })}</span>
      )}
      <span className="ml-auto hidden truncate md:inline">{hint}</span>
      {pointer && (
        <span className="w-28 text-right tabular-nums">
          {Math.round(pointer.x)}, {Math.round(pointer.y)}
        </span>
      )}
    </footer>
  );
}
