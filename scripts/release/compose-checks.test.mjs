// node --test scripts/release
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deployConfigProblems,
  releaseComposeProblems,
  s3ExampleProblems,
  stripMaintainerBlock,
} from './compose-checks.mjs';

const good = () => ({
  services: {
    tix: {
      image: 'ghcr.io/owner/tix:stable',
      environment: { TIX_COMPOSE_VERSION: '1.0.0' },
      ports: [{ target: 8080, published: '8080' }],
      volumes: [{ type: 'volume', source: 'tix-data', target: '/data' }],
      depends_on: {
        postgres: { condition: 'service_healthy' },
        redis: { condition: 'service_healthy' },
      },
    },
    postgres: {
      healthcheck: { test: ['CMD-SHELL', 'pg_isready'] },
      volumes: [{ type: 'volume', source: 'postgres-data', target: '/var/lib/postgresql' }],
    },
    redis: { healthcheck: { test: ['CMD-SHELL', 'redis-cli ping'] } },
  },
  volumes: { 'tix-data': {}, 'postgres-data': {}, 'redis-data': {} },
});

test('a correct three-service config has no problems', () => {
  assert.deepEqual(deployConfigProblems(good()), []);
});

test('extra services, embedded configs and changed volume keys are reported', () => {
  const c = good();
  c.services.proxy = {};
  c.configs = { caddyfile: { content: 'x' } };
  delete c.volumes['redis-data'];
  const problems = deployConfigProblems(c).join('\n');
  assert.match(problems, /services must be exactly/);
  assert.match(problems, /must not embed configs/);
  assert.match(problems, /volumes must be exactly/);
});

test('image, build, port and dependency rules', () => {
  const c = good();
  c.services.tix.image = 'ghcr.io/owner/tix-web:stable';
  c.services.tix.build = { context: '.' };
  c.services.tix.ports = [];
  c.services.tix.depends_on.redis.condition = 'service_started';
  c.services.redis.ports = [{ target: 6379 }];
  const problems = deployConfigProblems(c).join('\n');
  assert.match(problems, /tix image must be ghcr\.io\/owner\/tix:/);
  assert.match(problems, /must not be built/);
  assert.match(problems, /publish container port 8080/);
  assert.match(problems, /wait for redis/);
  assert.match(problems, /redis must not publish host ports/);
});

test('the PostgreSQL 18 data path is part of the contract', () => {
  const c = good();
  c.services.postgres.volumes[0].target = '/var/lib/postgresql/data';
  assert.match(deployConfigProblems(c).join('\n'), /\/var\/lib\/postgresql/);
});

test('the S3 example must switch the driver and add minio', () => {
  assert.deepEqual(s3ExampleProblems({ services: { tix: {} }, volumes: {} }).length > 0, true);
  const ok = {
    services: {
      tix: {
        environment: {
          STORAGE_DRIVER: 's3',
          S3_ENDPOINT: 'http://minio:9000',
          S3_BUCKET_ASSETS: 'a',
          S3_BUCKET_DOCUMENTS: 'd',
          S3_BUCKET_BACKUPS: 'b',
        },
      },
      minio: {},
      'minio-init': {},
    },
    volumes: { 'minio-data': {} },
  };
  assert.deepEqual(s3ExampleProblems(ok), []);
});

test('leftover placeholders and the maintainer block are caught', () => {
  assert.deepEqual(releaseComposeProblems('image: ghcr.io/o/tix:1'), []);
  assert.match(releaseComposeProblems('x: __TIX_VERSION__').join(), /unreplaced markers/);
  assert.match(releaseComposeProblems('ghcr.io/TIX_IMAGE_OWNER_DEFAULT/tix').join(), /OWNER/);
  const text = '# a\n# MAINTAINER-BEGIN\n# note\n# MAINTAINER-END\n\nname: x\n';
  assert.equal(stripMaintainerBlock(text), '# a\nname: x\n');
  assert.deepEqual(releaseComposeProblems(stripMaintainerBlock(text)), []);
});
