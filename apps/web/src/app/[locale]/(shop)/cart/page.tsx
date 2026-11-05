import { getTranslations } from 'next-intl/server';
import { CartView } from '@/components/shop/cart-view';
import { resolveLocale } from '@/i18n/locale';

export async function generateMetadata() {
  const t = await getTranslations('cart');
  return { title: t('title'), robots: { index: false } };
}

export default async function CartPage({ params }: { params: Promise<{ locale: string }> }) {
  await resolveLocale(params);
  const t = await getTranslations('cart');
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <CartView />
    </div>
  );
}
