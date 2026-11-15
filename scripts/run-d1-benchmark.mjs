const DEFAULT_API_URL = process.env.BENCH_API_URL ?? 'http://127.0.0.1:8787';
const ITERATIONS = Number.parseInt(process.env.BENCH_ITERATIONS ?? '40', 10);
const WARMUP = 5;

const CASE_THRESHOLDS = [
  { id: 1, maxP95Ms: 3, maxRowsRead: null, label: 'Case 1 (Keyset Page 250)' },
  { id: 2, maxP95Ms: 2, maxRowsRead: 30, label: 'Case 2 (Closure RBAC Depth 6)' },
  { id: 3, maxP95Ms: 3, maxRowsRead: null, label: 'Case 3 (Classification Filter)' },
  { id: 4, maxP95Ms: 3, maxRowsRead: null, label: 'Case 4 (AI Suggestion Queue)' },
  { id: 5, maxP95Ms: 10, maxRowsRead: null, label: 'Case 5 (FTS5 + RBAC Search)' },
  { id: 6, maxP95Ms: 1, maxRowsRead: 4, label: 'Case 6 (O(1) Storage Stats)' },
];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx];
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status} on ${url}: ${txt}`);
  }
  return res.json();
}

async function main() {
  console.log(`[bench] Target Worker URL: ${DEFAULT_API_URL}`);
  const totals = await fetchJson(`${DEFAULT_API_URL}/api/__bench/totals`);
  console.log('[bench] Seeded counts:', totals.counts);

  let allPassed = true;
  const rows = [];

  for (const spec of CASE_THRESHOLDS) {
    const explain = await fetchJson(
      `${DEFAULT_API_URL}/api/__bench/case/${spec.id}?explain=1`
    );

    for (let w = 0; w < WARMUP; w++) {
      await fetchJson(`${DEFAULT_API_URL}/api/__bench/case/${spec.id}`);
    }

    const sqlSamples = [];
    const workerSamples = [];
    let lastRowsRead = null;
    let lastRowCount = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const sample = await fetchJson(`${DEFAULT_API_URL}/api/__bench/case/${spec.id}`);
      const sqlMs =
        typeof sample.sqlDurationMs === 'number'
          ? sample.sqlDurationMs
          : sample.workerElapsedMs;
      sqlSamples.push(sqlMs);
      workerSamples.push(sample.workerElapsedMs);
      lastRowsRead = sample.rowsRead;
      lastRowCount = sample.rowCount;
    }

    sqlSamples.sort((a, b) => a - b);
    workerSamples.sort((a, b) => a - b);

    const sqlP50 = percentile(sqlSamples, 50);
    const sqlP95 = percentile(sqlSamples, 95);
    const workerP95 = percentile(workerSamples, 95);

    const p95Ok = sqlP95 <= spec.maxP95Ms;
    const rowsOk =
      spec.maxRowsRead === null ||
      lastRowsRead === null ||
      lastRowsRead <= spec.maxRowsRead;
    const pass = p95Ok && rowsOk;
    if (!pass) allPassed = false;

    rows.push({
      case: spec.label,
      rowsReturned: lastRowCount,
      rowsRead: lastRowsRead ?? 'n/a',
      sqlP50Ms: Number(sqlP50.toFixed(3)),
      sqlP95Ms: Number(sqlP95.toFixed(3)),
      workerP95Ms: Number(workerP95.toFixed(3)),
      targetP95Ms: `< ${spec.maxP95Ms}ms`,
      status: pass ? 'PASS' : 'FAIL',
      planDetails: explain.plan.map((p) => p.detail).join(' | '),
    });
  }

  console.log('\n[bench] === D1 1M Benchmark Results ===');
  console.table(
    rows.map(({ planDetails: _p, ...rest }) => rest)
  );
  console.log('\n[bench] === EXPLAIN QUERY PLAN ===');
  for (const r of rows) {
    console.log(`- ${r.case}: ${r.planDetails}`);
  }

  if (!allPassed) {
    console.error('\n[bench] One or more benchmark thresholds were exceeded!');
    process.exit(1);
  }
  console.log('\n[bench] All 6 benchmark cases PASSED.');
}

main().catch((err) => {
  console.error('[bench] Fatal error:', err);
  process.exit(1);
});
