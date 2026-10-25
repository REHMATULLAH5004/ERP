'use strict';
// Integration tests: whole save / edit / delete flows of the sales pages run
// against an in-memory Supabase. The promise being tested: stock on the
// batches and the ledger can never end up half-changed. Either everything
// happens, or everything is put back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { instantiate } = require('../helpers/load');
const { makeDB } = require('../helpers/fakeSupabase');

const stock = (M, id) => M.DB.batches.find(b => b.id === id).total_qty;
const names = M => M.DB.batches.map(b => b.total_qty);

// ====================================================================
// WHOLESALE  (save new, edit, delete)
// ====================================================================
const WH_BASE = {
  batches: [{ id: 'B1', total_qty: 80 }, { id: 'B2', total_qty: 50 }],
  sales: [{ id: 'S1', sale_id: 'GWH-1', type: 'COMPLETED', is_quotation: false, status: 'COMPLETED', grand_total: 100, items: [{ batch_id: 'B1', qty: 20, pack_size: '1' }] }],
  sale_items: [{ id: 'I1', sale_id: 'S1', product_id: 'P1', batch_id: 'B1', quantity: 20, pack_size: '1', unit_price: 5, total: 100 }],
  journal_entries: [{ id: 'J1', reference: 'GWH-1' }, { id: 'J2', reference: 'GWH-1-COGS' }],
  journal_lines: [], customer_receipt_invoices: [],
};
function wholesale({ edit = true, failures = {}, newQty = 5, accFail = false, statusType = 'COMPLETED', mut = null } = {}) {
  const M = makeDB(WH_BASE); if (mut) mut(M.DB);
  const alerts = []; for (const k in failures) M.fail(k, failures[k]);
  const accCalls = [];
  const env = {
    supabaseClient: M.client, alert: m => alerts.push(m), confirm: () => true,
    currentUserRole: 'Admin', document: { getElementById: () => ({}), querySelector: () => null }, searchSalesRecords() {},
    saveBtn: null, quoteBtn: null, showPrintDialog() {}, printSale() {}, resetForm() {},
    createWholesaleAccountingEntries: async (sd) => { accCalls.push(sd.sale_id); if (accFail) throw new Error('acc fail'); M.DB.journal_entries.push({ id: 'JN' + accCalls.length, reference: sd.sale_id }); },
    getSaleData: () => ({ sale_id: 'GWH-1', type: statusType, prefix: 'GWH', client_type: 'WHOLESALE', customerType: { value: 'REGULAR' }, customer: { id: 'C1' },
      items: [{ product_id: 'P1', batch_id: 'B1', qty: newQty, pack_size: '1', rate: 5, tax_rate: 0, total: newQty * 5, cost_per_unit: 1 }],
      payment: { type: 'Cash' }, totals: { subtotal: newQty * 5, tax: 0, grand_total: newQty * 5 }, status: statusType }),
  };
  const api = instantiate('pages/transaction/wholesale/index.js',
    ['adjustBatchStock', 'rollbackEditedWholesale', 'rollbackFailedNewSale', 'saveTransaction', 'deleteSaleRecord'], env,
    `let editingWholesaleDbId = ${edit ? "'S1'" : 'null'}; let convertingFromQuotationId = null;`, ['saveTransaction', 'deleteSaleRecord']);
  return { M, alerts, api, accCalls };
}
const lines = M => M.DB.sale_items.filter(i => i.sale_id === 'S1');

test('wholesale edit 20 -> 5: stock goes 80 -> 95, old ledger replaced by the new one', async () => {
  const { M, alerts, api } = wholesale();
  await api.saveTransaction('COMPLETED', 'GWH');
  assert.equal(stock(M, 'B1'), 95);
  assert.equal(lines(M).length, 1); assert.equal(lines(M)[0].quantity, 5);
  assert.equal(M.DB.journal_entries.filter(j => j.reference === 'GWH-1').length, 1);
  assert.ok(!M.DB.journal_entries.find(j => j.id === 'J1'));
  assert.ok(alerts.some(a => a.includes('saved successfully')), alerts.join('|'));
});

test('wholesale edit: if stock cannot be restored, NOTHING changes', async () => {
  const { M, alerts, api } = wholesale({ failures: { 'rpc.adjust_batch_qty': [1] } });
  M.fail('batches.update', 'all');
  await api.saveTransaction('COMPLETED', 'GWH');
  assert.equal(stock(M, 'B1'), 80);
  assert.equal(lines(M)[0].quantity, 20);
  assert.equal(M.DB.journal_entries.length, 2);
  assert.ok(alerts.some(a => a.includes('NOTHING was changed')), alerts.join('|'));
});

