import { z } from 'zod';

// Runs before the app's client modules. Zod decides on JIT when a schema is constructed, and
// client components build schemas at module load, so `jitless` must be set before any of them
// (see packages/shared/src/zod-config.ts for why: the eval probe trips the CSP).
z.config({ jitless: true });
