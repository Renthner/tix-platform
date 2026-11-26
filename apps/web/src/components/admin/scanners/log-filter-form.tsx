'use client';

import { AutoSubmitForm, FilterSearchInput } from '../auto-submit-form';
import { NativeSelect } from '../form-controls';

interface Option {
  value: string;
  label: string;
}

/** Page size of the scan journal that stays out of the URL. */
const DEFAULT_SIZE = 25;

/**
 * Filters of the scan journal. Everything lives in the URL (`result`, `device`, `logQ`, `logSize`);
 * every change resets the page and replaces the URL (`AutoSubmitForm`), the search is debounced.
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
  // The selects are uncontrolled: remounted when the URL changes their value.
  const selectsKey = JSON.stringify([result, device, size]);
  return (
    <AutoSubmitForm
      className="flex flex-wrap items-end gap-2"
      resetKey={selectsKey}
      debounceMs={300}
    >
      <label className="space-y-1 text-xs">
        <span className="block text-muted-foreground">{labels.search}</span>
        <FilterSearchInput
          name="logQ"
          value={q}
          placeholder={labels.searchPlaceholder}
          className="w-64"
        />
      </label>
      <div key={selectsKey} className="contents">
        <label className="space-y-1 text-xs">
          <span className="block text-muted-foreground">{labels.result}</span>
          <NativeSelect name="result" defaultValue={result} className="w-56">
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
          <NativeSelect name="device" defaultValue={device} className="w-48">
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
            name="logSize"
            defaultValue={size === DEFAULT_SIZE ? '' : String(size)}
            className="w-24"
          >
            {pageSizes.map((n) => (
              <option key={n} value={n === DEFAULT_SIZE ? '' : n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
    </AutoSubmitForm>
  );
}