test('wholesale edit: new lines fail to insert -> everything is put back', async () => {
  const { M, alerts, api } = wholesale({ failures: { 'sale_items.insert': [1] } });
  await api.saveTransaction('COMPLETED', 'GWH');
  assert.equal(stock(M, 'B1'), 80);
  assert.equal(lines(M).length, 1); assert.equal(lines(M)[0].quantity, 20);
  assert.equal(M.DB.sales[0].grand_total, 100);
  assert.equal(M.DB.journal_entries.length, 2);
  assert.ok(alerts.some(a => a.includes('undone')), alerts.join('|'));
});

test('wholesale edit: deducting the new quantity fails -> stock, lines, header and ledger all restored', async () => {
  const { M, alerts, api } = wholesale({ failures: { 'rpc.adjust_batch_qty': [2] } });
  M.fail('batches.update', 'all');
  await api.saveTransaction('COMPLETED', 'GWH');
  assert.equal(stock(M, 'B1'), 80);
  assert.equal(lines(M)[0].quantity, 20);
  assert.equal(M.DB.sales[0].grand_total, 100);
  assert.deepEqual(M.DB.journal_entries.map(j => j.id), ['J1', 'J2']);
  assert.ok(alerts.some(a => a.includes('undone')), alerts.join('|'));
});

test('wholesale edit: posting to the ledger fails -> data stays consistent and user is told to press Save again', async () => {
  const { M, alerts, api } = wholesale({ accFail: true });
  await api.saveTransaction('COMPLETED', 'GWH');
  assert.equal(stock(M, 'B1'), 95);
  assert.equal(lines(M)[0].quantity, 5);
  assert.ok(alerts.some(a => a.includes('press Save again')), alerts.join('|'));
});

test('wholesale edit: reversing the old ledger fails -> everything rolled back', async () => {
  const { M, alerts, api } = wholesale({ failures: { 'rpc.reverse_sale_accounting': 'all' } });
  await api.saveTransaction('COMPLETED', 'GWH');
  assert.equal(stock(M, 'B1'), 80);
  assert.equal(lines(M)[0].quantity, 20);
  assert.equal(M.DB.journal_entries.length, 2);
  assert.ok(alerts.some(a => a.includes('undone')), alerts.join('|'));
});

test('wholesale edit still works when the atomic stock function is missing (fallback read/write)', async () => {
  const { M, alerts, api } = wholesale({ failures: { 'rpc.adjust_batch_qty': 'all' } });
  await api.saveTransaction('COMPLETED', 'GWH');
  assert.equal(stock(M, 'B1'), 95);
  assert.ok(alerts.some(a => a.includes('saved successfully')), alerts.join('|'));
});

test('wholesale: converting a QUOTATION to an invoice only deducts the new quantity (a quote never held stock)', async () => {
  const { M, alerts, api } = wholesale({ mut: DB => { DB.sales[0].type = 'QUOTATION'; DB.sales[0].is_quotation = true; DB.sales[0].status = 'QUOTATION'; DB.journal_entries.length = 0; } });
  await api.saveTransaction('COMPLETED', 'GWH');
  assert.equal(stock(M, 'B1'), 75);
  assert.ok(alerts.some(a => a.includes('saved successfully')), alerts.join('|'));
});

test('wholesale new sale: if the stock deduction fails the half-created sale is removed', async () => {
  const { M, alerts, api } = wholesale({ edit: false, failures: { 'rpc.adjust_batch_qty': [1] } });
  M.fail('batches.update', 'all');
  M.DB.sales = []; M.DB.sale_items = []; M.DB.journal_entries = [];
  await api.saveTransaction('COMPLETED', 'GWH');
  assert.equal(stock(M, 'B1'), 80);
  assert.equal(M.DB.sales.length, 0); assert.equal(M.DB.sale_items.length, 0);
  assert.ok(alerts.some(a => a.includes('could NOT be saved completely')), alerts.join('|'));
});

test('wholesale delete: stock comes back, sale + lines + ledger go', async () => {
  const { M, api } = wholesale();
  await api.deleteSaleRecord('S1', 'GWH-1');
  assert.equal(stock(M, 'B1'), 100);
  assert.equal(M.DB.sales.length, 0); assert.equal(lines(M).length, 0); assert.equal(M.DB.journal_entries.length, 0);
});

