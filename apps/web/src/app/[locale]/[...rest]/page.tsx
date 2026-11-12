import { notFound } from 'next/navigation';

/** Unknown URLs below a locale render the branded `[locale]/not-found.tsx`. */
export default function CatchAllPage(): never {
  notFound();
}
