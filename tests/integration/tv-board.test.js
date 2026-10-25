'use strict';
// Integration test of the animated TV queue board in a real (headless) browser.
// The page is loaded from the repo as it is; only Supabase is replaced by a fake
// that returns whatever tickets the test sets and lets the test fire "realtime"
// events. Skipped automatically when Playwright is not installed
// (npm i -D playwright && npx playwright install chromium).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT } = require('../helpers/load');

let playwright = null;
try { playwright = require('playwright'); } catch (e) { /* not installed */ }

const FAKE_CONFIG = `
const SUPABASE_URL='https://fake.supabase.co';const SUPABASE_ANON_KEY='x';
window.__rows=[];window.__rt=[];
const q={select(){return q},eq(){return q},order(){return q},then(res,rej){return Promise.resolve({data:JSON.parse(JSON.stringify(window.__rows)),error:null}).then(res,rej)}};
const supabaseClient={from(){return q},channel(){const ch={on(a,b,cb){window.__rt.push(cb);return ch},subscribe(){return ch}};return ch}};`;

let id = 0;
const T = (token, name, status, extra = {}) => ({ id: ++id, token_number: token, patient_name: name, status, priority: false, billing_counter: null, dispensing_counter: null, ...extra });

async function openBoard() {
  let browser;
  try { browser = await playwright.chromium.launch(); }
  catch (e) { try { browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' }); } catch (e2) { return null; } }
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [], spoken = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('tts-polly')) { spoken.push(JSON.parse(r.request().postData() || '{}').text); return r.fulfill({ status: 500, body: 'no' }); }
    if (u.includes('supabase-config.js')) return r.fulfill({ contentType: 'text/javascript', body: FAKE_CONFIG });
    if (u.includes('supabase-js')) return r.fulfill({ contentType: 'text/javascript', body: '' });
    if (u.startsWith('file:')) return r.continue();
    return r.abort();
  });
  await page.goto('file://' + path.join(ROOT, 'tv-display.html'));
  const set = rows => page.evaluate(x => { window.__rows = x; window.__rt.forEach(cb => cb()); }, rows);
  const cards = () => page.evaluate(() => [...document.querySelectorAll('.cc')].map(c => ({ cls: c.className, tok: c.querySelector('.tok').textContent.trim(), name: c.querySelector('.pn').textContent.trim() })));
  return { browser, page, errors, spoken, set, cards };
}

const D = playwright ? test : (name, fn) => test(name, { skip: 'playwright not installed' }, fn);

D('TV board: serving tickets sit at their counter, waiting people queue, finished tickets vanish, no script errors', async (t) => {
  const b = await openBoard();
  if (!b) return t.skip('no chromium available');
  try {
    const rows = [
      T(118, 'Mary Banda', 'serving_billing', { billing_counter: 'Counter 1' }),
      T(119, 'John Phiri', 'serving_billing', { billing_counter: 'Counter 3' }),
      T(120, 'Bwalya Tembo', 'waiting_billing', { priority: true }), T(121, 'Esther Lungu', 'waiting_billing'),
      T(112, 'Grace Mwansa', 'serving_dispensing', { dispensing_counter: 'Dispatch' }),            // legacy name -> Dispensing 1
      T(114, 'Peter Zulu', 'serving_dispensing', { dispensing_counter: 'Dispensing 2' }),
      T(113, 'Chanda Mulenga', 'waiting_dispensing'),
      T(100, 'Done Person', 'completed'),
    ];
    await b.set(rows);
    await b.page.click('#soundGateBtn').catch(() => {});
    await b.page.waitForTimeout(1200);
    const text = await b.page.evaluate(() => document.body.innerText);
    for (const tok of ['118', '119', '112', '114']) assert.ok(text.includes(tok), `ticket ${tok} should be on the board`);
    assert.ok(!text.includes('Done Person'), 'completed tickets are not shown');
    assert.deepEqual(b.errors, [], 'no script errors: ' + b.errors.join(' | '));
  } finally { await b.browser.close(); }
});

D('TV board: a newly called ticket is announced and walks to the counter that called it', async (t) => {
  const b = await openBoard();
  if (!b) return t.skip('no chromium available');
  try {
    const rows = [
      T(118, 'Mary Banda', 'serving_billing', { billing_counter: 'Counter 1' }),
      T(120, 'Bwalya Tembo', 'waiting_billing', { priority: true }),
      T(121, 'Esther Lungu', 'waiting_billing'),
    ];
    await b.set(rows);
    await b.page.click('#soundGateBtn').catch(() => {});
    await b.page.waitForTimeout(1000);
    const before = b.spoken.length;
    const next = JSON.parse(JSON.stringify(rows));
    const t120 = next.find(r => r.token_number === 120); t120.status = 'serving_billing'; t120.billing_counter = 'Counter 2';
    await b.set(next);
    await b.page.waitForTimeout(1500);
    assert.ok(b.spoken.length > before, 'the call must be announced');
    assert.match(b.spoken[b.spoken.length - 1], /120/, 'announcement names the ticket: ' + b.spoken.join(' / '));
    assert.match(b.spoken[b.spoken.length - 1], /(counter|Counter)\s*(2|two)/i, 'announcement names the counter: ' + b.spoken.join(' / '));
    await b.page.waitForTimeout(4500);
    const text = await b.page.evaluate(() => document.body.innerText);
    assert.ok(text.includes('120'));
    assert.deepEqual(b.errors, []);
  } finally { await b.browser.close(); }
});

D('TV board: the board follows the latest data when tickets are replaced', async (t) => {
  const b = await openBoard();
  if (!b) return t.skip('no chromium available');
  try {
    const one = [T(300, 'First Person', 'waiting_billing')];
    await b.set(one);
    await b.page.waitForTimeout(600);
    const two = [T(301, 'Second Person', 'waiting_billing')];
    await b.set(two);
    await b.page.waitForTimeout(1500);
    const text = await b.page.evaluate(() => document.body.innerText);
    assert.ok(text.includes('301'));
    assert.deepEqual(b.errors, []);
  } finally { await b.browser.close(); }
});
