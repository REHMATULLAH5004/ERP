'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFns } = require('../helpers/load');
const { plain } = require('../helpers/plain');

// ---------- chart helpers (same code is repeated in the cash / bank / expense / sales reports) -------------------
const FILES = ['pages/report/cash-report/index.js', 'pages/report/bank-report/index.js', 'pages/report/expense-report/index.js'];
for (const file of FILES) {
  const H = loadFns(file, ['dateKey', 'startOfWeek', 'niceMax', 'formatNumber', 'formatCompact']);

  test(`[${file}] dateKey gives YYYY-MM-DD in local time`, () => {
    assert.equal(H.dateKey(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(H.dateKey(new Date(2026, 11, 31)), '2026-12-31');
  });

  test(`[${file}] week starts on Monday`, () => {
    assert.equal(H.dateKey(H.startOfWeek(new Date(2026, 9, 22))), '2026-10-19');   // Thu 22 Oct -> Mon 19 Oct
    assert.equal(H.dateKey(H.startOfWeek(new Date(2026, 9, 19))), '2026-10-19');   // Monday stays
    assert.equal(H.dateKey(H.startOfWeek(new Date(2026, 9, 25))), '2026-10-19');   // Sunday goes back 6 days
  });

  test(`[${file}] niceMax rounds a chart axis up to 1, 2, 5 or 10 x a power of ten`, () => {
    assert.equal(H.niceMax(0), 100);
    assert.equal(H.niceMax(-4), 100);
    assert.equal(H.niceMax(1), 1);
    assert.equal(H.niceMax(1.5), 2);
    assert.equal(H.niceMax(3), 5);
    assert.equal(H.niceMax(7), 10);
    assert.equal(H.niceMax(430), 500);
    assert.equal(H.niceMax(12345), 20000);
    for (const v of [0.3, 9, 99, 101, 5000, 87654]) assert.ok(H.niceMax(v) >= v, 'axis smaller than data for ' + v);
  });

  test(`[${file}] number formats`, () => {
    assert.equal(H.formatNumber(1234.5), '1,234.50');
    assert.equal(H.formatNumber(0), '0.00');
    assert.equal(H.formatNumber(null), '0.00');
    assert.equal(H.formatCompact(950), '950.00');
    assert.equal(H.formatCompact(1000), '1K');
    assert.equal(H.formatCompact(1500), '1.5K');
    assert.equal(H.formatCompact(2500000), '2.5M');
    assert.equal(H.formatCompact(-1500), '-1.5K');
  });
}

// ---------- cash / bank ledger summary ----------------------------------------------------------------------------
const cashSrc = loadFns('pages/report/cash-report/index.js', ['dateKey', 'startOfWeek', 'computeForRange'],
  { consts: "const CASH_CODES=['1111']; const ZMW_CODES=['1111'];" });
const row = (entryDate, debit, credit, counterName = 'Sales', accountCode = '1111') => ({ entryDate, accountCode, debit, credit, counterName });

test('cash report: opening balance is everything before the start date; closing = opening + in - out', () => {
  const rows = [row('2026-10-01', 500, 0), row('2026-10-05', 0, 100), row('2026-10-10', 200, 0), row('2026-10-12', 0, 50, 'Rent')];
  const r = cashSrc.computeForRange(rows, '2026-10-10', '2026-10-31');
  const t = plain(r.accountTotals['1111']);
  assert.deepEqual(t, { opening: 400, in: 200, out: 50, closing: 550 });
});

test('cash report: sources and uses are grouped by counterparty and sorted largest first', () => {
  const rows = [row('2026-10-02', 100, 0, 'Retail'), row('2026-10-03', 300, 0, 'Wholesale'), row('2026-10-04', 50, 0, 'Retail'),
    row('2026-10-05', 0, 80, 'Rent'), row('2026-10-06', 0, 20, 'Fuel')];
  const r = cashSrc.computeForRange(rows, '2026-10-01', '2026-10-31');
  assert.deepEqual(plain(r.inBySource), [{ label: 'Wholesale', value: 300 }, { label: 'Retail', value: 150 }]);
  assert.deepEqual(plain(r.outByUse), [{ label: 'Rent', value: 80 }, { label: 'Fuel', value: 20 }]);
});

test('cash report: a range up to 31 days is charted per day, longer ranges per week', () => {
  const rows = [row('2026-10-02', 100, 0)];
  assert.equal(cashSrc.computeForRange(rows, '2026-10-01', '2026-10-31').trend.length, 31);
  const longRange = cashSrc.computeForRange(rows, '2026-09-01', '2026-10-31');
  assert.ok(longRange.trend.length >= 8 && longRange.trend.length <= 10, 'weeks: ' + longRange.trend.length);
});

test('cash report: the daily trend adds up to money in minus money out', () => {
  const rows = [row('2026-10-02', 100, 0), row('2026-10-02', 0, 30), row('2026-10-09', 200, 0)];
  const r = cashSrc.computeForRange(rows, '2026-10-01', '2026-10-31');
  const sum = r.trend.reduce((s, b) => s + b.value, 0);
  assert.equal(sum, 270);
});

test('cash report: an empty period gives zeros, not errors', () => {
  const r = cashSrc.computeForRange([], '2026-10-01', '2026-10-31');
  assert.deepEqual(plain(r.accountTotals['1111']), { opening: 0, in: 0, out: 0, closing: 0 });
  assert.equal(r.ledger.length, 0);
});

const bank = loadFns('pages/report/bank-report/index.js', ['dateKey', 'startOfWeek', 'computeForRange']);
test('bank report: totals are kept per account code', () => {
  const rows = [row('2026-10-02', 1000, 0, 'Sales', '1121'), row('2026-10-03', 0, 400, 'Supplier', '1121'), row('2026-10-03', 50, 0, 'Sales', '1122')];
  const r = bank.computeForRange(rows, '2026-10-01', '2026-10-31', ['1121', '1122'], ['1121']);
  assert.deepEqual(plain(r.accountTotals['1121']), { opening: 0, in: 1000, out: 400, closing: 600 });
  assert.deepEqual(plain(r.accountTotals['1122']), { opening: 0, in: 50, out: 0, closing: 50 });
});

const expense = loadFns('pages/report/expense-report/index.js', ['dateKey', 'startOfWeek', 'computeForRange']);
test('expense report: filters by category and groups by category and account', () => {
  const rows = [
    { date: '2026-10-02', category: 'Utilities', account: 'Bank', amount: 100 },
    { date: '2026-10-03', category: 'Utilities', account: 'Cash', amount: 50 },
    { date: '2026-10-04', category: 'Rent', account: 'Bank', amount: 400 },
    { date: '2026-11-04', category: 'Rent', account: 'Bank', amount: 999 }];
  const all = expense.computeForRange(rows, '2026-10-01', '2026-10-31', 'ALL');
  assert.deepEqual(plain(all.byCategory), [{ label: 'Rent', value: 400 }, { label: 'Utilities', value: 150 }]);
  assert.deepEqual(plain(all.byAccount), [{ label: 'Bank', value: 500 }, { label: 'Cash', value: 50 }]);
  const util = expense.computeForRange(rows, '2026-10-01', '2026-10-31', 'Utilities');
  assert.deepEqual(plain(util.byCategory), [{ label: 'Utilities', value: 150 }]);
});

// ---------- sales report -----------------------------------------------------------------------------------------
const SR = loadFns('pages/report/sales-report/index.js',
  ['formatNumber', 'classifyRow', 'classifyColumn', 'computeBreakdown', 'computeItemWise', 'computeCustomerWise', 'sortRows'],
  { consts: `const ROWS=[{key:'NHIMA',label:'NHIMA Sale'},{key:'REGULAR',label:'Regular Sale'},{key:'ONLINE',label:'Online Sale'},{key:'STAFF',label:'Staff Sale'},{key:'WHOLESALE',label:'Wholesale (Internal or Regular)'},{key:'WRITEOFF_DONATION',label:'Write-Off / Donation'}];` });

test('sales report: every sale goes to exactly one row (NHIMA, wholesale, online, staff, write-off, regular)', () => {
  assert.equal(SR.classifyRow({ client_sub_type: 'NHIMA', client_type: 'RETAIL' }), 'NHIMA');
  assert.equal(SR.classifyRow({ client_type: 'WHOLESALE' }), 'WHOLESALE');
  assert.equal(SR.classifyRow({ client_type: 'RETAIL', client_sub_type: 'ONLINE' }), 'ONLINE');
  assert.equal(SR.classifyRow({ client_type: 'RETAIL', client_sub_type: 'STAFF' }), 'STAFF');
  assert.equal(SR.classifyRow({ client_type: 'DONATION' }), 'WRITEOFF_DONATION');
  assert.equal(SR.classifyRow({ client_type: 'WRITEOFF' }), 'WRITEOFF_DONATION');
  assert.equal(SR.classifyRow({ client_type: 'RETAIL', client_sub_type: 'REGULAR' }), 'REGULAR');
  assert.equal(SR.classifyRow({}), 'REGULAR');
});

test('sales report: NHIMA is always a receivable; credit is a receivable; bank transfer is bank; the rest is cash', () => {
  assert.equal(SR.classifyColumn({ client_sub_type: 'NHIMA', payment: { type: 'Cash' } }), 'receivable');
  assert.equal(SR.classifyColumn({ payment: { type: 'Credit' } }), 'receivable');
  assert.equal(SR.classifyColumn({ payment: { type: 'Bank Transfer' } }), 'bank');
  assert.equal(SR.classifyColumn({ payment: { type: 'Cash' } }), 'cash');
  assert.equal(SR.classifyColumn({}), 'cash');
});

test('sales report: the breakdown adds every sale into one cell and the cells add up to the grand total', () => {
  const sales = [
    { client_sub_type: 'NHIMA', grand_total: '325.00', payment: { type: 'Credit' } },
    { client_type: 'RETAIL', client_sub_type: 'REGULAR', grand_total: '100.50', payment: { type: 'Cash' } },
    { client_type: 'RETAIL', client_sub_type: 'REGULAR', grand_total: '49.50', payment: { type: 'Bank Transfer' } },
    { client_type: 'WHOLESALE', grand_total: 1000, payment: { type: 'Credit' } },
    { client_type: 'RETAIL', client_sub_type: 'REGULAR', grand_total: 'bad', payment: { type: 'Cash' } }];
  const b = plain(SR.computeBreakdown(sales));
  assert.equal(b.NHIMA.receivable, 325);
  assert.equal(b.REGULAR.cash, 100.5);
  assert.equal(b.REGULAR.bank, 49.5);
  assert.equal(b.WHOLESALE.receivable, 1000);
  const total = Object.values(b).reduce((s, r) => s + r.cash + r.bank + r.receivable, 0);
  assert.equal(total, 325 + 100.5 + 49.5 + 1000);
});

test('sales report: item-wise totals add quantities and revenue across invoices', () => {
  const sales = [
    { id: 's1', sale_id: 'A-1', created_at: 'x', client_sub_type: 'REGULAR', customer_data: { full_name: 'Mary' }, items: [{ product_id: 'p1', product_name: 'Amox', qty: 2, rate: 10, total: 20 }] },
    { id: 's2', sale_id: 'A-2', created_at: 'y', client_type: 'WHOLESALE', customer_data: { customer_name: 'Clinic' }, items: [{ product_id: 'p1', product_name: 'Amox', qty: 3, rate: 9, total: 27 }, { product_id: 'p2', product_name: 'Para', qty: 1, rate: 5, total: 5 }] }];
  const r = SR.computeItemWise(sales);
  const amox = r.find(x => x.key === 'p1');
  assert.equal(amox.qty, 5);
  assert.equal(amox.revenue, 47);
  assert.equal(amox.txns, 2);
  assert.equal(amox.lines.length, 2);
  assert.equal(amox.lines[1].customerName, 'Clinic');           // wholesale keeps the name under customer_name
  assert.equal(r.find(x => x.key === 'p2').revenue, 5);
});

test('sales report: customer-wise groups by customer and finds wholesale names too', () => {
  const sales = [
    { id: '1', sale_id: 'A-1', customer_id: 'c1', customer_data: { full_name: 'Mary', phone: '+260971' }, grand_total: 100, items: [] },
    { id: '2', sale_id: 'A-2', customer_id: 'c1', customer_data: { full_name: 'Mary' }, grand_total: 50, items: [] },
    { id: '3', sale_id: 'W-1', customer_data: { customer_name: 'Clinic' }, grand_total: 900, items: [] },
    { id: '4', sale_id: 'A-4', grand_total: 10, items: [] }];
  const r = SR.computeCustomerWise(sales);
  const mary = r.find(x => x.name === 'Mary');
  assert.equal(mary.revenue, 150);
  assert.equal(mary.txns, 2);
  assert.equal(mary.phone, '+260971');
  assert.ok(r.find(x => x.name === 'Clinic'));
  assert.ok(r.find(x => x.name === 'Unknown Customer'));
});

test('sales report: sorting works both ways and does not change the original list', () => {
  const rows = [{ v: 3 }, { v: 1 }, { v: 2 }];
  assert.deepEqual(plain(SR.sortRows(rows, { field: 'v', dir: 'asc' }).map(r => r.v)), [1, 2, 3]);
  assert.deepEqual(plain(SR.sortRows(rows, { field: 'v', dir: 'desc' }).map(r => r.v)), [3, 2, 1]);
  assert.deepEqual(plain(rows.map(r => r.v)), [3, 1, 2]);
});

// ---------- HR annual report ----------------------------------------------------------------------------------------
const AR = loadFns('pages/hr/annual-report/index.js', ['tallyLeaveDay', 'sumMonths']);
test('annual report: leave days are tallied into the right bucket', () => {
  const m = { annualLeaveDays: 0, sickLeaveDays: 0, unpaidLeaveDays: 0, otherLeaveDays: 0 };
  ['Annual', 'Emergency', 'Sick', 'Unpaid', 'Maternity', undefined].forEach(t => AR.tallyLeaveDay(m, t));
  assert.deepEqual(plain(m), { annualLeaveDays: 2, sickLeaveDays: 1, unpaidLeaveDays: 1, otherLeaveDays: 2 });
});
test('annual report: the yearly total is the sum of the months', () => {
  const t = AR.sumMonths([{ a: 1, b: 2 }, { a: 3, b: 0 }, { a: 0, b: 5, c: 1 }]);
  assert.deepEqual(plain(t), { a: 4, b: 7, c: 1 });
  assert.deepEqual(plain(AR.sumMonths([])), {});
});
