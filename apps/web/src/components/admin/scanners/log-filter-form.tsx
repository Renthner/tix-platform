'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Input } from '@/components/ui/input';
import { usePathname, useRouter } from '@/i18n/navigation';
import { NativeSelect } from '../form-controls';

interface Option {
  value: string;
  label: string;
}

/**
 * Filters of the scan journal. Everything lives in the URL (`result`, `device`, `logQ`, `logSize`);
 * every change resets the page and replaces the URL, the search is debounced.
 */
export function LogFilterForm({
  result,
  device,
  q,
  size,
  resultOptions,
  deviceOptions,
  pageSizes,
  labels,
}: {
  result: string;
  device: string;
  q: string;
  size: number;
  resultOptions: Option[];
  deviceOptions: Option[];
  pageSizes: number[];
  labels: {
    result: string;
    device: string;
    search: string;
    searchPlaceholder: string;
    pageSize: string;
    all: string;
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const [text, setText] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef({ result, device, q, size });
  current.current = { result, device, q, size };

  useEffect(() => {
    setText(q);
  }, [q]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const navigate = (next: Partial<{ result: string; device: string; q: string; size: number }>) => {
    const merged = { ...current.current, ...next };
    const params = new URLSearchParams();
    if (merged.result) params.set('result', merged.result);
    if (merged.device) params.set('device', merged.device);
    if (merged.q.trim()) params.set('logQ', merged.q.trim());
    if (merged.size !== 25) params.set('logSize', String(merged.size));
    const qs = params.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        navigate({ q: text });
      }}
    >
      <label className="space-y-1 text-xs">
        <span className="block text-muted-foreground">{labels.search}</span>
        <Input
          type="search"
          value={text}
          placeholder={labels.searchPlaceholder}
          className="w-64"
          onChange={(e) => {
            const value = e.target.value;
            setText(value);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => navigate({ q: value }), 300);
          }}
        />
      </label>
      <label className="space-y-1 text-xs">
        <span className="block text-muted-foreground">{labels.result}</span>
        <NativeSelect
          value={result}
          className="w-56"
          onChange={(e) => navigate({ result: e.target.value })}
        >
          <option value="">{labels.all}</option>
          {resultOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="space-y-1 text-xs">
        <span className="block text-muted-foreground">{labels.device}</span>
        <NativeSelect
          value={device}
          className="w-48"
          onChange={(e) => navigate({ device: e.target.value })}
        >
          <option value="">{labels.all}</option>
          {deviceOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="space-y-1 text-xs">
        <span className="block text-muted-foreground">{labels.pageSize}</span>
        <NativeSelect
          value={String(size)}
          className="w-24"
          onChange={(e) => navigate({ size: Number(e.target.value) })}
        >
          {pageSizes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </NativeSelect>
      </label>
    </form>
  );
}
