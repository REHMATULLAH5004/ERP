'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFns } = require('../helpers/load');
const { plain } = require('../helpers/plain');

// ---- markup curve: cost 1 -> max markup, cost 600 -> min markup (retail regular 60% -> 30%) --------------------
const retail = loadFns('pages/transaction/retail/index.js', ['computeExponentialMarkupPercent']);
const pricing = loadFns('pages/inventory/pricing/index.js', ['computeExponentialMarkupPercent']);
const f = retail.computeExponentialMarkupPercent;

test('markup curve: cheapest items get the maximum markup, dearest get the minimum', () => {
  assert.equal(f(1, 60, 30, 1, 600), 60);
  assert.ok(Math.abs(f(600, 60, 30, 1, 600) - 30) < 1e-9);
});

test('markup curve: costs outside the range are clamped, not extrapolated', () => {
  assert.equal(f(0.01, 60, 30, 1, 600), 60);
  assert.ok(Math.abs(f(99999, 60, 30, 1, 600) - 30) < 1e-9);
});

test('markup curve: falls steadily as cost rises, and stays between min and max', () => {
  let prev = Infinity;
  for (let c = 1; c <= 600; c += 7) {
    const p = f(c, 60, 30, 1, 600);
    assert.ok(p <= prev + 1e-12, 'markup rose at cost ' + c);
    assert.ok(p >= 30 - 1e-9 && p <= 60 + 1e-9);
    prev = p;
  }
});

test('markup curve: a broken setup falls back to the maximum instead of NaN', () => {
  assert.equal(f(50, 60, 30, 600, 1), 60);   // costMax below costMin
  assert.equal(f(50, 60, 0, 1, 600), 60);    // min = 0
  assert.equal(f(50, 0, 30, 1, 600), 0);     // max = 0
});

test('markup curve: the retail page and the pricing page use the same formula', () => {
  for (const c of [0, 1, 5.5, 20, 150, 599, 600, 1200]) {
    assert.equal(retail.computeExponentialMarkupPercent(c, 60, 30, 1, 600), pricing.computeExponentialMarkupPercent(c, 60, 30, 1, 600));
  }
});

// ---- dashboard "sell by pack" helpers ----------------------------------------------------------------------------
function dash(settings) {
  const consts = `
    const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const cs = { max: ${settings.max}, min: ${settings.min}, costMin: ${settings.costMin}, costMax: ${settings.costMax} };`;
  return loadFns('pages/dashboard/dashboard-view.js', ['markupPercent', 'packRate', 'allocate', 'maxPacks'], { consts });
}
const D = dash({ max: 60, min: 30, costMin: 1, costMax: 600 });

test('dashboard: the pack markup matches the retail curve', () => {
  for (const c of [1, 10, 100, 300, 600]) {
    assert.equal(D.markupPercent(c), f(c, 60, 30, 1, 600));
  }
});

test('dashboard: pack rate = cost of the whole pack plus the curve markup, rounded to 2 decimals', () => {
  const rate = D.packRate({ cost_price: 2 }, 10);   // pack cost 20
  const expected = Math.round((20 * (1 + f(20, 60, 30, 1, 600) / 100)) * 100) / 100;
  assert.equal(rate, expected);
  assert.equal(D.packRate({ cost_price: 0 }, 10), 0);
  assert.equal(D.packRate({}, 10), 0);
});

test('dashboard: maxPacks only counts whole packs in each batch', () => {
  const batches = [{ total_qty: 25 }, { total_qty: 9 }, { total_qty: 10 }];
  assert.equal(D.maxPacks(batches, 10), 3);           // 2 + 0 + 1
  assert.equal(D.maxPacks([], 10), 0);
  assert.equal(D.maxPacks([{ total_qty: 'x' }], 10), 0);
});

test('dashboard: allocate takes from the first batch, then the next, and reports any shortage', () => {
  const b1 = { id: 'b1', total_qty: 25, cost_price: 1 }, b2 = { id: 'b2', total_qty: 30, cost_price: 1 };
  const r = D.allocate([b1, b2], 10, 4);
  assert.deepEqual(plain(r.parts.map(p => [p.batch.id, p.packs])), [['b1', 2], ['b2', 2]]);
  assert.equal(r.short, 0);
  const r2 = D.allocate([b1, b2], 10, 9);
  assert.equal(r2.short, 4);                           // only 5 packs exist
  assert.equal(D.allocate([b1], 10, 0).parts.length, 0);
});

test('dashboard: allocate never takes more than a batch holds', () => {
  const r = D.allocate([{ id: 'x', total_qty: 7, cost_price: 1 }], 10, 1);
  assert.equal(r.parts.length, 0);
  assert.equal(r.short, 1);
});

