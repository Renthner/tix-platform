import { z } from 'zod';

/**
 * Zod probes `new Function("")` to decide whether it may JIT-compile object parsers. Under our
 * CSP (no `script-src 'unsafe-eval'`) that probe raises a violation report in the browser, so
 * JIT is switched off everywhere. Imported first by `index.ts`; keep it the first import there.
 */
z.config({ jitless: true });