test('wholesale delete: if stock cannot be restored, nothing is deleted', async () => {
  const { M, alerts, api } = wholesale({ failures: { 'rpc.adjust_batch_qty': 'all' } });
  M.fail('batches.update', 'all');
  await api.deleteSaleRecord('S1', 'GWH-1');
  assert.equal(stock(M, 'B1'), 80);
  assert.equal(M.DB.sales.length, 1); assert.equal(lines(M).length, 1);
  assert.ok(alerts.some(a => a.includes('nothing was deleted')), alerts.join('|'));
});

test('wholesale delete: if the lines cannot be deleted, the restored stock is taken off again', async () => {
  const { M, api } = wholesale({ failures: { 'sale_items.delete': 'all' } });
  await api.deleteSaleRecord('S1', 'GWH-1');
  assert.equal(stock(M, 'B1'), 80);
  assert.equal(M.DB.sales.length, 1);
});

// ====================================================================
// RETAIL delete
// ====================================================================
const RT_BASE = {
  batches: [{ id: 'B1', total_qty: 80 }, { id: 'B2', total_qty: 10 }],
  sales: [{ id: 'S1', sale_id: 'GRI-1', type: 'COMPLETED', is_quotation: false }],
  sale_items: [
    { id: 'I1', sale_id: 'S1', product_id: 'P1', batch_id: 'B1', quantity: 20, pack_size: 'EACH' },
    { id: 'I2', sale_id: 'S1', product_id: 'P2', batch_id: 'B2', quantity: 2, pack_size: '10' }],
  products: [{ id: 'P1', is_bundle: false }, { id: 'P2', is_bundle: false }], bundle_components: [],
  journal_entries: [{ id: 'J1', reference: 'GRI-1' }, { id: 'J2', reference: 'GRI-1-COGS' }], journal_lines: [], customer_receipt_invoices: [],
};
function retail(fails = {}) {
  const M = makeDB(RT_BASE); const alerts = [];
  for (const k in fails) M.fail(k, fails[k]);
  const env = { supabaseClient: M.client, alert: m => alerts.push(m), confirm: () => true, currentUserRole: 'Admin', document: { getElementById: () => ({ value: '' }) }, searchSalesRecords() {} };
  const api = instantiate('pages/transaction/retail/index.js', ['adjustBatchStock', 'deleteSaleRecord'], env, '', ['deleteSaleRecord']);
  return { M, alerts, api };
}

test('retail delete: every batch is restored (a pack of 10 counts as 10) and the sale disappears', async () => {
  const { M, api } = retail();
  await api.deleteSaleRecord('S1', 'GRI-1');
  assert.deepEqual(names(M), [100, 30]);
  assert.equal(M.DB.sales.length, 0); assert.equal(M.DB.sale_items.length, 0); assert.equal(M.DB.journal_entries.length, 0);
});

test('retail delete: restore fails -> stock unchanged, sale intact, user told', async () => {
  const { M, alerts, api } = retail({ 'rpc.adjust_batch_qty': 'all', 'batches.update': 'all' });
  await api.deleteSaleRecord('S1', 'GRI-1');
  assert.deepEqual(names(M), [80, 10]);
  assert.equal(M.DB.sales.length, 1); assert.equal(M.DB.sale_items.length, 2);
  assert.ok(alerts.some(a => a.includes('nothing was deleted')), alerts.join('|'));
});

test('retail delete: a half-done restore is reverted', async () => {
  const { M, api } = retail({ 'rpc.adjust_batch_qty': [1], 'batches.update': [2] });
  await api.deleteSaleRecord('S1', 'GRI-1');
  assert.deepEqual(names(M), [80, 10]);
  assert.equal(M.DB.sales.length, 1);
});

test('retail delete: deleting the lines fails -> stock goes back to what it was', async () => {
  const { M, api } = retail({ 'sale_items.delete': 'all' });
  await api.deleteSaleRecord('S1', 'GRI-1');
  assert.deepEqual(names(M), [80, 10]);
  assert.equal(M.DB.sales.length, 1);
});

test('retail delete: pressing delete again after a partial failure never restores stock twice', async () => {
  const { M, api } = retail({ 'journal_entries.delete': [1] });
  await api.deleteSaleRecord('S1', 'GRI-1'); M.clearFail();
  const after1 = names(M);
  await api.deleteSaleRecord('S1', 'GRI-1');
  assert.deepEqual(names(M), after1);
  assert.equal(after1[0], 100);
});

