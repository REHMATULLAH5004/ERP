'use strict';
// ============================================================================
// Loads functions out of the ERP's browser scripts so they can be tested in
// Node WITHOUT changing the production files.
//
//   loadFns('pages/hr/payroll/index.js', ['calculatePAYE'], { consts: '...' })
//
// pulls the named function(s) (even when they are nested inside an
// (async function init(){...})() wrapper) out of the file's text, compiles
// them in an isolated sandbox, and returns them. Anything the functions use
// from the surrounding page (constants, helpers, supabaseClient, document...)
// is passed in through `consts` (source text) and `globals` (objects).
// ============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

// Finds `function name(` / `async function name(` and returns its full text.
function grabFunction(src, name) {
  const re = new RegExp('^[ \\t]*(?:async\\s+)?function\\s+' + name.replace(/[$]/g, '\\$') + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) throw new Error('function not found: ' + name);
  let i = src.indexOf('{', src.indexOf(')', m.index + m[0].length - 1));
  let depth = 0, k = i, inStr = null, esc = false, lineC = false, blockC = false;
  const tplStack = []; // brace depth at which each open `${` expression started
  for (; k < src.length; k++) {
    const c = src[k], n = src[k + 1];
    if (lineC) { if (c === '\n') lineC = false; continue; }
    if (blockC) { if (c === '*' && n === '/') { blockC = false; k++; } continue; }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (inStr === '`' && c === '$' && n === '{') { tplStack.push(depth); depth++; inStr = null; k++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { lineC = true; continue; }
    if (c === '/' && n === '*') { blockC = true; continue; }
    if (c === '/') { // regular-expression literal?  (a "/" right after one of these characters cannot be a division)
      let b = k - 1; while (b >= 0 && /\s/.test(src[b])) b--;
      if (b < 0 || '(,=:[!&|?{};+-*%<>~^'.includes(src[b]) || /\breturn$/.test(src.slice(Math.max(0, b - 5), b + 1))) {
        let j = k + 1, cls = false;
        for (; j < src.length; j++) {
          const d = src[j];
          if (d === '\\') { j++; continue; }
          if (d === '[') cls = true; else if (d === ']') cls = false;
          else if (d === '/' && !cls) break;
          else if (d === '\n') break;
        }
        k = j; continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (tplStack.length && tplStack[tplStack.length - 1] === depth) { tplStack.pop(); inStr = '`'; continue; }
      if (depth === 0) break;
    }
  }
  return src.slice(m.index, k + 1);
}

function loadFns(rel, names, opts) {
  opts = opts || {};
  const src = readSource(rel);
  const parts = [opts.consts || ''];
  for (const n of names) parts.push(grabFunction(src, n));
  const code = parts.join('\n') + '\n;({' + names.join(',') + '})';
  const sandbox = Object.assign({ console, Math, Date, JSON, Number, String, Array, Object, Set, Map, parseInt, parseFloat, isNaN, RegExp, Promise, setTimeout, clearTimeout }, opts.globals || {});
  return vm.runInNewContext(code, sandbox, { filename: rel });
}

// For plain scripts that declare top-level functions/consts (shared utils).
function loadScript(rel, names, globals) {
  const src = readSource(rel);
  const code = src + '\n;({' + names.join(',') + '})';
  const sandbox = Object.assign({ console, Math, Date, JSON, Number, String, Array, Object, Set, Map, parseInt, parseFloat, isNaN, RegExp, Promise, window: {}, document: { addEventListener() {} } }, globals || {});
  return vm.runInNewContext(code, sandbox, { filename: rel });
}


// Builds a working copy of some of a page's functions wired to a fake
// environment (fake Supabase client, alert collector, ...) so whole flows such
// as "save an edited invoice" can be run end to end without a browser.
//   const api = instantiate('pages/transaction/retail/index.js', ['adjustBatchStock','deleteSaleRecord'], env, 'let x = null;', ['deleteSaleRecord'])
function instantiate(rel, names, env, preamble, exportNames) {
  const src = readSource(rel);
  const code = (preamble || '') + '\n' + names.map(n => grabFunction(src, n)).join('\n') + '\n;({' + (exportNames || names).join(',') + '})';
  const base = { Math, Date, JSON, Number, String, Array, Object, Set, Map, parseInt, parseFloat, isNaN, RegExp, Promise, setTimeout, clearTimeout };
  const quiet = { log() {}, warn() {}, error() {} };
  return vm.runInNewContext(code, Object.assign(base, { console: quiet }, env), { filename: rel });
}

module.exports = { ROOT, readSource, grabFunction, loadFns, loadScript, instantiate };
