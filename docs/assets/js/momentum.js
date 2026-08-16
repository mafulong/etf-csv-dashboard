/* ============================================================
   momentum.js — Momentum rotation page
   Depends on:
     window.ETF.{summary, all, ready, lastDate}
     window.ETF.utils.{pct, signClass, ret}
     Chart (global, from Chart.js CDN)
   Rows are oldest-first per the loader's parseCsv order.
   ============================================================ */
(function () {
  'use strict';

  // ---- Config ----------------------------------------------------------
  var WINDOWS = [
    { key: '1M',  bars: 21,  label: '近 1 月'  },
    { key: '3M',  bars: 63,  label: '近 3 月'  },
    { key: '6M',  bars: 126, label: '近 6 月'  },
    { key: '12M', bars: 252, label: '近 12 月' }
  ];
  var CATEGORIES = ['国内宽基', '全球', '行业', '美股'];

  // ---- State -----------------------------------------------------------
  var state = {
    activeWindow: '1M',
    activeCategory: 'all',
    series: [],          // EtfSeries[]
    chart: null
  };

  // ---- DOM refs --------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  var dom = {};

  // ---- Boot ------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    dom.windowTabs    = $('window-tabs');
    dom.catFilter     = $('cat-filter');
    dom.loading       = $('loading');
    dom.content       = $('content');
    dom.metricRow     = $('metric-row');
    dom.rankingBody   = $('ranking-body');
    dom.rankingMeta   = $('ranking-meta');
    dom.windowTag     = $('window-tag');
    dom.top5Tag       = $('top5-tag');
    dom.bot5Tag       = $('bot5-tag');
    dom.top5List      = $('top5-list');
    dom.bot5List      = $('bot5-list');
    dom.signalList    = $('signal-list');
    dom.signalSummary = $('signal-summary');
    dom.metaCount     = $('meta-count');

    bindEvents();
    loadAll();
  });

  function bindEvents() {
    dom.windowTabs.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-window]');
      if (!btn) return;
      Array.prototype.forEach.call(dom.windowTabs.children, function (b) {
        b.classList.toggle('active', b === btn);
      });
      state.activeWindow = btn.getAttribute('data-window');
      render();
    });
    dom.catFilter.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-cat]');
      if (!btn) return;
      Array.prototype.forEach.call(dom.catFilter.children, function (b) {
        b.classList.toggle('active', b === btn);
      });
      state.activeCategory = btn.getAttribute('data-cat');
      render();
    });
  }

  // ---- Data loading ----------------------------------------------------
  function loadAll() {
    window.ETF.ready.then(function () {
      dom.metaCount.textContent = window.ETF.summary.length + ' ETFs · CSV';
      return window.ETF.all();
    }).then(function (series) {
      // Keep only series with enough bars
      state.series = series.filter(function (s) {
        return s.rows && s.rows.length >= 30;
      });
      dom.loading.style.display = 'none';
      dom.content.style.display = 'block';
      render();
    }).catch(function (err) {
      dom.loading.textContent = '加载失败: ' + (err && err.message || err);
      console.error(err);
    });
  }

  /** Return closes oldest-first (already that way from parseCsv). */
  function getCloses(s) {
    var out = [];
    for (var i = 0; i < s.rows.length; i++) out.push(s.rows[i].close);
    return out;
  }
  /** Return window return for closes (oldest-first). */
  function windowReturn(closes, bars) {
    var n = closes.length;
    if (n < bars + 1) return null;
    var last = closes[n - 1];
    var past = closes[n - 1 - bars];
    if (!last || !past) return null;
    return last / past - 1;
  }
  /** Compute return per window for a series (oldest-first closes). */
  function computeReturns(s) {
    var closes = getCloses(s);
    var out = {};
    WINDOWS.forEach(function (w) {
      out[w.key]      = windowReturn(closes, w.bars);
      out[w.key + '_prev'] = windowReturn(closes, w.bars * 2);
    });
    return out;
  }

  // ---- Render ----------------------------------------------------------
  function render() {
    var winKey = state.activeWindow;
    var win    = WINDOW_BY_KEY(winKey);
    dom.windowTag.textContent = win.label;
    dom.top5Tag.textContent   = win.key;
    dom.bot5Tag.textContent   = win.key;

    // Filter by category
    var dataset = state.series.filter(function (s) {
      return state.activeCategory === 'all' || s.category === state.activeCategory;
    });

    // Compute returns for each
    var enriched = dataset.map(function (s) {
      return { meta: s, returns: computeReturns(s) };
    });

    // Sort by current window return desc
    var ranked = enriched.slice().sort(function (a, b) {
      var ra = a.returns[winKey], rb = b.returns[winKey];
      if (ra == null && rb == null) return 0;
      if (ra == null) return 1;
      if (rb == null) return -1;
      return rb - ra;
    });

    renderMetricRow(ranked, winKey);
    renderRankingTable(ranked, winKey);
    renderTopBottom(ranked, winKey);
    renderSignalList();
    renderCategoryChart();
  }

  function WINDOW_BY_KEY(k) {
    for (var i = 0; i < WINDOWS.length; i++) if (WINDOWS[i].key === k) return WINDOWS[i];
    return WINDOWS[0];
  }

  function renderMetricRow(ranked, winKey) {
    dom.metricRow.innerHTML = '';
    var top = ranked[0];
    var totalUp = 0, totalDown = 0;
    ranked.forEach(function (d) {
      var r = d.returns[winKey];
      if (r == null) return;
      if (r >= 0) totalUp++; else totalDown++;
    });

    var items = [
      { label: '样本数',  value: ranked.length, sub: '有效 ETF' },
      { label: '上涨数',  value: totalUp, sub: '占比 ' + ((totalUp / Math.max(1, ranked.length)) * 100).toFixed(0) + '%', cls: 'pos' },
      { label: '下跌数',  value: totalDown, sub: '占比 ' + ((totalDown / Math.max(1, ranked.length)) * 100).toFixed(0) + '%', cls: 'neg' },
      { label: '当前榜首', value: top ? pctStr(top.returns[winKey]) : '—', sub: top ? (top.meta.code + ' · ' + top.meta.name) : '', cls: top && top.returns[winKey] >= 0 ? 'pos' : 'neg' }
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

  function renderRankingTable(ranked, winKey) {
    dom.rankingBody.innerHTML = '';
    dom.rankingMeta.textContent = '共 ' + ranked.length + ' 只 · ' + WINDOW_BY_KEY(winKey).label;
    ranked.forEach(function (d, idx) {
      var ret = d.returns[winKey];
      var prev = d.returns[winKey + '_prev'];
      var diff = (ret != null && prev != null) ? (ret - prev) : null;
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td><span class="rank">' + (idx + 1) + '</span></td>' +
        '<td><strong>' + d.meta.code + '</strong></td>' +
        '<td>' + d.meta.name + '</td>' +
        '<td><span class="pill cat-' + d.meta.category + '">' + d.meta.category + '</span></td>' +
        '<td class="num ' + signCls(ret) + '">' + pctStr(ret) + '</td>' +
        '<td class="num ' + signCls(diff) + '">' + (diff == null ? '—' : pctStr(diff)) + '</td>';
      dom.rankingBody.appendChild(tr);
    });
  }

  function renderTopBottom(ranked, winKey) {
    dom.top5List.innerHTML = '';
    dom.bot5List.innerHTML = '';
    var top5 = ranked.slice(0, 5);
    var bot5 = ranked.slice(-5).reverse();
    top5.forEach(function (d) { dom.top5List.appendChild(buildLeaderRow(d, winKey)); });
    bot5.forEach(function (d) { dom.bot5List.appendChild(buildLeaderRow(d, winKey)); });
  }

  function buildLeaderRow(d, winKey) {
    var li = document.createElement('li');
    li.innerHTML =
      '<span><strong>' + d.meta.name + '</strong> ' +
      '<span class="dim small">' + d.meta.code + ' · ' + d.meta.category + '</span></span>' +
      '<span class="' + signCls(d.returns[winKey]) + '">' + pctStr(d.returns[winKey]) + '</span>';
    return li;
  }

  /**
   * Signal: ETFs that are in the 3M Top 5 AND also in the 1M Top 10.
   */
  function renderSignalList() {
    var series = state.series;
    var withRet = series.map(function (s) { return { meta: s, returns: computeReturns(s) }; });

    var top5by3M = withRet.slice().sort(function (a, b) {
      return (b.returns['3M'] || -1e9) - (a.returns['3M'] || -1e9);
    }).slice(0, 5);

    var top10by1M = withRet.slice().sort(function (a, b) {
      return (b.returns['1M'] || -1e9) - (a.returns['1M'] || -1e9);
    }).slice(0, 10);
    var top10Codes = new Set(top10by1M.map(function (d) { return d.meta.code; }));

    dom.signalList.innerHTML = '';
    var confirmed = top5by3M.filter(function (d) { return top10Codes.has(d.meta.code); });

    if (confirmed.length === 0) {
      dom.signalList.innerHTML = '<li class="muted">当前 3 月 Top 5 均未进入 1 月 Top 10 — 无明确趋势</li>';
      dom.signalSummary.textContent = '识别在多窗口中保持强势的 ETF';
      return;
    }
    dom.signalSummary.innerHTML = '<span class="pos">' + confirmed.length + ' / 5</span> 趋势确认 · 3月 Top 5 同时位于 1 月 Top 10';
    confirmed.forEach(function (d) {
      var li = document.createElement('li');
      li.innerHTML =
        '<span><strong>' + d.meta.name + '</strong> ' +
        '<span class="dim small">' + d.meta.code + ' · ' + d.meta.category + '</span></span>' +
        '<span class="pos">3M ' + pctStr(d.returns['3M']) + ' · 1M ' + pctStr(d.returns['1M']) + '</span>';
      dom.signalList.appendChild(li);
    });
  }

  /** Average return per category, per window — for the bar chart. */
  function renderCategoryChart() {
    var ctx = document.getElementById('category-chart');
    if (!ctx) return;
    if (state.chart) { state.chart.destroy(); state.chart = null; }

    var labels = CATEGORIES;
    var datasets = WINDOWS.map(function (w, idx) {
      var colors = ['#60a5fa', '#34d399', '#fbbf24', '#a78bfa'];
      return {
        label: w.label,
        data: labels.map(function (c) {
          var subs = state.series.filter(function (s) {
            return s.category === c && s.rows && s.rows.length > w.bars + 1;
          });
          if (!subs.length) return null;
          var sum = 0, cnt = 0;
          subs.forEach(function (s) {
            var closes = getCloses(s);
            var r = windowReturn(closes, w.bars);
            if (r != null) { sum += r; cnt++; }
          });
          return cnt ? +(sum / cnt * 100).toFixed(2) : null;
        }),
        backgroundColor: colors[idx],
        borderColor: colors[idx],
        borderWidth: 0,
        borderRadius: 3
      };
    });

    state.chart = new Chart(ctx, {
      type: 'bar',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { color: '#9ca3af', font: { size: 11 } } },
          tooltip: { callbacks: { label: function (c) { var v = c.parsed.y; return c.dataset.label + ': ' + (v > 0 ? '+' : '') + v.toFixed(2) + '%'; } } }
        },
        scales: {
          x: { ticks: { color: '#9ca3af' }, grid: { display: false } },
          y: {
            ticks: { color: '#9ca3af', callback: function (v) { return (v > 0 ? '+' : '') + v.toFixed(1) + '%'; } },
            grid: { color: 'rgba(255,255,255,0.05)' }
          }
        }
      }
    });
  }

  // ---- Helpers ---------------------------------------------------------
  function pctStr(v) {
    if (v == null || isNaN(v)) return '—';
    return window.ETF.utils.pct(v, 2);
  }
  function signCls(v) {
    if (v == null) return '';
    return window.ETF.utils.signClass(v);
  }
})();