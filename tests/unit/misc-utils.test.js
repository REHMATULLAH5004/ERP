'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFns, loadScript } = require('../helpers/load');
const { plain } = require('../helpers/plain');

// ---------------- CSV ----------------
const PM = loadFns('pages/inventory/product-master/index.js', ['parseCSVLine']);
test('parseCSVLine: quotes, embedded commas, doubled quotes and inch marks', () => {
  assert.deepEqual(plain(PM.parseCSVLine('a,b,c')), ['a', 'b', 'c']);
  assert.deepEqual(plain(PM.parseCSVLine('"Crile Forcep 5"" Straight",12,"x,y"')), ['Crile Forcep 5" Straight', '12', 'x,y']);
  assert.deepEqual(plain(PM.parseCSVLine('a,,c,')), ['a', '', 'c', '']);
  assert.deepEqual(plain(PM.parseCSVLine('')), ['']);
  assert.deepEqual(plain(PM.parseCSVLine('5" tube,2')), ['5" tube', '2']); // a quote that does not start a field is kept as text
});

// ---------------- backups formatBytes ----------------
const BK = loadFns('pages/admin/backups/index.js', ['formatBytes']);
test('formatBytes', () => {
  assert.equal(BK.formatBytes(null), '--');
  assert.equal(BK.formatBytes(undefined), '--');
  assert.equal(BK.formatBytes(0), '0 B');
  assert.equal(BK.formatBytes(1023), '1023 B');
  assert.equal(BK.formatBytes(1024), '1.0 KB');
  assert.equal(BK.formatBytes(1536), '1.5 KB');
  assert.equal(BK.formatBytes(5 * 1024 * 1024), '5.00 MB');
});

// ---------------- NHIMA weekly report matching ----------------
const RC = loadFns('pages/transaction/receipts/index.js', ['nhimaSuffixKey', 'parseNhimaReportRows']);
test('nhimaSuffixKey keeps the last two parts so "GRI-2026-077328-3384" and "077328-3384" match', () => {
  assert.equal(RC.nhimaSuffixKey('GRI-2026-077328-3384'), '077328-3384');
  assert.equal(RC.nhimaSuffixKey('077328-3384'), '077328-3384');
  assert.equal(RC.nhimaSuffixKey(' gri 2026 077328 3384 '), '077328-3384');
  assert.equal(RC.nhimaSuffixKey('ABC'), 'ABC');
  assert.equal(RC.nhimaSuffixKey(null), '');
});

test('parseNhimaReportRows sums line items per claim and reads the period from row 3', () => {
  const rows = [
    ['ZM580826 GRIFFINS MEDICALS LIMITED'],
    ['Weekly claim report'],
    ['2026-08-30 - 2026-09-05'],
    ['Claim Number', 'Member Number', 'Treatment Date', 'Gross Amount'],
    ['GRI-2026-077328-3384', '4931', '2026-09-01 10:00', 100.5],
    ['GRI-2026-077328-3384', '4931', '2026-09-01 10:00', '49.5'],
    ['GRI-2026-209664-3170', '5555', '2026-09-02', 10],
    [null, null, null, null],
    [null, 'x', 'y', 5],                       // line without a claim number is ignored
  ];
  const r = RC.parseNhimaReportRows(rows);
  assert.equal(r.startDate, '2026-08-30');
  assert.equal(r.endDate, '2026-09-05');
  assert.deepEqual(Object.keys(r.nhimaClaims).sort(), ['077328-3384', '209664-3170']);
  assert.equal(r.nhimaClaims['077328-3384'].grossTotal, 150);
  assert.equal(r.nhimaClaims['077328-3384'].treatmentDate, '2026-09-01');
});

test('parseNhimaReportRows survives a file with no period and no data', () => {
  const r = RC.parseNhimaReportRows([[], [], [], ['Claim Number', 'Gross Amount']]);
  assert.equal(r.startDate, null);
  assert.deepEqual(plain(r.nhimaClaims), {});
});

// ---------------- sale prefixes / customer cache ----------------
const RT = loadFns('pages/transaction/retail/index.js', ['getRetailPrefix', 'customerCacheKey', 'classifyDosageForm', 'buildDoseSentence'], {
  consts: `
const companySettings = { retail_prefix_nhima: 'GRI', retail_prefix_online: 'GRO', retail_prefix_staff: 'GRS', retail_prefix_regular: 'GRR' };
const DOSE_TIME_CONFIG = {
  morning: { phrase: 'in the morning', meal: 'breakfast' },
  noon: { phrase: 'at noon', meal: 'lunch' },
  evening: { phrase: 'in the evening', meal: 'dinner' },
  bedtime: { phrase: 'before bed', meal: null }
};
const DOSE_TIME_ORDER = ['morning', 'noon', 'evening', 'bedtime'];`,
});

