import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { resolveLocale } from '@/i18n/locale';
import { AuthCard } from '../../account/_components/auth-card';
import { OrderLookupForm } from './lookup-form';

export async function generateMetadata() {
  const t = await getTranslations('account.orderLookup');
  return { title: t('title'), robots: { index: false } };
}

/** Guests without an account: request the link to an order by order number + e-mail address. */
export default async function OrderLookupPage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  const t = await getTranslations('account.orderLookup');
  return (
    <AuthCard
      title={t('title')}
      description={t('description')}
      footer={
        <p>
          <Link href="/account/login" className="hover:underline">
            {t('toLogin')}
          </Link>
        </p>
      }
    >
      <OrderLookupForm />
    </AuthCard>
  );
}
