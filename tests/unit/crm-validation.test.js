'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFns } = require('../helpers/load');

const consts = `
const ZM_PHONE_DIGITS = 9;
const NRC_REGEX = /^\\d{6}\\/\\d{2}\\/\\d$/;
const NHIMA_REGEX = /^(?:\\d{14}\\/\\d{2}|NHA\\d{13}\\/\\d{2})$/;
const NAME_REGEX = /^[A-Za-z][A-Za-z '.-]*$/;
const fmtDate = d => new Date(d).toISOString().slice(0, 10);
`;
const V = loadFns('pages/crm/crm-view.js',
  ['escapeHtml', 'toProperCaseIfAllCaps', 'validateNameValue', 'validateNrcValue', 'validateNhimaNumberValue', 'buildZmPhone', 'validatePhoneDigitsValue', 'computeDueBanner'],
  { consts });

test('names: letters, spaces, hyphen, apostrophe, full stop are allowed; digits are not', () => {
  assert.equal(V.validateNameValue("Mary-Ann O'Neil Jr.", 'Name'), null);
  assert.match(V.validateNameValue('John2', 'Full name'), /Full name can only contain letters/);
  assert.match(V.validateNameValue('1John', 'Name'), /only contain letters/);
  assert.equal(V.validateNameValue('   ', 'Name'), null, 'blank is "not my job" - required-ness is checked elsewhere');
  assert.equal(V.validateNameValue(null, 'Name'), null);
});

test('NRC must look like 123456/78/9', () => {
  assert.equal(V.validateNrcValue('123456/78/9'), null);
  assert.equal(V.validateNrcValue(''), null);
  for (const bad of ['123456789', '12345/78/9', '123456/7/9', '123456/78/90', 'ABCDEF/78/9']) {
    assert.match(V.validateNrcValue(bad), /NRC must be in the format/, bad);
  }
});

test('NHIMA number: 14 digits/2 digits, or NHA + 13 digits/2 digits; case-insensitive; required', () => {
  assert.equal(V.validateNhimaNumberValue('49310691110129/00'), null);
  assert.equal(V.validateNhimaNumberValue('NHA1234567890123/01'), null);
  assert.equal(V.validateNhimaNumberValue('nha1234567890123/01'), null);
  assert.match(V.validateNhimaNumberValue(''), /NHIMA Number must be/);
  assert.match(V.validateNhimaNumberValue('4931069111012/00'), /NHIMA Number must be/);
  assert.match(V.validateNhimaNumberValue('49310691110129'), /NHIMA Number must be/);
});

test('phone: +260 plus exactly nine digits', () => {
  assert.equal(V.buildZmPhone('971234567'), '+260971234567');
  assert.equal(V.buildZmPhone('97 123-4567'), '+260971234567');
  assert.equal(V.buildZmPhone(''), '');
  assert.equal(V.validatePhoneDigitsValue('971234567', true), null);
  assert.equal(V.validatePhoneDigitsValue('', false), null);
  assert.equal(V.validatePhoneDigitsValue('', true), 'Phone Number is required');
  assert.match(V.validatePhoneDigitsValue('97123456', true), /exactly 9 digits.*got 8/);
  assert.match(V.validatePhoneDigitsValue('9712345678', false), /got 10/);
});

test('ALL-CAPS names are turned into Proper Case, mixed case is left alone', () => {
  assert.equal(V.toProperCaseIfAllCaps('JOHN BANDA'), 'John Banda');
  assert.equal(V.toProperCaseIfAllCaps('  MARY  '), 'Mary');
  assert.equal(V.toProperCaseIfAllCaps('John Banda'), 'John Banda');
  assert.equal(V.toProperCaseIfAllCaps('AB'), 'AB', 'two letters could be initials');
  assert.equal(V.toProperCaseIfAllCaps(''), '');
  assert.equal(V.toProperCaseIfAllCaps('123'), '123');
});

test('escapeHtml neutralises markup in patient-supplied text', () => {
  assert.equal(V.escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(V.escapeHtml("O'Neil & Sons"), 'O&#39;Neil &amp; Sons');
  assert.equal(V.escapeHtml(null), '');
  assert.equal(V.escapeHtml(undefined), '');
  assert.equal(V.escapeHtml(0), '0');
});

test('refill banner: warns when the patient comes back before the supply has run out', () => {
  const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
  const early = V.computeDueBanner([{ created_at: daysAgo(5), items: [{ days_supplied: 30 }, { days_supplied: 14 }] }]);
  assert.match(early.html, /Still has supply/);
  assert.match(early.html, /30-day supply/, 'uses the longest supply on the invoice');
  assert.equal(early.bg, '#fef2f2');
  const due = V.computeDueBanner([{ created_at: daysAgo(40), items: [{ days_supplied: 30 }] }]);
  assert.match(due.html, /Due --/);
  assert.equal(due.bg, '#ecfdf5');
});

test('refill banner: nothing to say without a previous sale or without days_supplied', () => {
  assert.equal(V.computeDueBanner([]), null);
  assert.equal(V.computeDueBanner(null), null);
  assert.equal(V.computeDueBanner([{ created_at: new Date().toISOString(), items: [{ days_supplied: 0 }, {}] }]), null);
});
