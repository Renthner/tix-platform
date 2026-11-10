import { getSetting, listGlobalFees, listTaxRatesWithUsage } from '@tix/core';
import { getTranslations } from 'next-intl/server';
import { FeesAdmin } from '@/components/admin/fees-manager';
import {
  GlobalLocaleSwitcher,
  GlobalTranslationPane,
} from '@/components/admin/global-translation-pane';
import { getEditLocale } from '@/server/admin/edit-locale';
import { PageHeader } from '@/components/admin/form-controls';
import { resolveLocale } from '@/i18n/locale';
import { hasRole, requireAdmin } from '@/server/auth';
import {
  deleteGlobalFeeAction,
  deleteTaxRateAction,
  reorderGlobalFeesAction,
  saveGlobalFeeAction,
  saveTaxRateAction,
  setGlobalFeeActiveAction,
} from '@/server/admin/fees';
import { getCore } from '@/server/core';

export async function generateMetadata() {
  const t = await getTranslations('fees');
  return { title: t('title') };
}

export default async function FeesPage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  const session = await requireAdmin(['FINANCE', 'EVENT_MANAGER']);
  const canEdit = hasRole(session, ['FINANCE']);
  const core = getCore();
  const editLocale = await getEditLocale();
  const [t, general, taxRates, fees] = await Promise.all([
    getTranslations('fees'),
    getSetting(core, 'general'),
    listTaxRatesWithUsage(core.db),
    listGlobalFees(core.db),
  ]);

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={<GlobalLocaleSwitcher scope="globalFees" />}
      />
      <div className="p-6">
        {editLocale ? (
          <GlobalTranslationPane scope="globalFees" editLocale={editLocale} />
        ) : (
          <FeesAdmin
            currency={general.defaultCurrency}
            canEdit={canEdit}
            createTaxRate={saveTaxRateAction.bind(null, null)}
            createFee={saveGlobalFeeAction.bind(null, null)}
            setFeeActive={setGlobalFeeActiveAction}
            reorderFees={reorderGlobalFeesAction}
            taxRates={taxRates.map((r) => ({
              id: r.id,
              name: r.name,
              rateBasisPoints: r.rateBasisPoints,
              invoiceNote: r.invoiceNote,
              isDefault: r.isDefault,
              isActive: r.isActive,
              sortOrder: r.sortOrder,
              eventCount: r.eventCount,
              feeCount: r.feeCount,
              save: saveTaxRateAction.bind(null, r.id),
              remove: deleteTaxRateAction.bind(null, r.id),
            }))}
            fees={fees.map((f) => ({
              id: f.id,
              name: f.name,
              scope: f.scope,
              calculation: f.calculation,
              value: f.value,
              taxRateId: f.taxRateId,
              paymentMethods: f.paymentMethods,
              channels: f.channels,
              isActive: f.isActive,
              sortOrder: f.sortOrder,
              overrideCount: f.overrideCount,
              waivedCount: f.waivedCount,
              save: saveGlobalFeeAction.bind(null, f.id),
              remove: deleteGlobalFeeAction.bind(null, f.id),
            }))}
          />
        )}
      </div>
    </>
  );
}
