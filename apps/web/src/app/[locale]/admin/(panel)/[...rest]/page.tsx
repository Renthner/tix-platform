import { notFound } from 'next/navigation';

/** Unknown admin URLs: renders the admin not-found page inside the admin layout (auth runs first). */
export default function AdminCatchAll(): never {
  notFound();
}