// ---- how many tablets one sold "pack" is (stock movement / inventory / accounts) ----------------------------------
for (const file of ['pages/account/account-view.js', 'pages/inventory/inventory-view.js', 'pages/transaction/stock-movement/index.js']) {
  const { getSaleQtyMultiplier: g } = loadFns(file, ['getSaleQtyMultiplier']);
  test(`pack multiplier (${file}): NHIMA claims are always counted singly`, () => {
    assert.equal(g({ client_sub_type: 'NHIMA' }, { pack_size: '10' }), 1);
  });
  test(`pack multiplier (${file}): reads the number from the pack size, defaults to 1`, () => {
    assert.equal(g({ client_sub_type: 'REGULAR' }, { pack_size: '10' }), 10);
    assert.equal(g({ client_sub_type: 'REGULAR' }, { pack_size: '28 tabs' }), 28);
    assert.equal(g({ client_sub_type: 'REGULAR' }, { pack_size: 'EACH' }), 1);
    assert.equal(g({ client_sub_type: 'REGULAR' }, { pack_size: '0' }), 1);
    assert.equal(g({ client_sub_type: 'REGULAR' }, { pack_size: '-5' }), 1);
    assert.equal(g({ client_sub_type: 'REGULAR' }, {}), 1);
  });
}

// ---- expiry ---------------------------------------------------------------------------------------------------------
const exp = loadFns('pages/report/inventory-report/index.js', ['daysUntilExpiry', 'getExpiryStatus']);
const dayStr = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

test('expiry: counts calendar days from today', () => {
  assert.equal(exp.daysUntilExpiry(dayStr(0)), 0);
  assert.equal(exp.daysUntilExpiry(dayStr(30)), 30);
  assert.equal(exp.daysUntilExpiry(dayStr(-3)), -3);
});

test('expiry status: expired / 30 days / 90 days / ok, with exact boundaries', () => {
  assert.equal(exp.getExpiryStatus(-1).key, 'expired');
  assert.equal(exp.getExpiryStatus(0).key, '30');
  assert.equal(exp.getExpiryStatus(30).key, '30');
  assert.equal(exp.getExpiryStatus(31).key, '90');
  assert.equal(exp.getExpiryStatus(90).key, '90');
  assert.equal(exp.getExpiryStatus(91).key, 'ok');
});

// ---- depreciation -----------------------------------------------------------------------------------------------------
const { calculateDepreciation: dep } = loadFns('pages/account/fixed-assets/index.js', ['calculateDepreciation']);

test('depreciation: straight line = (cost - salvage) / life, spread over 12 months', () => {
  const r = dep({ cost: 12000, salvage_value: 2000, useful_life: 5 }, 12);
  assert.equal(r.annualDepreciation, 2000);
  assert.ok(Math.abs(r.monthlyDepreciation - 2000 / 12) < 1e-9);
  assert.equal(r.totalDepreciation, 2000);
  assert.equal(r.netBookValue, 10000);
  assert.equal(r.isFullyDepreciated, false);
});

test('depreciation: never goes below salvage value', () => {
  const r = dep({ cost: 12000, salvage_value: 2000, useful_life: 5 }, 600);
  assert.equal(r.totalDepreciation, 10000);
  assert.equal(r.netBookValue, 2000);
  assert.equal(r.isFullyDepreciated, true);
  assert.equal(r.remainingLife, 0);
});

test('depreciation: existing accumulated depreciation is carried forward', () => {
  const r = dep({ cost: 12000, salvage_value: 0, useful_life: 4, accumulated_depreciation: 3000 }, 12);
  assert.equal(r.totalDepreciation, 6000);
  assert.equal(r.netBookValue, 6000);
});

test('depreciation: double declining balance uses 2 / life of the current book value', () => {
  const r = dep({ cost: 10000, salvage_value: 0, useful_life: 5, depreciation_method: 'declining-balance' }, 12);
  assert.equal(r.annualDepreciation, 4000);
});

test('depreciation: an asset whose cost equals its salvage value reports sensible numbers (no NaN)', () => {
  const r = dep({ cost: 5000, salvage_value: 5000, useful_life: 5 }, 12);
  assert.equal(r.annualDepreciation, 0);
  assert.equal(r.totalDepreciation, 0);
  assert.ok(Number.isFinite(r.remainingLife), 'remainingLife must be a number, got ' + r.remainingLife);
  assert.equal(r.isFullyDepreciated, true);
});

test('depreciation: a zero-cost asset does not produce NaN either', () => {
  const r = dep({ cost: 0 }, 6);
  for (const k of ['annualDepreciation', 'monthlyDepreciation', 'totalDepreciation', 'netBookValue', 'remainingLife']) {
    assert.ok(Number.isFinite(r[k]), k + ' is ' + r[k]);
  }
});