// ====================================================================
// WRITE-OFF + DONATION delete
// ====================================================================
const WO_BASE = {
  batches: [{ id: 'B1', total_qty: 40 }, { id: 'B2', total_qty: 5 }],
  write_offs: [{ id: 'W1', reference_number: 'WO-1' }],
  write_off_items: [{ id: 'WI1', write_off_id: 'W1', batch_id: 'B1', qty_written_off: 10 }, { id: 'WI2', write_off_id: 'W1', batch_id: 'B2', qty_written_off: 3 }],
  sales: [{ id: 'AUD1', sale_id: 'WO-1', client_type: 'WRITEOFF' }],
  journal_entries: [{ id: 'J1', reference: 'WO-1' }], journal_lines: [{ id: 'L1', journal_entry_id: 'J1' }],
};
function writeoff(fails = {}) {
  const M = makeDB(WO_BASE); const alerts = [];
  for (const k in fails) M.fail(k, fails[k]);
  const env = { supabaseClient: M.client, alert: m => alerts.push(m), confirm: () => true, currentUserRole: 'Admin', document: { getElementById: () => ({ value: '' }) }, searchWriteOffRecords() {} };
  return { M, alerts, api: instantiate('pages/transaction/writeoff/index.js', ['adjustBatchStock', 'deleteWriteOffRecord'], env, '', ['deleteWriteOffRecord']) };
}
test('write-off delete: stock comes back, record, audit row and journal are removed', async () => {
  const { M, api } = writeoff();
  await api.deleteWriteOffRecord('W1', 'WO-1');
  assert.deepEqual(names(M), [50, 8]);
  assert.equal(M.DB.write_offs.length + M.DB.write_off_items.length + M.DB.journal_entries.length + M.DB.sales.length, 0);
});
test('write-off delete: restore fails -> record intact', async () => {
  const { M, alerts, api } = writeoff({ 'rpc.adjust_batch_qty': 'all', 'batches.update': 'all' });
  await api.deleteWriteOffRecord('W1', 'WO-1');
  assert.equal(stock(M, 'B1'), 40);
  assert.equal(M.DB.write_offs.length, 1); assert.equal(M.DB.write_off_items.length, 2);
  assert.ok(alerts.some(a => a.includes('nothing was deleted')), alerts.join('|'));
});
test('write-off delete: items cannot be deleted -> stock taken off again', async () => {
  const { M, api } = writeoff({ 'write_off_items.delete': 'all' });
  await api.deleteWriteOffRecord('W1', 'WO-1');
  assert.deepEqual(names(M), [40, 5]);
  assert.equal(M.DB.write_offs.length, 1);
});
test('write-off delete: retry after a journal failure restores exactly once', async () => {
  const { M, api } = writeoff({ 'journal_lines.delete': [1] });
  await api.deleteWriteOffRecord('W1', 'WO-1'); M.clearFail();
  await api.deleteWriteOffRecord('W1', 'WO-1');
  assert.deepEqual(names(M), [50, 8]);
  assert.equal(M.DB.write_offs.length, 0);
});

const DON_BASE = {
  batches: [{ id: 'B1', total_qty: 40 }],
  sales: [{ id: 'D1', sale_id: 'DON-1', is_quotation: false }],
  sale_items: [{ id: 'I1', sale_id: 'D1', batch_id: 'B1', quantity: 2, pack_size: '10' }],
  journal_entries: [{ id: 'J1', reference: 'DON-1' }], journal_lines: [],
};
function donation(fails = {}) {
  const M = makeDB(DON_BASE); const alerts = [];
  for (const k in fails) M.fail(k, fails[k]);
  const env = { supabaseClient: M.client, alert: m => alerts.push(m), confirm: () => true, currentUserRole: 'Admin', document: { getElementById: () => ({ value: '' }) }, searchDonationRecords() {}, searchSalesRecords() {} };
  return { M, alerts, api: instantiate('pages/transaction/donation/index.js', ['adjustBatchStock', 'deleteDonationRecord'], env, '', ['deleteDonationRecord']) };
}
test('donation delete: 2 packs of 10 come back as 20 units', async () => {
  const { M, api } = donation();
  await api.deleteDonationRecord('D1', 'DON-1');
  assert.equal(stock(M, 'B1'), 60);
  assert.equal(M.DB.sales.length, 0);
});
test('donation delete: restore fails -> donation intact', async () => {
  const { M, api } = donation({ 'rpc.adjust_batch_qty': 'all', 'batches.update': 'all' });
  await api.deleteDonationRecord('D1', 'DON-1');
  assert.equal(stock(M, 'B1'), 40);
  assert.equal(M.DB.sales.length, 1);
});
