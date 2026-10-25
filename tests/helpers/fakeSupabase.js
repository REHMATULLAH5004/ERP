'use strict';
// A small in-memory stand-in for the Supabase client used by the ERP pages.
// Supports the calls the pages actually make: from().select/insert/update/
// delete/upsert with eq/in/neq/gte/lte/order/limit/single/maybeSingle, and
// rpc() with registered handlers. Can be told to fail specific calls so the
// "what happens when the network fails half way" paths can be tested.
function makeDB(initial) {
  const DB = JSON.parse(JSON.stringify(initial || {}));
  const calls = {}; const failCfg = {}; const log = []; let idn = 1000;
  function shouldFail(key) {
    calls[key] = (calls[key] || 0) + 1;
    const f = failCfg[key];
    if (!f) return false;
    return f === 'all' || f.includes(calls[key]);
  }
  function from(table) {
    const st = { op: 'select', filters: [], payload: null, single: null, lim: null, ord: null };
    const api = {
      select() { return api; },
      insert(rows) { st.op = 'insert'; st.payload = Array.isArray(rows) ? rows : [rows]; return api; },
      upsert(rows) { st.op = 'upsert'; st.payload = Array.isArray(rows) ? rows : [rows]; return api; },
      update(p) { st.op = 'update'; st.payload = p; return api; },
      delete() { st.op = 'delete'; return api; },
      eq(c, v) { st.filters.push(r => r[c] === v); return api; },
      neq(c, v) { st.filters.push(r => r[c] !== v); return api; },
      in(c, vs) { st.filters.push(r => vs.includes(r[c])); return api; },
      gte(c, v) { st.filters.push(r => r[c] >= v); return api; },
      lte(c, v) { st.filters.push(r => r[c] <= v); return api; },
      order(c, o) { st.ord = [c, !(o && o.ascending === false)]; return api; },
      limit(n) { st.lim = n; return api; },
      single() { st.single = 'single'; return api; },
      maybeSingle() { st.single = 'maybe'; return api; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    function run() {
      const T = DB[table];
      if (!T) return { data: null, error: { message: 'no table ' + table } };
      if (shouldFail(table + '.' + st.op)) return { data: null, error: { message: 'forced fail ' + table + '.' + st.op } };
      log.push({ table, op: st.op });
      let out;
      if (st.op === 'insert' || st.op === 'upsert') {
        out = st.payload.map(r => { const x = { id: r.id || ('id' + (idn++)), ...r }; T.push(x); return x; });
      } else {
        let rows = T.filter(r => st.filters.every(f => f(r)));
        if (st.op === 'update') rows.forEach(r => Object.assign(r, st.payload));
        if (st.op === 'delete') rows.forEach(r => T.splice(T.indexOf(r), 1));
        if (st.ord) rows = rows.slice().sort((a, b) => (a[st.ord[0]] > b[st.ord[0]] ? 1 : -1) * (st.ord[1] ? 1 : -1));
        out = rows.map(r => ({ ...r }));
        if (st.lim) out = out.slice(0, st.lim);
      }
      if (st.single) {
        if (st.single === 'single' && out.length !== 1) return { data: null, error: { message: 'single() needs exactly one row, got ' + out.length } };
        return { data: out[0] ? { ...out[0] } : null, error: null };
      }
      return { data: out, error: null };
    }
    return api;
  }
  const rpcHandlers = {
    // atomic delta update, same as the real adjust_batch_qty()
    adjust_batch_qty(args) {
      let n = 0;
      for (const e of args.p_adjustments) {
        const b = DB.batches.find(x => x.id === e.batch_id);
        if (b) { b.total_qty += Number(e.delta); n++; }
      }
      return n;
    },
    // same as the real reverse_sale_accounting(): removes the sale's journal entries
    reverse_sale_accounting(args) {
      const ids = DB.journal_entries.filter(j => j.reference === args.p_sale_id || j.reference === args.p_sale_id + '-COGS').map(j => j.id);
      DB.journal_entries = DB.journal_entries.filter(j => !ids.includes(j.id));
      if (DB.journal_lines) DB.journal_lines = DB.journal_lines.filter(l => !ids.includes(l.journal_entry_id));
      return ids.length;
    },
  };
  const client = {
    from,
    async rpc(name, args) {
      if (shouldFail('rpc.' + name)) return { data: null, error: { message: 'forced fail rpc ' + name } };
      const h = rpcHandlers[name];
      if (!h) return { data: null, error: { message: 'unknown rpc ' + name } };
      return { data: h(args || {}), error: null };
    },
  };
  return {
    DB, client, calls, log,
    onRpc(name, fn) { rpcHandlers[name] = fn; },
    fail(key, v) { failCfg[key] = v; },
    clearFail() { for (const k in failCfg) delete failCfg[k]; for (const k in calls) delete calls[k]; },
  };
}
module.exports = { makeDB };
