'use client';

import { moveItem } from '@tix/shared';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { IDLE } from '@/lib/action-state';
import { cn } from '@/lib/utils';
import { resetShopOrderAction, saveShopOrderAction } from '@/server/admin/shop-order';
import { ActionFeedback, ActionForm, SubmitButton } from './form-controls';

export interface ShopOrderItem {
  id: string;
  title: string;
  when: string;
  venue: string;
  startsAtMs: number;
}

export function ShopOrderEditor({ initial }: { initial: ShopOrderItem[] }) {
  const t = useTranslations('admin.shopOrder');
  const [items, setItems] = useState(initial);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [saveState, save] = useActionState(saveShopOrderAction, IDLE);
  const [resetState, reset] = useActionState(resetShopOrderAction, IDLE);

  const move = (from: number, to: number) => setItems((list) => moveItem(list, from, to));
  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };

  return (
    <div className="space-y-4">
      <ActionFeedback state={saveState} />
      <ActionFeedback state={resetState} />
      {items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ol className="space-y-2">
          {items.map((item, i) => (
            <li
              key={item.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', item.id);
                setDragging(i);
              }}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                if (dragging === null) return;
                e.preventDefault();
                setOver(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null && dragging !== i) move(dragging, i);
                endDrag();
              }}
              className={cn(
                'flex cursor-grab items-center gap-3 rounded-lg border bg-card p-3 shadow-xs active:cursor-grabbing',
                dragging === i && 'opacity-50',
                over === i && dragging !== i && 'shadow-[inset_0_3px_0_var(--primary)]',
              )}
            >
              <GripVertical className="size-4 shrink-0 text-muted-foreground" />
              <span className="w-6 shrink-0 text-right text-sm text-muted-foreground">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {item.when} · {item.venue}
                </p>
              </div>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={i === 0}
                aria-label={t('moveUp', { title: item.title })}
                title={t('moveUp', { title: item.title })}
                onClick={() => move(i, i - 1)}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={i === items.length - 1}
                aria-label={t('moveDown', { title: item.title })}
                title={t('moveDown', { title: item.title })}
                onClick={() => move(i, i + 1)}
              >
                <ArrowDown />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap gap-2">
        <ActionForm action={save}>
          <input type="hidden" name="order" value={JSON.stringify(items.map((i) => i.id))} />
          <SubmitButton pendingLabel={t('saving')}>{t('save')}</SubmitButton>
        </ActionForm>
        <ActionForm
          action={() => {
            reset();
            setItems((list) => [...list].sort((a, b) => a.startsAtMs - b.startsAtMs));
          }}
        >
          <SubmitButton variant="outline" pendingLabel={t('saving')}>
            {t('reset')}
          </SubmitButton>
        </ActionForm>
      </div>
    </div>
  );
}
