/* ============================================================
   technical.js — Technical analysis page
   Depends on:
     window.ETF.{summary, byCode, all, ready, categories, lastDate}
     window.ETF.utils.{pct, num, price, signClass}
     Chart (global, from Chart.js CDN)
   Rows from byCode() are oldest-first (CSV order).
   ============================================================ */
(function () {
  'use strict';

  // ---- Config ----------------------------------------------------------
  var COLOR_CLOSE = '#f59e0b';
  var COLOR_MA20  = '#3b82f6';
  var COLOR_MA60  = '#8b5cf6';
  var COLOR_BOLL  = '#94a3b8';
  var COLOR_UP    = '#10b981';
  var COLOR_DOWN  = '#ef4444';
  var COLOR_VOL_UP   = 'rgba(16, 185, 129, 0.55)';
  var COLOR_VOL_DOWN = 'rgba(239, 68, 68, 0.55)';

  var CHART_DATE_LIMIT = 252;
  var TABLE_ROW_LIMIT  = 30;

  // ---- State -----------------------------------------------------------
  var state = {
    selectedCode: null,
    current: null,         // current EtfSeries
    marketData: [],         // [{meta, last, devMa20, devMa60, lookback12m}]
    charts: { price: null, volume: null }
  };

  // ---- DOM refs --------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  var dom = {};

  // ---- Boot ------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    dom.loading        = $('loading');
    dom.content        = $('content');
    dom.select         = $('etf-select');
    dom.metricRow      = $('metric-row');
    dom.chartTag       = $('chart-tag');
    dom.indicatorBody  = $('indicator-body');
    dom.marketOverview = $('market-overview');
    dom.extremeList    = $('extreme-list');
    dom.metaCount      = $('meta-count');

    dom.select.addEventListener('change', function () {
      state.selectedCode = dom.select.value;
      loadSelected();
    });

    boot();
  });

  function boot() {
    window.ETF.ready.then(function () {
      populateSelect();
      dom.metaCount.textContent = window.ETF.summary.length + ' ETFs · CSV';
      if (window.ETF.summary.length) {
        state.selectedCode = window.ETF.summary[0].code;
        dom.select.value = state.selectedCode;
      }
      return window.ETF.all();
    }).then(function (series) {
      buildMarketData(series);
      dom.loading.style.display = 'none';
      dom.content.style.display = 'block';
      renderMarketOverview();
      renderExtremeList();
      return loadSelected();
    }).catch(function (err) {
      dom.loading.textContent = '加载失败: ' + (err && err.message || err);
      console.error(err);
    });
  }

  function populateSelect() {
    var byCat = {};
    window.ETF.summary.forEach(function (m) {
      (byCat[m.category] = byCat[m.category] || []).push(m);
    });
    Object.keys(byCat).forEach(function (cat) {
      var og = document.createElement('optgroup');
      og.label = cat;
      byCat[cat].forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.code;
        opt.textContent = m.code + ' · ' + m.name;
        og.appendChild(opt);
      });
      dom.select.appendChild(og);
    });
  }

  function loadSelected() {
    if (!state.selectedCode) return Promise.resolve();
    return window.ETF.byCode(state.selectedCode).then(function (series) {
      state.current = series;
      renderSelected();
    });
  }

  // ---- Technical indicators (pure helpers) -----------------------------
  function smaSeries(closes, period) {
    var out = new Array(closes.length).fill(null);
    if (closes.length < period) return out;
    var sum = 0;
    for (var i = 0; i < period; i++) sum += closes[i];
    out[period - 1] = sum / period;
    for (var i = period; i < closes.length; i++) {
      sum += closes[i] - closes[i - period];
      out[i] = sum / period;
    }
    return out;
  }
  function stdevAt(closes, i, period, mean) {
    if (i + 1 < period) return null;
    var sq = 0;
    for (var k = 0; k < period; k++) {
      var d = closes[i - k] - mean;
      sq += d * d;
    }
    return Math.sqrt(sq / period);
  }
  function bollingerSeries(closes, period, k) {
    period = period || 20;
    k = k || 2;
    var mid = smaSeries(closes, period);
    var upper = new Array(closes.length).fill(null);
    var lower = new Array(closes.length).fill(null);
    for (var i = period - 1; i < closes.length; i++) {
      if (mid[i] != null) {
        var sd = stdevAt(closes, i, period, mid[i]);
        if (sd != null) {
          upper[i] = mid[i] + k * sd;
          lower[i] = mid[i] - k * sd;
        }
      }
    }
    return { mid: mid, upper: upper, lower: lower };
  }

  // ---- Render selected ETF --------------------------------------------
  function renderSelected() {
    var s = state.current;
    if (!s || !s.rows || !s.rows.length) return;
    dom.chartTag.textContent = s.code + ' · ' + s.name + ' · ' + s.category;

    // rows are oldest-first already
    var closes = s.rows.map(function (r) { return r.close; });
    var opens  = s.rows.map(function (r) { return r.open; });
    var vols   = s.rows.map(function (r) { return r.volume; });
    var dates  = s.rows.map(function (r) { return r.date; });

    var ma20 = smaSeries(closes, 20);
    var ma60 = smaSeries(closes, 60);
    var boll = bollingerSeries(closes, 20, 2);

    var n = closes.length;
    var last = closes[n - 1];
    var ma20Last = ma20[n - 1];
    var ma60Last = ma60[n - 1];

    var lookback = Math.min(252, n);
    var sliceHi = closes.slice(n - lookback);
    var hi12 = Math.max.apply(null, sliceHi);
    var lo12 = Math.min.apply(null, sliceHi);

    var devMa20 = (ma20Last && last) ? (last / ma20Last - 1) : null;
    var devMa60 = (ma60Last && last) ? (last / ma60Last - 1) : null;

    renderMetricRow(last, devMa20, devMa60, hi12, lo12, s.name);
    renderPriceChart(dates, closes, ma20, ma60, boll);
    renderVolumeChart(dates, vols, opens, closes);
    renderIndicatorTable(s, closes, ma20, ma60, boll);
  }

  function renderMetricRow(last, devMa20, devMa60, hi12, lo12, name) {
    dom.metricRow.innerHTML = '';
    var items = [
      { label: '当前收盘', value: window.ETF.utils.price(last), sub: name },
      { label: 'MA20 偏离', value: pct(devMa20), sub: devMa20 != null ? ((devMa20 > 0 ? '高于均线' : '低于均线')) : '—', cls: devMa20 != null ? (devMa20 >= 0 ? 'pos' : 'neg') : '' },
      { label: 'MA60 偏离', value: pct(devMa60), sub: devMa60 != null ? ((devMa60 > 0 ? '高于均线' : '低于均线')) : '—', cls: devMa60 != null ? (devMa60 >= 0 ? 'pos' : 'neg') : '' },
      { label: '12 月区间', value: window.ETF.utils.price(hi12) + ' / ' + window.ETF.utils.price(lo12), sub: '高 / 低 (近 252 日)' }
    ];
    items.forEach(function (it) {
      var card = document.createElement('div');
      card.className = 'metric' + (it.cls ? ' ' + it.cls : '');
      card.innerHTML = '<div class="label">' + it.label + '</div>' +
                       '<div class="value">' + it.value + '</div>' +
                       '<div class="sub">' + it.sub + '</div>';
      dom.metricRow.appendChild(card);
    });
  }

  // ---- Price chart -----------------------------------------------------
  function renderPriceChart(dates, closes, ma20, ma60, boll) {
    var ctx = document.getElementById('price-chart');
    if (!ctx) return;
    if (state.charts.price) { state.charts.price.destroy(); state.charts.price = null; }

    var start = Math.max(0, dates.length - CHART_DATE_LIMIT);
    var d2 = dates.slice(start);
    var c2 = closes.slice(start);
    var m2 = ma20.slice(start);
    var m6 = ma60.slice(start);
    var bu = boll.upper.slice(start);
    var bl = boll.lower.slice(start);

    state.charts.price = new Chart(ctx, {
      type: 'line',
      data: {
        labels: d2,
        datasets: [
          { label: '布林上轨', data: bu, borderColor: COLOR_BOLL, borderDash: [4, 4], borderWidth: 1, pointRadius: 0, tension: 0, fill: false, spanGaps: true },
          { label: '布林下轨', data: bl, borderColor: COLOR_BOLL, borderDash: [4, 4], borderWidth: 1, pointRadius: 0, tension: 0, fill: false, spanGaps: true },
          { label: 'MA20',     data: m2, borderColor: COLOR_MA20,  borderWidth: 1.2, pointRadius: 0, tension: 0, fill: false, spanGaps: true },
          { label: 'MA60',     data: m6, borderColor: COLOR_MA60,  borderWidth: 1.2, pointRadius: 0, tension: 0, fill: false, spanGaps: true },
          { label: '收盘',     data: c2, borderColor: COLOR_CLOSE, borderWidth: 1.6, pointRadius: 0, tension: 0, fill: false, spanGaps: true }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (c) {
                var v = c.parsed.y;
                if (v == null) return null;
                return c.dataset.label + ': ' + window.ETF.utils.price(v);
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#6e7681', font: { size: 10 }, maxRotation: 0, autoSkipPadding: 24 },
            grid: { display: false }
          },
          y: {
            position: 'right',
            ticks: { color: '#6e7681', font: { size: 10 }, callback: function (v) { return window.ETF.utils.price(v); } },
            grid: { color: 'rgba(255,255,255,0.04)' }
          }
        }
      }
    });
  }

  // ---- Volume chart ----------------------------------------------------
  function renderVolumeChart(dates, vols, opens, closes) {
    var ctx = document.getElementById('volume-chart');
    if (!ctx) return;
    if (state.charts.volume) { state.charts.volume.destroy(); state.charts.volume = null; }

    var start = Math.max(0, dates.length - CHART_DATE_LIMIT);
    var d2 = dates.slice(start);
    var v2 = vols.slice(start);
    var o2 = opens.slice(start);
    var c2 = closes.slice(start);
    var colors = v2.map(function (_, i) {
      return c2[i] >= o2[i] ? COLOR_VOL_UP : COLOR_VOL_DOWN;
    });

    state.charts.volume = new Chart(ctx, {
      type: 'bar',
      data: { labels: d2, datasets: [{ label: '成交量', data: v2, backgroundColor: colors, borderWidth: 0 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (c) { return '成交量: ' + window.ETF.utils.num(c.parsed.y, 0); }
            }
          }
        },
        scales: {
          x: { display: false },
          y: {
            position: 'right',
            ticks: { color: '#6e7681', font: { size: 9 }, maxTicksLimit: 3, callback: function (v) { return window.ETF.utils.num(v, 0); } },
            grid: { color: 'rgba(255,255,255,0.04)' }
          }
        }
      }
    });
  }

  // ---- Indicator table (last 30 days, newest-first) --------------------
  function renderIndicatorTable(s, closes, ma20, ma60, boll) {
    dom.indicatorBody.innerHTML = '';
    var n = closes.length;
    var start = Math.max(0, n - TABLE_ROW_LIMIT);
    for (var i = n - 1; i >= start; i--) {
      var close = closes[i];
      var upper = boll.upper[i];
      var lower = boll.lower[i];
      var m20 = ma20[i];
      var m60 = ma60[i];
      var pos = (upper != null && lower != null && upper !== lower)
        ? (close - lower) / (upper - lower) * 100 : null;
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + s.rows[i].date + '</td>' +
        '<td class="num">' + window.ETF.utils.price(close) + '</td>' +
        '<td class="num">' + (m20 == null ? '—' : window.ETF.utils.price(m20)) + '</td>' +
        '<td class="num">' + (m60 == null ? '—' : window.ETF.utils.price(m60)) + '</td>' +
        '<td class="num">' + (upper == null ? '—' : window.ETF.utils.price(upper)) + '</td>' +
        '<td class="num">' + (lower == null ? '—' : window.ETF.utils.price(lower)) + '</td>' +
        '<td class="num">' + (pos == null ? '—' : pos.toFixed(1) + '%') + '</td>';
      dom.indicatorBody.appendChild(tr);
    }
  }

  // ---- Market overview (sidebar) ---------------------------------------
  function buildMarketData(series) {
    var cats = {};
    state.marketData = series.map(function (s) {
      if (!s.rows || s.rows.length < 60) return null;
      var closes = s.rows.map(function (r) { return r.close; });
      var last = closes[closes.length - 1];
      var ma20 = smaSeries(closes, 20);
      var ma20Last = ma20[closes.length - 1];
      var devMa20 = (ma20Last && last) ? (last / ma20Last - 1) : null;
      var ma60 = smaSeries(closes, 60);
      var ma60Last = ma60[closes.length - 1];
      var devMa60 = (ma60Last && last) ? (last / ma60Last - 1) : null;
      var lookback = Math.min(252, closes.length);
      var sliceHi = closes.slice(closes.length - lookback);
      var hi12 = Math.max.apply(null, sliceHi);
      var lo12 = Math.min.apply(null, sliceHi);
      return {
        code: s.code, name: s.name, category: s.category,
        last: last, devMa20: devMa20, devMa60: devMa60,
        hi12: hi12, lo12: lo12
      };
    }).filter(Boolean);

    var grouped = {};
    state.marketData.forEach(function (d) {
      (grouped[d.category] = grouped[d.category] || []).push(d);
    });
    Object.keys(grouped).forEach(function (c) {
      var devs = grouped[c].map(function (d) { return d.devMa20; }).filter(function (x) { return x != null; });
      var avg = devs.length ? devs.reduce(function (a, b) { return a + b; }, 0) / devs.length : null;
      cats[c] = { avgDevMa20: avg, count: grouped[c].length };
    });
    state.marketCats = cats;
  }

  function renderMarketOverview() {
    dom.marketOverview.innerHTML = '';
    var cats = state.marketCats || {};
    var keys = Object.keys(cats);
    if (!keys.length) {
      dom.marketOverview.innerHTML = '<li class="muted">无数据</li>';
      return;
    }
    keys.sort(function (a, b) { return (cats[b].avgDevMa20 || 0) - (cats[a].avgDevMa20 || 0); });
    keys.forEach(function (c) {
      var info = cats[c];
      var dev = info.avgDevMa20;
      var cls = dev == null ? '' : (dev > 0 ? 'pos' : 'neg');
      var label = dev == null ? '—'
        : (dev > 0.05 ? '超买' : (dev < -0.05 ? '超卖' : (dev > 0 ? '偏强' : '偏弱')));
      var li = document.createElement('li');
      li.innerHTML =
        '<span><strong>' + c + '</strong> <span class="dim small">' + info.count + ' 只</span></span>' +
        '<span class="' + cls + '">' + pct(dev) + ' · ' + label + '</span>';
      dom.marketOverview.appendChild(li);
    });
  }

  // ---- Extreme signals (overbought / oversold) -------------------------
  function renderExtremeList() {
    dom.extremeList.innerHTML = '';
    var pos = state.marketData.filter(function (d) { return d.devMa20 != null && d.devMa20 >  0.05; })
                                .sort(function (a, b) { return b.devMa20 - a.devMa20; }).slice(0, 5);
    var neg = state.marketData.filter(function (d) { return d.devMa20 != null && d.devMa20 < -0.05; })
                                .sort(function (a, b) { return a.devMa20 - b.devMa20; }).slice(0, 5);

    function row(d, kind) {
      var li = document.createElement('li');
      li.innerHTML =
        '<span><strong>' + d.name + '</strong> <span class="dim small">' + d.code + '</span></span>' +
        '<span class="' + (kind === 'pos' ? 'pos' : 'neg') + '">' + pct(d.devMa20) + '</span>';
      return li;
    }
    if (pos.length) {
      var head = document.createElement('li');
      head.innerHTML = '<span class="muted small">超买 (MA20 上方 &gt; 5%)</span><span></span>';
      dom.extremeList.appendChild(head);
      pos.forEach(function (d) { dom.extremeList.appendChild(row(d, 'pos')); });
    }
    if (neg.length) {
      var head = document.createElement('li');
      head.innerHTML = '<span class="muted small">超卖 (MA20 下方 &gt; 5%)</span><span></span>';
      dom.extremeList.appendChild(head);
      neg.forEach(function (d) { dom.extremeList.appendChild(row(d, 'neg')); });
    }
    if (!pos.length && !neg.length) {
      dom.extremeList.innerHTML = '<li class="muted">所有 ETF MA20 偏离均在 ±5% 内</li>';
    }
  }

  // ---- Helpers ---------------------------------------------------------
  function pct(v) {
    if (v == null || !isFinite(v)) return '—';
    return window.ETF.utils.pct(v, 2);
  }
})();