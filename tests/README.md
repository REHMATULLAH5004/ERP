# Griffins ERP – automated tests

Run from the repository root (needs Node 20+; **no packages to install**):

```
npm test                  # everything
npm run test:unit         # small pieces of logic
npm run test:integration  # whole save / edit / delete flows + the TV board
```

## What is here

| Folder | What it tests | How |
|---|---|---|
| `tests/unit/` | Pure logic: payroll (PAYE, NAPSA cap, NHIMA), attendance hours, depreciation, pricing / pack sizes / stock maths, report chart helpers, patient-form validation (NRC, NHIMA number, phone, names), CSV parsing, NHIMA weekly-report matching, invoice prefixes, dose wording on stickers, counter → queue stage | The test pulls the named functions out of the real page file (`tests/helpers/load.js`) and runs them in isolation – **the page files are not modified to be tested** |
| `tests/integration/stock-safety.test.js` | Wholesale save / edit / delete, retail delete, write-off delete, donation delete – including “network fails half way”: stock, lines and ledger must never end up half-changed | The real page functions run against an in-memory Supabase (`tests/helpers/fakeSupabase.js`) that can be told to fail specific calls |
| `tests/integration/tv-board.test.js` | The animated TV board in a real headless browser: serving tickets at their counter, announcement when a ticket is called, completed tickets disappear, no script errors | Playwright. Skipped automatically if not installed: `npm i -D playwright && npx playwright install chromium` |
| `tests/sql/consistency_checks.sql` | Live-data health checks (negative stock, unbalanced journals, duplicate invoice numbers, orphan lines, sale vs ledger, stale / double-booked queue tickets). **Read-only.** Every check should return zero rows | Paste into the Supabase SQL editor |

## Test-driven development: how to add to this

1. Write the test first for the behaviour you want (or the bug you saw). Run it – it must **fail** (red).
2. Change the page code as little as possible until it passes (green).
3. Run `npm test` – everything else must still be green.

Two real examples already came out of this:

* `calculateDepreciation` returned `NaN` for “remaining life” when cost = salvage value or cost = 0 → test written first, then fixed in `pages/account/fixed-assets/index.js`.
* `parseCSVLine` swallowed the rest of the row when an unquoted field contained a `"` (e.g. `5" tube`) → test written first, then fixed in `pages/inventory/product-master/index.js`.

## Adding a test for another page function

```js
const { loadFns } = require('../helpers/load');
const P = loadFns('pages/some/page/index.js', ['myFunction'], { consts: 'const SOME_CONSTANT = 5;' });
test('does the thing', () => assert.equal(P.myFunction(2), 10));
```

For a whole flow use `instantiate(...)` with `makeDB(...)` (see `stock-safety.test.js`).
