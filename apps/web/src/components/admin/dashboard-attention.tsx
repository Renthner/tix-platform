import {
  ChevronRight,
  Clock,
  Coins,
  FileWarning,
  KeyRound,
  Landmark,
  ListChecks,
  PartyPopper,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/admin/empty-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import type { AdminTodo, AdminTodoKey } from '@/server/admin/shell';

const ICONS: Record<AdminTodoKey, LucideIcon> = {
  bankReview: Landmark,
  overdueTransfers: Clock,
  openRefunds: Undo2,
  openAdjustments: Coins,
  invoiceCorrections: FileWarning,
  waitlistPending: ListChecks,
  expiringCodes: KeyRound,
};

/**
 * "Needs attention" block of the dashboard: only the open to-dos (count > 0, same data as the
 * notification bell) as compact rows; "All clear" when there are none.
 */
export async function DashboardAttention({ todos }: { todos: readonly AdminTodo[] }) {
  const [t, tItems] = await Promise.all([
    getTranslations('admin.dashboard.attention'),
    getTranslations('admin.shell.bell.items'),
  ]);
  return (
    <Card data-testid="dashboard-attention">
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {todos.length === 0 ? (
          <EmptyState
            size="sm"
            tone="success"
            icon={PartyPopper}
            title={t('allClear')}
            description={t('allClearText')}
            data-testid="dashboard-all-clear"
          />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {todos.map((todo) => {
              const Icon = ICONS[todo.key];
              return (
                <li key={todo.key}>
                  <Link
                    href={todo.href}
                    data-testid={`dashboard-todo-${todo.key}`}
                    className="flex items-center gap-3 rounded-md border border-warning-border px-3 py-2 text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon className="size-4 shrink-0 text-warning" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{tItems(todo.key)}</span>
                    <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning tabular-nums">
                      {todo.count}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
