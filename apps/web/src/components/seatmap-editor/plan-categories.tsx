'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ColorField, PanelSection, TextField } from './fields';
import type { Doc } from './model';

type Apply = (update: (doc: Doc) => Doc, coalesceKey?: string) => void;

const PALETTE = ['#2563EB', '#DC2626', '#16A34A', '#D97706', '#7C3AED', '#0891B2', '#DB2777'];

/**
 * Plan categories of a master plan (name + colour, no prices). Assigned to blocks and seats like
 * price categories; when an event is created from the plan they become its price categories.
 */
export function PlanCategoriesSection({ doc, apply }: { doc: Doc; apply: Apply }) {
  const t = useTranslations('editor');
  const patch = (id: string, change: Partial<Doc['categories'][number]>, key: string) =>
    apply(
      (d) => ({
        ...d,
        categories: d.categories.map((c) => (c.id === id ? { ...c, ...change } : c)),
      }),
      `category:${id}:${key}`,
    );
  const remove = (id: string) =>
    apply((d) => ({
      ...d,
      categories: d.categories.filter((c) => c.id !== id),
      sections: d.sections.map((s) =>
        s.priceCategoryId === id ? { ...s, priceCategoryId: null } : s,
      ),
      seats: d.seats.map((s) => (s.priceCategoryId === id ? { ...s, priceCategoryId: null } : s)),
    }));
  const add = () =>
    apply((d) => {
      const names = new Set(d.categories.map((c) => c.name.toLowerCase()));
      let n = d.categories.length + 1;
      while (names.has(`${t('planCategories.defaultName')} ${n}`.toLowerCase())) n += 1;
      return {
        ...d,
        categories: [
          ...d.categories,
          {
            id: crypto.randomUUID(),
            name: `${t('planCategories.defaultName')} ${n}`,
            color: PALETTE[d.categories.length % PALETTE.length]!,
            sortOrder: d.categories.length,
            translations: {},
          },
        ],
      };
    });
  return (
    <PanelSection title={t('planCategories.title')}>
      <p className="text-xs text-muted-foreground">{t('planCategories.help')}</p>
      {doc.categories.map((c) => (
        <div key={c.id} className="space-y-2 rounded-md border p-2">
          <TextField
            label={t('planCategories.name')}
            value={c.name}
            maxLength={120}
            onChange={(name) => patch(c.id, { name }, 'name')}
          />
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <ColorField
                label={t('planCategories.color')}
                value={c.color}
                onChange={(color) => color && patch(c.id, { color }, 'color')}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('planCategories.remove')}
              onClick={() => remove(c.id)}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus /> {t('planCategories.add')}
      </Button>
    </PanelSection>
  );
}
