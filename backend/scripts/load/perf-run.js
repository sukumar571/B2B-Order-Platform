'use strict';

/**
 * 20-virtual-user load benchmark (NFR-05 / NFR-PERF-01 / SC-07).
 *
 *   npm run perf:load          # 20 vU: 60s read mix + 60s order creation (defaults)
 *   npm run perf               # seed the benchmark dataset first, then load
 *
 * It boots the REAL Express app (src/app.js) against the isolated benchmark
 * database (b2b_oms_perf — set on process.env BEFORE src/config is required, so
 * the pool can never bind to the dev/test DB) and drives a closed-loop workload:
 * 20 concurrent in-flight requests for a fixed duration against read endpoints
 * and the transactional POST /api/orders path. It measures latency percentiles,
 * throughput and the 5xx error rate, prints a report, and writes evidence to
 * evidence/test-reports/perf-load.{json,md} including hardware/Docker context.
 *
 * Access tokens are minted in-process via token.service (as the integration
 * tests do) to keep auth out of the measured path and avoid auth rate limits.
 * NO claim of success is hardcoded: the PASS/MARGINAL/FAIL verdict is computed
 * from the measured numbers against the NFR-PERF-01 targets.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { resolvePerfDatabaseUrl } = require('./perf-config');

// ── CRITICAL: isolate the DB before any src/ require (see perf-config) ─────────
const { perfUrl, perfName } = resolvePerfDatabaseUrl();
process.env.NODE_ENV = 'test'; // test mode: pool uses DATABASE_URL_TEST, request logger off, auth rate limit skipped
process.env.DATABASE_URL_TEST = perfUrl;
process.env.DB_POOL_MAX = process.env.LOAD_DB_POOL_MAX || '30'; // headroom for 20 concurrent + reload-per-request

const { createApp } = require('../../src/app');
const { closePool } = require('../../src/db/pool');
const tokenService = require('../../src/services/token.service');

const CONCURRENCY = intEnv('LOAD_CONCURRENCY', 20);
const READS_MS = intEnv('LOAD_READS_MS', 60000);
const ORDERS_MS = intEnv('LOAD_ORDERS_MS', 60000);
const READ_P95_TARGET = intEnv('LOAD_READ_P95_MS', 500); // NFR-05: reads p95 <= 500 ms
const ORDER_P95_TARGET = intEnv('LOAD_ORDER_P95_MS', 1500); // NFR-05: order create <= 1500 ms
const ERROR_RATE_TARGET = Number(process.env.LOAD_5XX_RATE_MAX || '1'); // < 1% 5xx
const CUSTOMER_POOL = intEnv('LOAD_USERS', 20); // distinct customers to rotate tokens across

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}: "${raw}"`);
  return n;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/** Classify an HTTP status into the buckets NFR-PERF-01 cares about. */
function classify(stats, status) {
  if (status >= 200 && status < 400) stats.ok++;
  else if (status >= 400 && status < 500) stats.client4xx++;
  else if (status >= 500) stats.server5xx++;
}

/**
 * Closed-loop scenario: `concurrency` workers each fire requests back-to-back
 * until `durationMs` elapses. Returns latency percentiles + throughput + errors.
 */
async function runScenario(label, { baseUrl, concurrency, durationMs, makeRequest }) {
  const latencies = [];
  const stats = { ok: 0, client4xx: 0, server5xx: 0, networkError: 0 };
  const deadline = Date.now() + durationMs;

  const worker = async () => {
    while (Date.now() < deadline) {
      const req = makeRequest();
      const start = process.hrtime.bigint();
      try {
        const res = await fetch(`${baseUrl}${req.path}`, req.init);
        await res.arrayBuffer(); // fully drain the body so latency is complete
        classify(stats, res.status);
        latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
      } catch {
        stats.networkError++; // connection resets/timeouts count against availability
      }
    }
  };

  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = Date.now() - t0;

  latencies.sort((a, b) => a - b);
  const measured = latencies.length;
  const total = measured + stats.networkError;
  const errorRatePct = total === 0 ? 0 : ((stats.server5xx + stats.networkError) / total) * 100;
  const sum = latencies.reduce((a, b) => a + b, 0);

  return {
    label,
    concurrency,
    durationMs: elapsedMs,
    requests: total,
    measured,
    throughputRps: +(measured / (elapsedMs / 1000)).toFixed(1),
    ok: stats.ok,
    client4xx: stats.client4xx,
    server5xx: stats.server5xx,
    networkError: stats.networkError,
    errorRatePct: +errorRatePct.toFixed(2),
    latencyMs: {
      min: +latencies[0].toFixed(1),
      p50: +percentile(latencies, 50).toFixed(1),
      p95: +percentile(latencies, 95).toFixed(1),
      p99: +percentile(latencies, 99).toFixed(1),
      max: +latencies[latencies.length - 1].toFixed(1),
      mean: +(sum / measured).toFixed(1),
    },
  };
}

