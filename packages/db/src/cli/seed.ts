import { createDb } from '../client';
import { loadRootEnv, requireEnv } from '../env';
import { seedReferenceData } from '../seed';

loadRootEnv();

const handle = createDb({
  connectionString: requireEnv('DATABASE_URL'),
  poolMax: 1,
  applicationName: 'tix-seed',
});

seedReferenceData(handle.db)
  .then(() => handle.close())
  .catch(async (err) => {
    console.error('[seed] failed', err);
    await handle.close();
    process.exit(1);
  });
