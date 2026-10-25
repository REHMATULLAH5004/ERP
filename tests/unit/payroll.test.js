'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFns } = require('../helpers/load');

// Zambian PAYE bands as used by the payroll page:
// first K5,100 at 0%, next K2,000 at 20%, next K2,100 at 30%, the rest at 37%.
const { calculatePAYE } = loadFns('pages/hr/payroll/index.js', ['calculatePAYE']);

test('PAYE: nothing is taxed up to K5,100', () => {
  assert.equal(calculatePAYE(0), 0);
  assert.equal(calculatePAYE(3000), 0);
  assert.equal(calculatePAYE(5100), 0);
});

test('PAYE: worked example from the payroll spec (K6,500 gross -> K280 tax)', () => {
  assert.equal(calculatePAYE(6500), 280);
});

test('PAYE: band boundaries are exact', () => {
  assert.equal(calculatePAYE(7100), 400);              // 2000 * 20%
  assert.equal(calculatePAYE(9200), 400 + 630);        // + 2100 * 30%
  assert.equal(calculatePAYE(10200), 400 + 630 + 370); // + 1000 * 37%
});

test('PAYE: tax never goes down when salary goes up', () => {
  let prev = -1;
  for (let g = 0; g <= 30000; g += 250) {
    const t = calculatePAYE(g);
    assert.ok(t >= prev, `tax fell at gross ${g}`);
    prev = t;
  }
});

test('PAYE: a negative or missing salary pays no tax', () => {
  assert.equal(calculatePAYE(-500), 0);
});