function verdict(reads, orders) {
  const fails = [];
  if (reads.latencyMs.p95 > READ_P95_TARGET)
    fails.push(`reads p95 ${reads.latencyMs.p95}ms > ${READ_P95_TARGET}ms target`);
  if (orders.latencyMs.p95 > ORDER_P95_TARGET)
    fails.push(`order p95 ${orders.latencyMs.p95}ms > ${ORDER_P95_TARGET}ms target`);
  const worstErr = Math.max(reads.errorRatePct, orders.errorRatePct);
  if (worstErr >= ERROR_RATE_TARGET)
    fails.push(`5xx/error rate ${worstErr}% >= ${ERROR_RATE_TARGET}%`);
  return { status: fails.length === 0 ? 'PASS' : 'FAIL', reasons: fails };
}

function hardwareContext(dbVersion) {
  const cpus = os.cpus();
  return {
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: `${cpus.length} × ${cpus[0] ? cpus[0].model : 'unknown'}`,
    totalMemoryGb: +(os.totalmem() / 1e9).toFixed(1),
    node: process.version,
    database: dbVersion,
    benchmarkDatabase: perfName,
    measuredAt: new Date().toISOString(),
  };
}

(async () => {
  const setupPool = new Pool({ connectionString: perfUrl, max: 5 });

  // Preconditions: benchmark data must exist (run npm run perf:seed first).
  const counts = await setupPool.query(
    `SELECT (SELECT count(*) FROM products) AS products,
            (SELECT count(*) FROM users WHERE role='customer') AS customers,
            (SELECT count(*) FROM orders)  AS orders`
  );
  const c = counts.rows[0];
  if (Number(c.products) < 500 || Number(c.customers) < CUSTOMER_POOL) {
    console.error(
      `Benchmark data missing (products=${c.products}, customers=${c.customers}). ` +
        'Run `npm run perf:seed` first.'
    );
    await setupPool.end();
    process.exit(1);
  }

  // Mint access tokens for a rotating pool of customers + one admin (setup only, not measured).
  const custRes = await setupPool.query(
    `SELECT id FROM users WHERE role='customer' ORDER BY id LIMIT $1`,
    [CUSTOMER_POOL]
  );
  const customerTokens = custRes.rows.map((r) =>
    tokenService.signAccessToken({ userId: r.id, role: 'customer' })
  );
  const productRes = await setupPool.query(
    `SELECT id FROM products WHERE sku LIKE 'PERF-SKU-%' ORDER BY id`
  );
  const productIds = productRes.rows.map((r) => r.id);
  const dbVersionRes = await setupPool.query('SHOW server_version');
  const dbVersion = `PostgreSQL ${dbVersionRes.rows[0].server_version} (Docker)`;
  await setupPool.end();

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const rnd = (n) => Math.floor(Math.random() * n);
  const pick = (arr) => arr[rnd(arr.length)];
  let tokenCursor = 0;
  const nextToken = () => customerTokens[tokenCursor++ % customerTokens.length];

  const readEndpoints = [
    () => ({ path: '/api/products?limit=20&page=1', init: authGet(nextToken()) }),
    () => ({ path: `/api/products/${pick(productIds)}`, init: authGet(nextToken()) }),
    () => ({ path: '/api/cart', init: authGet(nextToken()) }),
    () => ({ path: '/api/orders?limit=20&page=1', init: authGet(nextToken()) }),
  ];
  let readCursor = 0;
  const makeRead = () => readEndpoints[readCursor++ % readEndpoints.length]();

  function authGet(token) {
    return { method: 'GET', headers: { Authorization: `Bearer ${token}` } };
  }
  function makeOrder() {
    const token = nextToken();
    const lines = 1 + rnd(3);
    const chosen = new Set();
    while (chosen.size < lines) chosen.add(pick(productIds));
    const items = [...chosen].map((product_id) => ({ product_id, quantity: 1 + rnd(5) }));
    return {
      path: '/api/orders',
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': crypto.randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items }),
      },
    };
  }

  // Health + warmup (not measured).
  await fetch(`${baseUrl}/api/health`);
  await runScenario('warmup-reads', {
    baseUrl,
    concurrency: CONCURRENCY,
    durationMs: 1000,
    makeRequest: makeRead,
  });
  await runScenario('warmup-orders', {
    baseUrl,
    concurrency: CONCURRENCY,
    durationMs: 1000,
    makeRequest: makeOrder,
  });

  console.log(`\nBenchmarking against ${perfName} — ${CONCURRENCY} concurrent virtual users\n`);
  const reads = await runScenario('read-mix', {
    baseUrl,
    concurrency: CONCURRENCY,
    durationMs: READS_MS,
    makeRequest: makeRead,
  });
  const orders = await runScenario('order-creation', {
    baseUrl,
    concurrency: CONCURRENCY,
    durationMs: ORDERS_MS,
    makeRequest: makeOrder,
  });
  const result = verdict(reads, orders);

  const report = {
    criteria: 'NFR-PERF-01 / NFR-05 / SC-07',
    workload: {
      model: 'closed-loop',
      concurrency: CONCURRENCY,
      readDurationMs: READS_MS,
      orderDurationMs: ORDERS_MS,
      dataset: {
        products: Number(c.products),
        customers: Number(c.customers),
        ordersBeforeRun: Number(c.orders),
      },
    },
    targets: {
      readP95Ms: READ_P95_TARGET,
      orderP95Ms: ORDER_P95_TARGET,
      errorRatePctMax: ERROR_RATE_TARGET,
    },
    hardware: hardwareContext(dbVersion),
    measured: { reads, orders },
    verdict: result,
  };

  printReport(report);

  // Persist evidence.
  const outDir = path.join(__dirname, '..', '..', '..', 'evidence', 'test-reports');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'perf-load.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'perf-load.md'), markdownReport(report));

  server.close();
  await closePool();
  process.exit(result.status === 'PASS' ? 0 : 2);
})().catch((err) => {
  console.error('Benchmark failed:', err.stack || err.message);
  process.exit(1);
});

