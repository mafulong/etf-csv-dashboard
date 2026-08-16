/* ETF 行业热力图 — 渲染 + 交互 (一级类别 / 二级钻取 / 时间快照) */
(function (global) {
  'use strict';

  // 9 档色阶 (-4% → 灰 → +4%)
  const COLORS = ['#7f1d1d','#b91c1c','#dc2626','#ef4444','#4b5563','#4ade80','#22c55e','#16a34a','#166534'];

  const state = {
    etfs: [], current: null, drilldown: null,
    snapshotOffset: 0, lastDate: '', tiles: [], hover: null,
  };

  // DOM 工具
  const $ = (id) => document.getElementById(id);
  const canvas = () => $('treemap');

  // 按类别聚合 ETF (size = 近 22 日成交额; avgPct = 当日类别平均)
  function aggregateByCategory(etfs, off) {
    const byCat = new Map();
    etfs.forEach((etf) => {
      const r = etf.rows, n = r.length, idx = Math.max(0, n - 1 - off);
      const last = r[idx]?.close, prev = idx > 0 ? r[idx - 1]?.close : null;
      const start = Math.max(0, idx - 21);
      let size = 0;
      for (let i = start; i <= idx; i++) size += (r[i]?.volume || 0) * (r[i]?.close || 0);
      const close = (k) => (k >= 0 && k < n ? r[k]?.close : null);
      const ret = (k) => (close(idx) && close(k) ? close(idx) / close(k) - 1 : null);
      const item = {
        code: etf.code, name: etf.name, category: etf.category, rows: r, idx, close: last,
        dayPct: last && prev ? last / prev - 1 : null,
        weekPct: ret(idx - 5), monthPct: ret(idx - 21),
        yearPct: n >= 240 ? ret(idx - 240) : null, size,
      };
      if (!byCat.has(etf.category)) byCat.set(etf.category, []);
      byCat.get(etf.category).push(item);
    });
    const out = [];
    byCat.forEach((items, name) => {
      const size = items.reduce((a, x) => a + x.size, 0);
      const vd = items.filter((x) => x.dayPct != null);
      const avgPct = vd.length ? vd.reduce((a, x) => a + x.dayPct, 0) / vd.length : 0;
      out.push({ name, size, avgPct, etfs: items });
    });
    return out.sort((a, b) => b.size - a.size);
  }

  function aggregateByEtf(category) {
    if (!state.current) return [];
    const c = state.current.find((x) => x.name === category);
    return c ? [...c.etfs].sort((a, b) => b.size - a.size) : [];
  }

  // Squarified treemap (Bruls et al. 2000) — 自顶向下切片, 短边长最小
  function squarify(items, x, y, w, h) {
    if (!items.length) return [];
    const sorted = items.map((it, i) => ({ it, i }))
      .sort((a, b) => b.it.size - a.it.size || a.i - b.i).map((o) => o.it);
    return layoutRow(sorted, x, y, w, h, []);
  }
  function layoutRow(items, x, y, w, h, acc) {
    if (!items.length) return acc;
    const total = items.reduce((s, it) => s + it.size, 0);
    if (total <= 0) return acc;
    const horizontal = h >= w;
    const scale = horizontal ? h / total : w / total;
    let bestK = 1, bestRatio = Infinity, accSum = 0, i = 0;
    for (; i < items.length; i++) {
      accSum += items[i].size;
      const s = horizontal ? w / accSum : h / accSum;
      let mn = Infinity, mx = -Infinity;
      for (let j = 0; j <= i; j++) { const v = items[j].size * scale; if (v < mn) mn = v; if (v > mx) mx = v; }
      const ratio = Math.max(s / mn, mx / s);
      if (ratio > bestRatio) break;
      bestRatio = ratio; bestK = i + 1;
    }
    const row = items.slice(0, bestK), rest = items.slice(bestK);
    const rowSum = row.reduce((s, it) => s + it.size, 0);
    let offset = 0;
    const tiles = [];
    for (const it of row) {
      const tile = horizontal
        ? { x: x + w * (offset / rowSum), y, w: w * (it.size / rowSum), h: h * (rowSum / total), item: it }
        : { x, y: y + h * (offset / rowSum), w: w * (rowSum / total), h: h * (it.size / rowSum), item: it };
      tiles.push(tile); offset += it.size;
    }
    if (!rest.length) return acc.concat(tiles);
    if (horizontal) {
      const used = h * (rowSum / total);
      return acc.concat(tiles, layoutRow(rest, x, y + used, w, h - used, []));
    }
    const used = w * (rowSum / total);
    return acc.concat(tiles, layoutRow(rest, x + used, y, w - used, h, []));
  }

  // 颜色: pct → [-4%,+4%] → COLORS 索引 [0..8]
  function colorByPct(pct) {
    if (pct == null || !isFinite(pct)) return COLORS[4];
    const idx = Math.round((Math.max(-0.04, Math.min(0.04, pct)) + 0.04) / 0.01);
    return COLORS[Math.max(0, Math.min(8, idx))];
  }
  function textColorOn(hex) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 >= 140 ? '#0e1116' : '#e6edf3';
  }
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
    }
    return text.slice(0, lo) + (lo > 0 ? '…' : '');
  }

  // Canvas 高 DPI 设置
  function setupCanvas() {
    const c = canvas(), w = $('heatmap-wrap');
    const cssW = w.clientWidth, cssH = w.clientHeight;
    const dpr = global.devicePixelRatio || 1;
    c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
    c.width = Math.floor(cssW * dpr); c.height = Math.floor(cssH * dpr);
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, cssW, cssH };
  }

  function drawTiles(ctx, tiles, layout) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    for (const tile of tiles) {
      const { x, y, w, h, item } = tile;
      if (w < 1 || h < 1) continue;
      const cfg = layout(tile);
      ctx.fillStyle = cfg.bg; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#0e1116'; ctx.lineWidth = 1.5; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      if (w < 60 || h < 36) continue;
      ctx.fillStyle = textColorOn(cfg.bg); ctx.textBaseline = 'top';
      const pad = 6, titleX = x + pad, titleSize = cfg.font;
      let titleY = y + pad;
      if (cfg.code) { ctx.font = '500 10px ui-monospace, monospace'; ctx.fillText(cfg.code, titleX, titleY); titleY += 13; }
      ctx.font = `600 ${titleSize}px -apple-system, "PingFang SC", sans-serif`;
      ctx.fillText(fitText(ctx, cfg.title, w - pad * 2), titleX, titleY);
      if (h > 60 && cfg.sub) { ctx.font = '500 11px ui-monospace, monospace'; ctx.fillText(cfg.sub, titleX, y + h - pad - 12); }
    }
  }

  function renderLevel1() {
    const { ctx, cssW, cssH } = setupCanvas();
    if (!state.current || !state.current.length) return;
    state.tiles = squarify(state.current.map((c) => ({ size: c.size, ref: c })), 0, 0, cssW, cssH);
    drawTiles(ctx, state.tiles, (tile) => {
      const c = tile.item.ref;
      return { bg: colorByPct(c.avgPct), title: c.name, sub: `${c.etfs.length} 只 · ${window.ETF.utils.pct(c.avgPct)}`, font: 14 };
    });
  }

  function renderLevel2(category) {
    const { ctx, cssW, cssH } = setupCanvas();
    const items = aggregateByEtf(category);
    if (!items.length) return;
    state.tiles = squarify(items.map((it) => ({ size: it.size, ref: it })), 0, 0, cssW, cssH);
    state.drilldown = category;
    drawTiles(ctx, state.tiles, (tile) => {
      const it = tile.item.ref;
      return { bg: colorByPct(it.dayPct), title: it.name, sub: window.ETF.utils.pct(it.dayPct), code: it.code, font: 12 };
    });
    $('btn-back').style.display = '';
  }

  function hitTest(mx, my) {
    for (const t of state.tiles) {
      if (mx >= t.x && mx < t.x + t.w && my >= t.y && my < t.y + t.h) return t;
    }
    return null;
  }

  function showTooltip(tile, mx, my) {
    const tip = $('tooltip');
    if (!tile) { tip.style.display = 'none'; return; }
    const ref = tile.item.ref;
    let html = '';
    if (!state.drilldown) {
      const c = ref;
      html += `<div class="t-row t-code"><span>${c.name}</span><span class="t-val">${c.etfs.length} 只</span></div>`;
      html += `<div class="t-row"><span class="t-label">类别平均当日</span><span class="t-val ${window.ETF.utils.signClass(c.avgPct)}">${window.ETF.utils.pct(c.avgPct)}</span></div>`;
      const sizeStr = window.ETF.utils.moneyCNY ? window.ETF.utils.moneyCNY(c.size) : c.size.toFixed(0);
      html += `<div class="t-row"><span class="t-label">类别总成交额</span><span class="t-val">${sizeStr}</span></div>`;
      html += `<div class="t-hint">点击进入 · 双击仅查看首只</div>`;
    } else {
      const it = ref;
      const w = (p) => p != null ? window.ETF.utils.pct(p) : 'N/A';
      const sc = (p) => p != null ? window.ETF.utils.signClass(p) : '';
      html += `<div class="t-row t-code"><span>${it.code}</span><span class="t-val">${it.name}</span></div>`;
      html += `<div class="t-row"><span class="t-label">类别</span><span class="t-val">${it.category}</span></div>`;
      html += `<div class="t-row"><span class="t-label">收盘</span><span class="t-val">${window.ETF.utils.price(it.close)}</span></div>`;
      html += `<div class="t-row"><span class="t-label">当日</span><span class="t-val ${sc(it.dayPct)}">${w(it.dayPct)}</span></div>`;
      html += `<div class="t-row"><span class="t-label">1 周</span><span class="t-val ${sc(it.weekPct)}">${w(it.weekPct)}</span></div>`;
      html += `<div class="t-row"><span class="t-label">1 月</span><span class="t-val ${sc(it.monthPct)}">${w(it.monthPct)}</span></div>`;
      html += `<div class="t-row"><span class="t-label">1 年</span><span class="t-val ${sc(it.yearPct)}">${w(it.yearPct)}</span></div>`;
      html += `<div class="t-hint">双击 → 技术分析</div>`;
    }
    tip.innerHTML = html; tip.style.display = 'block';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = mx + 14, top = my + 14;
    if (left + tw > global.innerWidth) left = mx - tw - 14;
    if (top + th > global.innerHeight) top = my - th - 14;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }

  function bindEvents() {
    const c = canvas();
    c.addEventListener('mousemove', (e) => {
      const r = c.getBoundingClientRect();
      const tile = hitTest(e.clientX - r.left, e.clientY - r.top);
      state.hover = tile; showTooltip(tile, e.clientX, e.clientY);
      c.style.cursor = tile ? 'pointer' : 'default';
    });
    c.addEventListener('mouseleave', () => { state.hover = null; $('tooltip').style.display = 'none'; });
    c.addEventListener('click', (e) => {
      const r = c.getBoundingClientRect();
      const tile = hitTest(e.clientX - r.left, e.clientY - r.top);
      if (tile && !state.drilldown) renderLevel2(tile.item.ref.name);
    });
    c.addEventListener('dblclick', (e) => {
      const r = c.getBoundingClientRect();
      const tile = hitTest(e.clientX - r.left, e.clientY - r.top);
      if (tile && state.drilldown) global.location.href = 'technical.html?code=' + encodeURIComponent(tile.item.ref.code);
    });
    $('snapshot-select').addEventListener('change', (e) => {
      state.snapshotOffset = parseInt(e.target.value, 10) || 0; reload();
    });
    $('btn-back').addEventListener('click', () => {
      state.drilldown = null; $('btn-back').style.display = 'none'; renderLevel1();
    });
    $('btn-screenshot').addEventListener('click', exportPng);
    $('btn-fullscreen').addEventListener('click', () => {
      const el = $('heatmap-wrap');
      if (!document.fullscreenElement) (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
      else (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    });
    global.addEventListener('resize', window.ETF.utils.debounce(() => {
      if (state.drilldown) renderLevel2(state.drilldown);
      else if (state.current) renderLevel1();
    }, 100));
  }

  function exportPng() {
    if (!global.html2canvas) { alert('html2canvas 未加载'); return; }
    global.html2canvas($('heatmap-wrap'), { backgroundColor: '#161b22', scale: 2 }).then((cnv) => {
      cnv.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `etf-heatmap-${state.lastDate || new Date().toISOString().slice(0, 10)}.png`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, 'image/png');
    }).catch((err) => console.error('screenshot failed', err));
  }

  function reload() {
    state.current = aggregateByCategory(state.etfs, state.snapshotOffset);
    state.drilldown = null; $('btn-back').style.display = 'none';
    const idx = state.etfs[0] ? Math.max(0, state.etfs[0].rows.length - 1 - state.snapshotOffset) : 0;
    state.lastDate = state.etfs[0]?.rows[idx]?.date || '';
    $('snapshot-date').textContent = `快照: ${state.lastDate || '—'}`;
    renderLevel1();
  }

  global.addEventListener('DOMContentLoaded', async () => {
    await window.ETF.ready;
    state.etfs = await window.ETF.all();
    $('loading').style.display = 'none';
    $('heatmap-wrap').style.display = '';
    $('legend').style.display = '';
    reload(); bindEvents();
    $('meta-count').textContent = `${state.etfs.length} ETFs · ${state.etfs[0]?.rows.length || 0} days`;
  });
})(window);