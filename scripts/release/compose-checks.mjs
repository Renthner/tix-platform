// Pure helpers for deploy-bundle.mjs: strip the maintainer block of the compose template and check
// the generated files. No file or process access, so they are unit-tested.

// Removes the `# MAINTAINER-BEGIN` ... `# MAINTAINER-END` block (and one following blank line).
export function stripMaintainerBlock(text) {
  return text.replace(/^# MAINTAINER-BEGIN\n[\s\S]*?^# MAINTAINER-END\n\n?/m, '');
}

// Problems that must never reach an operator in the generated compose file.
export function releaseComposeProblems(text) {
  const problems = [];
  const markers = text.match(/__[A-Z][A-Z0-9_]*__/g);
  if (markers) problems.push(`unreplaced markers: ${[...new Set(markers)].join(', ')}`);
  if (text.includes('TIX_IMAGE_OWNER_DEFAULT')) problems.push('TIX_IMAGE_OWNER_DEFAULT left in');
  if (/MAINTAINER-(BEGIN|END)|Maintainer notes/.test(text))
    problems.push('maintainer block left in');
  return problems;
}

// Volume keys are part of the upgrade contract: installations migrated from the three-image layout
// (docs/MIGRATE-SINGLE-IMAGE.md) reuse their data by declaring the same names.
export const REQUIRED_VOLUMES = ['postgres-data', 'redis-data', 'tix-data'];
export const DEPLOY_SERVICES = ['postgres', 'redis', 'tix'];

/**
 * Checks the resolved deploy compose (`docker compose config --format json`) of the main file:
 * exactly the services tix / postgres / redis, the pulled `tix` image selected by TIX_VERSION,
 * nothing built, no embedded configs, the volume keys of the upgrade contract, no host ports on
 * the data services.
 * @returns {string[]} problems (empty = fine)
 */
export function deployConfigProblems(config, { owner = 'owner', version = 'stable' } = {}) {
  const problems = [];
  const services = config.services ?? {};
  const names = Object.keys(services).sort();
  if (names.join(',') !== DEPLOY_SERVICES.join(',')) {
    problems.push(
      `services must be exactly ${DEPLOY_SERVICES.join(', ')} (found ${names.join(', ')})`,
    );
  }
  const tix = services.tix;
  if (tix) {
    if (tix.image !== `ghcr.io/${owner}/tix:${version}`) {
      problems.push(`tix image must be ghcr.io/${owner}/tix:<TIX_VERSION> (found ${tix.image})`);
    }
    if (tix.build) problems.push('tix must not be built');
    if (!tix.volumes?.some((v) => v.source === 'tix-data' && v.target === '/data')) {
      problems.push('tix must mount tix-data at /data');
    }
    if (!tix.ports?.some((p) => String(p.target) === '8080')) {
      problems.push('tix must publish container port 8080');
    }
    for (const dep of ['postgres', 'redis']) {
      if (tix.depends_on?.[dep]?.condition !== 'service_healthy') {
        problems.push(`tix must wait for ${dep} to be healthy`);
      }
    }
    if (!tix.environment?.TIX_COMPOSE_VERSION) problems.push('tix lacks TIX_COMPOSE_VERSION');
  }
  for (const name of ['postgres', 'redis']) {
    if (services[name]?.ports?.length) problems.push(`${name} must not publish host ports`);
    if (!services[name]?.healthcheck) problems.push(`${name} lacks a healthcheck`);
  }
  if (config.configs && Object.keys(config.configs).length) {
    problems.push('the compose file must not embed configs');
  }
  const volumes = Object.keys(config.volumes ?? {}).sort();
  if (volumes.join(',') !== [...REQUIRED_VOLUMES].sort().join(',')) {
    problems.push(
      `volumes must be exactly ${REQUIRED_VOLUMES.join(', ')} (found ${volumes.join(', ')})`,
    );
  }
  const pg = services.postgres?.volumes?.find((v) => v.source === 'postgres-data');
  if (pg && pg.target !== '/var/lib/postgresql') {
    problems.push('postgres-data must be mounted at /var/lib/postgresql (PostgreSQL 18 layout)');
  }
  return problems;
}

/**
 * Checks the resolved S3 example override merged with the main file: tix switches to the s3 driver
 * and every extra service/volume comes from the override only.
 * @returns {string[]} problems
 */
export function s3ExampleProblems(merged) {
  const problems = [];
  const tix = merged.services?.tix;
  if (tix?.environment?.STORAGE_DRIVER !== 's3') problems.push('tix must set STORAGE_DRIVER=s3');
  if (!tix?.environment?.S3_ENDPOINT) problems.push('tix lacks S3_ENDPOINT');
  for (const k of ['S3_BUCKET_ASSETS', 'S3_BUCKET_DOCUMENTS', 'S3_BUCKET_BACKUPS']) {
    if (!tix?.environment?.[k]) problems.push(`tix lacks ${k}`);
  }
  for (const name of ['minio', 'minio-init']) {
    if (!merged.services?.[name]) problems.push(`missing service ${name}`);
  }
  if (!merged.volumes?.['minio-data']) problems.push('missing volume minio-data');
  return problems;
}
