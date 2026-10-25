'use strict';
// Runs every *.test.js under tests/ with Node's built-in test runner.
// Usage:  node tests/run.js            (all)      node tests/run.js unit
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.test.js') ? [path.join(d, e.name)] : [])); }
const filter = process.argv[2];
const files = walk(__dirname).filter(f => !filter || f.includes(path.sep + filter + path.sep));
if (!files.length) { console.log('no tests found'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
