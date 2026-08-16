/* ==========================================================================
   ETF Dashboard — shared utilities
   - window.ETF.utils: formatting, math, DOM helpers
   - depends on: nothing
   ========================================================================== */
(function (global) {
  'use strict';

  const Utils = {
    /** Format a number as percentage with sign. */
    pct(v, digits = 2) {
      if (v == null || !isFinite(v)) return '--';
      const sign = v > 0 ? '+' : '';
      return sign + (v * 100).toFixed(digits) + '%';
    },

    /** Format a number with thousand separators. */
    num(v, digits = 2) {
      if (v == null || !isFinite(v)) return '--';
      return Number(v).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    },

    /** Format a price (handles tiny ETF prices like 0.441). */
    price(v) {
      if (v == null || !isFinite(v)) return '--';
      return Number(v).toLocaleString('en-US', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      });
    },

    /** Format a large CNY amount as 万/亿. */
    moneyCNY(v) {
      if (v == null || !isFinite(v)) return '--';
      const abs = Math.abs(v);
      if (abs >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
      if (abs >= 1e4) return (v / 1e4).toFixed(2) + ' 万';
      return v.toFixed(2);
    },

    /** Format a date string YYYY-MM-DD for display. */
    date(s) {
      if (!s) return '--';
      return s;
    },

    /** CSS class for a value (positive = green, negative = red). */
    signClass(v) {
      if (v > 0) return 'pos';
      if (v < 0) return 'neg';
      return '';
    },

    /** Return last N trading-day closes (excluding today). */
    recentRows(rows, n, includeToday = false) {
      if (!rows || !rows.length) return [];
      const end = rows.length;
      const start = Math.max(0, end - n - (includeToday ? 0 : 1));
      return rows.slice(start, end);
    },

    /** Compute return between two closes (returns decimal, e.g. 0.023). */
    ret(a, b) {
      if (!a || !b || !isFinite(a) || !isFinite(b) || a === 0) return 0;
      return b / a - 1;
    },

    /** Daily return series from close prices (length = closes.length - 1). */
    dailyReturns(closes) {
      const out = [];
      for (let i = 1; i < closes.length; i++) {
        out.push(closes[i] / closes[i - 1] - 1);
      }
      return out;
    },

    /** Max drawdown of a close price series (returns negative decimal). */
    maxDrawdown(closes) {
      if (!closes || closes.length < 2) return 0;
      let peak = closes[0];
      let mdd = 0;
      for (const c of closes) {
        if (c > peak) peak = c;
        const dd = c / peak - 1;
        if (dd < mdd) mdd = dd;
      }
      return mdd;
    },

    /** Simple Pearson correlation. */
    corr(a, b) {
      const n = Math.min(a.length, b.length);
      if (n < 2) return 0;
      let sa = 0, sb = 0;
      for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
      const ma = sa / n, mb = sb / n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) {
        const xa = a[i] - ma, xb = b[i] - mb;
        num += xa * xb;
        da += xa * xa;
        db += xb * xb;
      }
      const denom = Math.sqrt(da * db);
      return denom === 0 ? 0 : num / denom;
    },

    /** Beta: cov(rA, rB) / var(rB). */
    beta(rA, rB) {
      const n = Math.min(rA.length, rB.length);
      if (n < 2) return 0;
      let sa = 0, sb = 0;
      for (let i = 0; i < n; i++) { sa += rA[i]; sb += rB[i]; }
      const ma = sa / n, mb = sb / n;
      let cov = 0, vb = 0;
      for (let i = 0; i < n; i++) {
        const xa = rA[i] - ma, xb = rB[i] - mb;
        cov += xa * xb;
        vb += xb * xb;
      }
      return vb === 0 ? 0 : cov / vb;
    },

    /** Element helper. */
    el(tag, props = {}, ...children) {
      const e = document.createElement(tag);
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') e.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k.startsWith('on') && typeof v === 'function') {
          e.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'html') {
          e.innerHTML = v;
        } else if (v !== undefined && v !== null) {
          e.setAttribute(k, v);
        }
      }
      for (const c of children.flat()) {
        if (c == null) continue;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
      return e;
    },

    /** Clear all children of an element. */
    clear(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    },

    /** Localstorage with JSON. */
    lsGet(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch (_) {
        return fallback;
      }
    },
    lsSet(key, val) {
      try {
        localStorage.setItem(key, JSON.stringify(val));
        return true;
      } catch (_) {
        return false;
      }
    },
    lsRemove(key) {
      try { localStorage.removeItem(key); } catch (_) {}
    },

    /** Debounce. */
    debounce(fn, ms) {
      let t;
      return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
      };
    },
  };

  global.ETF = global.ETF || {};
  global.ETF.utils = Utils;
})(window);