/* ============================================================
   dashboard.js — 综合仪表盘 page
   Depends on:
     window.ETF.{summary, all, ready, lastDate}
     window.ETF.utils.{pct, num, price, signClass}
   Rows are oldest-first per the loader's parseCsv order.
   ============================================================ */
(function () {
  'use strict';

  // Trading-day window sizes (match momentum.js convention)
  var W = {
    day:   1,
    week:  5,
    month: 21,
    m3:    63,
    m6:    126,
    m12:   252
  };
  var MA_N = 20;

  var state = {
    series: [],   // EtfSeries[] from ETF.all()
    rows:   [],   // enriched objects for the table
    activeCategory: 'all',
    sortCol: 'day',
    sortDir: 'desc'
  };

  var dom = {};

  document.addEventListener('DOMContentLoaded', function () {
    dom.metricRow    = document.getElementById('metric-row');
    dom.filterSelect = document.getElementById('category-filter');
    dom.tableHead    = document.getElementById('table-head');
    dom.tableBody    = document.getElementById('table-body');
    dom.top5List     = document.getElementById('top5-list');
    dom.bot5List     = document.getElementById('bot5-list');
    dom.meta         = document.getElementById('meta-count');
    dom.loading      = document.getElementById('loading');
    dom.content      = document.getElementById('content');
    dom.rowCountInfo = document.getElementById('row-count-info');

    bindEvents();
    load();
  });

  function bindEvents() {
    dom.filterSelect.addEventListener('change', function () {
      state.activeCategory = dom.filterSelect.value;
      renderTable();
    });

    dom.tableHead.addEventListener('click', function (e) {
      var th = e.target.closest('th[data-sort]');
      if (!th) return;
      var col = th.getAttribute('data-sort');
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortCol = col;
        state.sortDir = (col === 'code' || col === 'name' || col === 'category') ? 'asc' : 'desc';
      }
      renderTable();
    });
  }

  function load() {
    window.ETF.ready.then(function () {
      dom.meta.textContent = window.ETF.summary.length + ' ETFs · ' + window.ETF.lastDate;
      return window.ETF.all();
    }).then(function (series) {
      // keep only series with enough history
      state.series = series.filter(function (s) {
        return s.rows && s.rows.length >= MA_N + 5;
      });
      state.rows = state.series.map(enrich);
      dom.loading.style.display = 'none';
      dom.content.style.display = 'block';
      renderMetrics();
      renderTable();
      renderTopBottom();
    }).catch(function (err) {
      dom.loading.textContent = '加载失败: ' + (err && err.message || err);
      console.error(err);
    });
  }

  // ---- Math helpers ----------------------------------------------------
  function closes(s) {
    var out = [];
    for (var i = 0; i < s.rows.length; i++) out.push(s.rows[i].close);
    return out;
  }

  function windowReturn(c, n) {
    if (c.length < n + 1) return null;
    var last = c[c.length - 1];
    var past = c[c.length - 1 - n];
    if (!last || !past) return null;
    return last / past - 1;
  }

  function maN(c, n) {
    if (c.length < n) return null;
    var sum = 0;
    for (var i = c.length - n; i < c.length; i++) sum += c[i];
    return sum / n;
  }

  function enrich(s) {
    var c = closes(s);
    var last = c[c.length - 1];
    var ma20 = maN(c, MA_N);
    return {
      code: s.code,
      name: s.name,
      category: s.category,
      last: last,
      day: windowReturn(c, W.day),
      week: windowReturn(c, W.week),
      month: windowReturn(c, W.month),
      m3: windowReturn(c, W.m3),
      m6: windowReturn(c, W.m6),
      m12: windowReturn(c, W.m12),
      ma20: ma20,
      ma20dev: ma20 ? (last / ma20 - 1) : null
    };
  }

  function avgByCategory(rows, key) {
    var map = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!map[r.category]) map[r.category] = { sum: 0, count: 0 };
      if (r[key] != null && isFinite(r[key])) {
        map[r.category].sum += r[key];
        map[r.category].count += 1;
      }
    }
    var out = [];
    Object.keys(map).forEach(function (cat) {
      out.push({
        category: cat,
        avg: map[cat].count ? map[cat].sum / map[cat].count : null
      });
    });
    return out;
  }

  // ---- Renderers -------------------------------------------------------
  function renderMetrics() {
    dom.metricRow.innerHTML = '';
    var rows = state.rows;
    var total = rows.length;
    var validDay = rows.filter(function (r) { return r.day != null; });
    var avgDay = validDay.length
      ? validDay.reduce(function (a, r) { return a + r.day; }, 0) / validDay.length
      : null;

    var weekByCat = avgByCategory(rows, 'week').sort(function (a, b) {
      return (b.avg || -Infinity) - (a.avg || -Infinity);
    });
    var monthByCat = avgByCategory(rows, 'month').sort(function (a, b) {
      return (b.avg || -Infinity) - (a.avg || -Infinity);
    });

    var items = [
      {
        label: '总 ETF 数',
        value: total,
        sub: '样本量',
        cls: ''
      },
      {
        label: '平均今日涨幅',
        value: pct(avgDay),
        sub: total + ' 只均值',
        cls: signCls(avgDay)
      },
      {
        label: '近 1 周最强行业',
        value: weekByCat.length ? weekByCat[0].category : '—',
        sub: weekByCat.length && weekByCat[0].avg != null
          ? '均值 ' + pct(weekByCat[0].avg)
          : '—',
        cls: weekByCat.length ? signCls(weekByCat[0].avg) : ''
      },
      {
        label: '近 1 月最强行业',
        value: monthByCat.length ? monthByCat[0].category : '—',
        sub: monthByCat.length && monthByCat[0].avg != null
          ? '均值 ' + pct(monthByCat[0].avg)
          : '—',
        cls: monthByCat.length ? signCls(monthByCat[0].avg) : ''
      }
    ];

    items.forEach(function (it) {
      var m = document.createElement('div');
      m.className = 'metric' + (it.cls ? ' ' + it.cls : '');
      m.innerHTML =
        '<div class="label">' + it.label + '</div>' +
        '<div class="value">' + it.value + '</div>' +
        '<div class="sub">' + it.sub + '</div>';
      dom.metricRow.appendChild(m);
    });
  }

  function renderTable() {
    var rows = state.rows.filter(function (r) {
      return state.activeCategory === 'all' || r.category === state.activeCategory;
    });
    rows.sort(makeSorter(state.sortCol, state.sortDir));

    // Update sort indicators
    Array.prototype.forEach.call(dom.tableHead.querySelectorAll('th[data-sort]'), function (th) {
      var existing = th.querySelector('.sort-ind');
      if (existing) existing.remove();
      if (th.getAttribute('data-sort') === state.sortCol) {
        var span = document.createElement('span');
        span.className = 'sort-ind muted';
        span.textContent = state.sortDir === 'asc' ? ' ▲' : ' ▼';
        span.style.marginLeft = '4px';
        th.appendChild(span);
      }
    });

    dom.rowCountInfo.textContent = rows.length + ' / ' + state.rows.length + ' 行';

    dom.tableBody.innerHTML = '';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="kline-col">' + sinaKlineCell(r.code) + '</td>' +
        '<td class="mono">' + r.code + '</td>' +
        '<td>' + escapeHtml(r.name) + '</td>' +
        '<td><span class="pill cat-' + r.category + '">' + r.category + '</span></td>' +
        '<td class="num">' + window.ETF.utils.price(r.last) + '</td>' +
        '<td class="num ' + signCls(r.day) + '">' + pct(r.day) + '</td>' +
        '<td class="num ' + signCls(r.week) + '">' + pct(r.week) + '</td>' +
        '<td class="num ' + signCls(r.month) + '">' + pct(r.month) + '</td>' +
        '<td class="num ' + signCls(r.m3) + '">' + pct(r.m3) + '</td>' +
        '<td class="num ' + signCls(r.m6) + '">' + pct(r.m6) + '</td>' +
        '<td class="num ' + signCls(r.m12) + '">' + pct(r.m12) + '</td>' +
        '<td class="num ' + signCls(r.ma20dev) + '">' + pct(r.ma20dev) + '</td>';
      dom.tableBody.appendChild(tr);
    });
  }

  // ---- Sina K线缩略图 --------------------------------------------------
  // Sina K线服务: image.sinajs.cn/newchart/daily/n/{market}{code}.gif
  // 仅覆盖沪深 ETF(代码首位 5 → sh, 1 → sz); 海外 ETF(VNQ/IWY 等) 返回占位符
  function sinaMarketPrefix(code) {
    if (!code) return null;
    var c = String(code).charAt(0);
    return c === '5' ? 'sh' : (c === '1' ? 'sz' : null);
  }
  function sinaKlineCell(code) {
    var prefix = sinaMarketPrefix(code);
    if (!prefix) {
      return '<span class="kline-na" title="海外 ETF 新浪无 K线">无新浪</span>';
    }
    var url = 'https://image.sinajs.cn/newchart/daily/n/' + prefix + code + '.gif';
    return '<img src="' + url + '" alt="' + escapeAttr(code) + ' K线" loading="lazy" ' +
           'referrerpolicy="no-referrer" ' +
           'onerror="this.outerHTML=\'<span class=kline-na>无数据</span>\'">';
  }
  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }

  function makeSorter(col, dir) {
    var sign = dir === 'asc' ? 1 : -1;
    return function (a, b) {
      var av = a[col], bv = b[col];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return String(av).localeCompare(String(bv), 'zh-CN') * sign;
      return (av - bv) * sign;
    };
  }

  function renderTopBottom() {
    var rows = state.rows.slice().sort(function (a, b) {
      return (b.day || -Infinity) - (a.day || -Infinity);
    });
    var top5 = rows.slice(0, 5);
    var bot5 = rows.slice(-5).reverse();

    dom.top5List.innerHTML = '';
    top5.forEach(function (r) {
      dom.top5List.appendChild(buildLeaderRow(r, 'pos'));
    });

    dom.bot5List.innerHTML = '';
    bot5.forEach(function (r) {
      dom.bot5List.appendChild(buildLeaderRow(r, 'neg'));
    });
  }

  function buildLeaderRow(r, cls) {
    var li = document.createElement('li');
    li.innerHTML =
      '<span><strong>' + escapeHtml(r.name) + '</strong> ' +
      '<span class="dim small">' + r.code + ' · ' + r.category + '</span></span>' +
      '<span class="' + cls + '">' + pct(r.day) + '</span>';
    return li;
  }

  // ---- Formatters ------------------------------------------------------
  function pct(v) {
    if (v == null || !isFinite(v)) return '—';
    return window.ETF.utils.pct(v, 2);
  }
  function signCls(v) {
    if (v == null) return '';
    return window.ETF.utils.signClass(v);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[c];
    });
  }
})();