test('retail invoice prefix depends on the customer sub-type, defaulting to REGULAR', () => {
  assert.equal(RT.getRetailPrefix('NHIMA'), 'GRI');
  assert.equal(RT.getRetailPrefix('ONLINE'), 'GRO');
  assert.equal(RT.getRetailPrefix('STAFF'), 'GRS');
  assert.equal(RT.getRetailPrefix('REGULAR'), 'GRR');
  assert.equal(RT.getRetailPrefix(undefined), 'GRR');
  assert.equal(RT.getRetailPrefix('SOMETHING_NEW'), 'GRR');
});

test('customer cache key: NHIMA number for NHIMA sales, phone otherwise, none when unknown', () => {
  assert.equal(RT.customerCacheKey({ nhima_number: '49310691110129/00', phone: '+260971' }, 'NHIMA'), 'N|49310691110129/00');
  assert.equal(RT.customerCacheKey({ phone: '+260971' }, 'NHIMA'), 'P|+260971');
  assert.equal(RT.customerCacheKey({ nhima_number: 'x', phone: '+260971' }, 'REGULAR'), 'P|+260971');
  assert.equal(RT.customerCacheKey({}, 'REGULAR'), null);
  assert.equal(RT.customerCacheKey(null, 'NHIMA'), null);
});

const WS = loadFns('pages/transaction/wholesale/index.js', ['getWholesalePrefix'], {
  consts: `const companySettings = { wholesale_prefix: 'GW', wholesale_prefix_internal: 'GWI', wholesale_prefix_regular: null };`,
});
test('wholesale prefix: INTERNAL has its own, others fall back to the general one', () => {
  assert.equal(WS.getWholesalePrefix('INTERNAL'), 'GWI');
  assert.equal(WS.getWholesalePrefix('REGULAR'), 'GW');
});

// ---------------- dosage wording on the sticker ----------------
test('dosage form is guessed from the product form name', () => {
  assert.equal(RT.classifyDosageForm('Injection'), 'injectable');
  assert.equal(RT.classifyDosageForm('Powder for injection'), 'injectable');
  assert.equal(RT.classifyDosageForm('Vial'), 'injectable');
  assert.equal(RT.classifyDosageForm('Syrup'), 'liquid');
  assert.equal(RT.classifyDosageForm('Oral suspension'), 'liquid');
  assert.equal(RT.classifyDosageForm('Eye drops'), 'liquid');
  assert.equal(RT.classifyDosageForm('Tablet'), 'tablet');
  assert.equal(RT.classifyDosageForm(''), 'tablet');
  assert.equal(RT.classifyDosageForm(null), 'tablet');
});

test('dose sentence: tablets, one line per ticked time, in day order', () => {
  const s = RT.buildDoseSentence({ qty: 2, form: 'tablet', times: ['evening', 'morning'], foodRelation: 'after' });
  assert.equal(s, '2 tablets in the morning after breakfast.\n2 tablets in the evening after dinner.');
  assert.equal(RT.buildDoseSentence({ qty: 1, form: 'tablet', times: ['bedtime'], foodRelation: 'before' }), '1 tablet before bed, before food.');
});

test('dose sentence: liquids and injections', () => {
  assert.equal(RT.buildDoseSentence({ qty: 5, form: 'liquid', times: ['morning', 'evening'] }), '5ml in the morning.\n5ml in the evening.');
  assert.equal(RT.buildDoseSentence({ qty: 2, form: 'injectable', unit: 'ml', route: 'IM', oneTime: true }), '2ml IM, single dose.');
  assert.equal(RT.buildDoseSentence({ qty: 1, form: 'injectable', unit: 'vial', route: 'IV', times: ['noon'] }), '1 vial(s) IV at noon.');
});

test('dose sentence: bad quantity falls back to 1, and a note is appended', () => {
  assert.equal(RT.buildDoseSentence({ qty: 'abc', times: ['morning'], note: '  Finish the course ' }), '1 tablet in the morning.\nFinish the course');
  assert.equal(RT.buildDoseSentence({ qty: -3, times: [] }), '');
});

// ---------------- queue: counter -> stage ----------------
const QB = loadFns('assets/js/Shared-queue-bar.js', ['stageForCounter']);
test('queue counters map to the right stage; legacy "Dispatch" still counts as dispensing', () => {
  for (const c of ['Counter 1', 'Counter 2', 'Counter 3']) assert.equal(QB.stageForCounter(c), 'billing');
  for (const c of ['Dispensing 1', 'Dispensing 2', 'Dispensing 3', 'Dispatch']) assert.equal(QB.stageForCounter(c), 'dispensing');
  assert.equal(QB.stageForCounter('Counter 4'), null);
  assert.equal(QB.stageForCounter(null), null);
});

// ---------------- CSV export cell ----------------
test('csvCell quotes anything that would break a CSV', () => {
  const src = require('fs').readFileSync(require('path').join(require('../helpers/load').ROOT, 'assets/js/shared-excel-export.js'), 'utf8');
  assert.ok(/function csvCell/.test(src));
  const X = loadFns('assets/js/shared-excel-export.js', ['csvCell']);
  assert.equal(X.csvCell(null), '');
  assert.equal(X.csvCell(12.5), '12.5');
  assert.equal(X.csvCell('a,b'), '"a,b"');
  assert.equal(X.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(X.csvCell('line1\nline2'), '"line1\nline2"');
});
