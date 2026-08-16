/* ==========================================================================
   ETF Dashboard — data loader
   Exposes: window.ETF
     .ready       Promise<void>        resolves once summary + lastDate ready
     .summary     Array<EtfMeta>       all ETFs
     .byCode(code) Promise<EtfSeries>  parsed rows for one ETF (cached)
     .all()       Promise<EtfSeries[]> all parsed (cached)
     .codes()     string[]
     .lastDate    'YYYY-MM-DD'
     .categories  string[]
   CSV schema (CN):  date,open,high,low,close,volume,amount,postVol,postAmt
   CSV schema (US):  date,open,high,low,close,volume
   ========================================================================== */
(function (global) {
  'use strict';

  // 兼容 GitHub Pages (docs/ 是部署根):CSVs 也在 docs/csv/ 下,与页面相对解析
  // 同时本地 `python3 -m http.server --directory docs` 也走 docs/csv/
  const CSV_BASE = 'csv/';

  /** @typedef {{date:string,open:number,high:number,low:number,close:number,volume:number}} Bar */
  /** @typedef {{code:string,name:string,category:string,csv:string,rows:Bar[]}} EtfSeries */
  /** @typedef {{code:string,name:string,category:string,csv:string,start_date:string,end_date:string,rows:number,success:boolean}} EtfMeta */

  const state = {
    summary: /** @type {EtfMeta[]} */ ([]),
    lastDate: /** @type {string} */ (''),
    byCodeCache: /** @type {Map<string, Promise<EtfSeries>>} */ (new Map()),
    allCache: /** @type {Promise<EtfSeries[]> | null} */ (null),
    ready: /** @type {Promise<void>} */ (Promise.resolve()),
  };

  function parseCsv(text) {
    // Handle BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (!lines.length) return [];
    const header = lines[0].split(',').map((s) => s.trim());
    const idx = (name) => header.indexOf(name);
    const iDate = idx('date');
    const iOpen = idx('open');
    const iHigh = idx('high');
    const iLow = idx('low');
    const iClose = idx('close');
    const iVol = idx('volume');

    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const close = parseFloat(cols[iClose]);
      if (!isFinite(close) || close <= 0) continue;
      out.push({
        date: cols[iDate],
        open: parseFloat(cols[iOpen]),
        high: parseFloat(cols[iHigh]),
        low: parseFloat(cols[iLow]),
        close,
        volume: parseFloat(cols[iVol]) || 0,
      });
    }
    return out;
  }

  async function fetchText(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.text();
  }

  function loadSummary() {
    return fetchText(CSV_BASE + 'summary.csv').then((txt) => {
      const lines = txt.split(/\r?\n/).filter((l) => l.length > 0);
      const header = lines[0].split(',').map((s) => s.trim());
      const out = [];
      let maxDate = '';
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        const rec = {};
        for (let j = 0; j < header.length; j++) rec[header[j]] = cols[j];
        if (rec.success !== 'True' && rec.success !== 'true') continue;
        const fname = (rec.csv_path || '').split('/').pop() || '';
        const meta = {
          code: rec.code,
          name: rec.name,
          category: rec.category,
          csv: fname,
          start_date: rec.start_date,
          end_date: rec.end_date,
          rows: parseInt(rec.rows, 10) || 0,
          success: true,
        };
        out.push(meta);
        if (meta.end_date && meta.end_date > maxDate) maxDate = meta.end_date;
      }
      state.summary = out;
      state.lastDate = maxDate;
      return out;
    });
  }

  function loadOne(meta) {
    const p = fetchText(CSV_BASE + meta.csv)
      .then(parseCsv)
      .then((rows) => ({ ...meta, rows }));
    state.byCodeCache.set(meta.code, p);
    return p;
  }

  const api = {
    get ready() { return state.ready; },
    get summary() { return state.summary; },
    get lastDate() { return state.lastDate; },
    codes() { return state.summary.map((m) => m.code); },
    categories() {
      const s = new Set();
      state.summary.forEach((m) => s.add(m.category));
      return [...s];
    },
    byCode(code) {
      if (state.byCodeCache.has(code)) return state.byCodeCache.get(code);
      const meta = state.summary.find((m) => m.code === code);
      if (!meta) return Promise.reject(new Error('unknown code: ' + code));
      return loadOne(meta);
    },
    all() {
      if (state.allCache) return state.allCache;
      state.allCache = Promise.all(state.summary.map((m) => {
        if (state.byCodeCache.has(m.code)) return state.byCodeCache.get(m.code);
        return loadOne(m);
      }));
      return state.allCache;
    },
    /** Force re-fetch everything (used by AI summary refresh). */
    refresh() {
      state.byCodeCache.clear();
      state.allCache = null;
      state.ready = loadSummary();
      return state.ready;
    },
  };

  state.ready = loadSummary();

  global.ETF = Object.assign(global.ETF || {}, api);
})(window);