function fmt(s) {
  const L = s.latencyMs;
  return (
    `  ${s.label.padEnd(16)} rps=${String(s.throughputRps).padStart(7)}  ` +
    `p50=${L.p50}ms  p95=${L.p95}ms  p99=${L.p99}ms  max=${L.max}ms  ` +
    `2xx=${s.ok}  4xx=${s.client4xx}  5xx=${s.server5xx}  err=${s.errorRatePct}%  n=${s.requests}`
  );
}

function printReport(r) {
  console.log('─'.repeat(96));
  console.log(`  ${r.criteria}  —  verdict: ${r.verdict.status}`);
  console.log(
    `  ${r.hardware.platform} · ${r.hardware.cpu} · ${r.hardware.totalMemoryGb} GB · Node ${r.hardware.node} · ${r.hardware.database}`
  );
  console.log('─'.repeat(96));
  console.log(fmt(r.measured.reads));
  console.log(fmt(r.measured.orders));
  console.log('─'.repeat(96));
  console.log(
    `  targets: reads p95 <= ${r.targets.readP95Ms}ms · order p95 <= ${r.targets.orderP95Ms}ms · 5xx < ${r.targets.errorRatePctMax}%`
  );
  if (r.verdict.reasons.length) console.log(`  reasons: ${r.verdict.reasons.join('; ')}`);
  console.log('');
}

function markdownReport(r) {
  const row = (s) =>
    `| ${s.label} | ${s.requests} | ${s.throughputRps} | ${s.latencyMs.p50} | ${s.latencyMs.p95} | ` +
    `${s.latencyMs.p99} | ${s.latencyMs.max} | ${s.ok} | ${s.client4xx} | ${s.server5xx} | ${s.errorRatePct}% |`;
  return [
    '# Performance benchmark — measured results',
    '',
    `**Criterion:** ${r.criteria} (NFR-05 targets). **Verdict: ${r.verdict.status}**`,
    '',
    `- Measured at: ${r.hardware.measuredAt}`,
    `- Hardware: ${r.hardware.platform} · ${r.hardware.cpu} · ${r.hardware.totalMemoryGb} GB RAM · Node ${r.hardware.node}`,
    `- Database: ${r.hardware.database} (isolated benchmark DB \`${r.hardware.benchmarkDatabase}\`)`,
    `- Workload: ${r.workload.model}, ${r.workload.concurrency} concurrent vU — reads ${r.workload.readDurationMs / 1000}s + order creation ${r.workload.orderDurationMs / 1000}s`,
    `- Dataset: ${r.workload.dataset.products} products, ${r.workload.dataset.customers} customers, ${r.workload.dataset.ordersBeforeRun} pre-seeded orders`,
    `- Targets: reads p95 ≤ ${r.targets.readP95Ms} ms · order creation p95 ≤ ${r.targets.orderP95Ms} ms · 5xx < ${r.targets.errorRatePctMax}%`,
    '',
    '| Scenario | Requests | RPS | p50 ms | p95 ms | p99 ms | max ms | 2xx | 4xx | 5xx | Err% |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    row(r.measured.reads),
    row(r.measured.orders),
    '',
    ...(r.verdict.reasons.length ? [`**Misses:** ${r.verdict.reasons.join('; ')}`] : []),
    '',
    '> Numbers are **measured**, not targets. 4xx (e.g. `409 INSUFFICIENT_STOCK`) are business',
    '> rejections under load, not server faults; only 5xx count against the error-rate target.',
    '',
  ].join('\n');
}
