# Performance benchmark — measured results

**Criterion:** NFR-PERF-01 / NFR-05 / SC-07 (NFR-05 targets). **Verdict: PASS**

- Measured at: 2026-10-23T16:32:10.870Z
- Hardware: Windows_NT 10.0.26300 (x64) · 4 × 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz · 8.3 GB RAM · Node v24.17.0
- Database: PostgreSQL 16.15 (Docker) (isolated benchmark DB `b2b_oms_perf`)
- Workload: closed-loop, 20 concurrent vU — reads 60s + order creation 60s
- Dataset: 500 products, 200 customers, 1436 pre-seeded orders
- Targets: reads p95 ≤ 500 ms · order creation p95 ≤ 1500 ms · 5xx < 1%

| Scenario | Requests | RPS | p50 ms | p95 ms | p99 ms | max ms | 2xx | 4xx | 5xx | Err% |
|---|---|---|---|---|---|---|---|---|---|---|
| read-mix | 17132 | 285.4 | 63.5 | 118 | 165.5 | 1040.7 | 17132 | 0 | 0 | 0% |
| order-creation | 3912 | 65.1 | 280.8 | 501.2 | 722.1 | 2324.7 | 3912 | 0 | 0 | 0% |


> Numbers are **measured**, not targets. 4xx (e.g. `409 INSUFFICIENT_STOCK`) are business
> rejections under load, not server faults; only 5xx count against the error-rate target.
