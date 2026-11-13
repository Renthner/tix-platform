/** Constants of the admin sales statistics shared by the server aggregation and the filter UI. */

export const STATS_RANGE_PRESETS = ['today', '7d', '30d', 'year', 'custom'] as const;
export type StatsRangePreset = (typeof STATS_RANGE_PRESETS)[number];

/** Longest range a user can ask for (days); a longer custom range is cut at its start. */
export const MAX_STATS_RANGE_DAYS = 1_100;
/** Events that can be selected at once. */
export const MAX_STATS_EVENTS = 20;
