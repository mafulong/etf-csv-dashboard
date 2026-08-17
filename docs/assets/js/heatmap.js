/* ETF 行业热力图 — 渲染 + 交互 (一级类别 / 二级钻取 / 时间快照 / 悬浮 sparkline)
 * v2 — review fixes: 数据加载错误 UI, avgPct=null 语义, 零尺寸过滤,
 *      lastDate 取最大共同日期, 截图错误处理, tooltip 边界全检查, 全屏拒绝处理,
 *      html2canvas 缺失时禁用按钮, 钻取状态保留快照切换
 */
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

  // Sina K线 URL helper — 仅沪深 ETF (代码首位 5 → sh, 1 → sz) 有数据
  function sinaKlineUrl(code) {
    if (!code) return null;
    const c = String(code).charAt(0);
    const prefix = c === '5' ? 'sh' : (c === '1' ? 'sz' : null);
    if (!prefix) return null;
    return 'https://image.sinajs.cn/newchart/daily/n/' + prefix + code + '.gif';
  }
  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
  }

  // 取所有 ETF 共同能提供的最大日期 (即"快照日")
  function pickLastDate(etfs, off) {
    let max = '';
    for (const e of etfs) {
      const n = e.rows.length;
      if (n < 2) continue;
      const idx = Math.max(0, n - 1 - off);
      const d = e.rows[idx]?.date || '';
      if (d > max) max = d;
    }
    return max;
  }

  // 按类别聚合 ETF (size = 近 22 日成交额; avgPct = 当日类别平均)
  function aggregateByCategory(etfs, off) {
    const byCat = new Map();
    etfs.forEach((etf) => {
      const r = etf.rows, n = r.length;
      if (n < 2) return;
      const idx = Math.max(0, n - 1 - off);
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
      // 全部数据缺失时 avgPct = null (灰色 "无数据" 语义), 与 "持平 0%" 区分
      const avgPct = vd.length ? vd.reduce((a, x) => a + x.dayPct, 0) / vd.length : null;
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
  // 入口先过滤 size<=0, 避免 NaN / 退化 tile
  function squarify(items, x, y, w, h) {
    const valid = items.filter((it) => it.size > 0 && isFinite(it.size));
    if (!valid.length) return [];
    const sorted = valid.map((it, i) => ({ it, i }))
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
      const pctStr = c.avgPct != null ? window.ETF.utils.pct(c.avgPct) : '—';
      return { bg: colorByPct(c.avgPct), title: c.name, sub: `${c.etfs.length} 只 · ${pctStr}`, font: 14 };
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

  // 悬浮 sparkline: 最近 60 个交易日收盘价, 归一化到 [0,1], 渲染成 SVG path
  function sparklineSvg(rows, lastIdx, w = 180, h = 44) {
    if (!rows || !rows.length) return '';
    const n = Math.min(60, lastIdx + 1);
    const slice = [];
    for (let i = lastIdx - n + 1; i <= lastIdx; i++) {
      if (i >= 0 && isFinite(rows[i]?.close)) slice.push(rows[i].close);
    }
    if (slice.length < 2) return '';
    const lo = Math.min(...slice), hi = Math.max(...slice);
    const range = hi - lo || 1;
    const step = w / (slice.length - 1);
    let path = '';
    slice.forEach((v, i) => {
      const x = i * step;
      const y = h - ((v - lo) / range) * (h - 4) - 2;
      path += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
    });
    const last = slice[slice.length - 1];
    const first = slice[0];
    const trend = last >= first ? '#22c55e' : '#ef4444';
    return `<svg class="t-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
      <path d="${path}" fill="none" stroke="${trend}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${(slice.length - 1) * step}" cy="${h - ((last - lo) / range) * (h - 4) - 2}" r="2" fill="${trend}"/>
    </svg>`;
  }

  function showTooltip(tile, mx, my) {
    const tip = $('tooltip');
    if (!tile) { tip.style.display = 'none'; return; }
    const ref = tile.item.ref;
    let html = '';
    const pct = (p) => window.ETF.utils.pct(p);
    const w = (p) => p != null ? pct(p) : 'N/A';
    const sc = (p) => p != null ? window.ETF.utils.signClass(p) : '';
    if (!state.drilldown) {
      const c = ref;
      html += `<div class="t-row t-code"><span>${c.name}</span><span class="t-val">${c.etfs.length} 只</span></div>`;
      const avgStr = c.avgPct != null ? pct(c.avgPct) : '—';
      const avgCls = c.avgPct != null ? sc(c.avgPct) : '';
      html += `<div class="t-row"><span class="t-label">类别平均当日</span><span class="t-val ${avgCls}">${avgStr}</span></div>`;
      const sizeStr = window.ETF.utils.moneyCNY ? window.ETF.utils.moneyCNY(c.size) : c.size.toFixed(0);
      html += `<div class="t-row"><span class="t-label">类别总成交额</span><span class="t-val">${sizeStr}</span></div>`;
      // 类别级 sparkline: 该类别下所有 ETF 的当日涨跌幅柱状条
      const bars = c.etfs.slice(0, 30).map((it) => {
        const v = it.dayPct == null ? 0 : Math.max(-0.04, Math.min(0.04, it.dayPct));
        const norm = (v + 0.04) / 0.08;
        const h = Math.abs(norm - 0.5) * 20;
        const color = colorByPct(it.dayPct);
        const y = v >= 0 ? 10 - h : 10;
        return `<rect x="0" y="${y.toFixed(1)}" width="2" height="${h.toFixed(1)}" fill="${color}"/>`;
      }).join('');
      if (c.etfs.length) {
        html += `<svg class="t-spark" viewBox="0 0 ${Math.max(60, c.etfs.length * 3)} 20" width="100%" height="20"><g transform="translate(0,0)">${bars}</g></svg>`;
      }
      html += `<div class="t-hint">单击进入 · 双击直跳首只详情</div>`;
    } else {
      const it = ref;
      html += `<div class="t-row t-code"><span>${it.code}</span><span class="t-val">${it.name}</span></div>`;
      html += `<div class="t-row"><span class="t-label">类别</span><span class="t-val">${it.category}</span></div>`;
      html += `<div class="t-row"><span class="t-label">收盘</span><span class="t-val">${window.ETF.utils.price(it.close)}</span></div>`;
      html += `<div class="t-row"><span class="t-label">当日</span><span class="t-val ${sc(it.dayPct)}">${w(it.dayPct)}</span></div>`;
      html += `<div class="t-row"><span class="t-label">1 周</span><span class="t-val ${sc(it.weekPct)}">${w(it.weekPct)}</span></div>`;
      html += `<div class="t-row"><span class="t-label">1 月</span><span class="t-val ${sc(it.monthPct)}">${w(it.monthPct)}</span></div>`;
      html += `<div class="t-row"><span class="t-label">1 年</span><span class="t-val ${sc(it.yearPct)}">${w(it.yearPct)}</span></div>`;
      // 单只 ETF Sina K线 (优先) / SVG sparkline (海外 ETF fallback)
      const sinaUrl = sinaKlineUrl(it.code);
      if (sinaUrl) {
        html += `<img class="t-kline" src="${sinaUrl}" alt="${it.code} K线" loading="lazy" referrerpolicy="no-referrer" ` +
                `onerror="this.outerHTML='${escapeAttr(sparklineSvg(it.rows, it.idx))}'">`;
      } else {
        html += sparklineSvg(it.rows, it.idx);
      }
      html += `<div class="t-hint">双击 → 技术分析</div>`;
    }
    tip.innerHTML = html; tip.style.display = 'block';
    // 边界检查 (4 方向夹紧, 距屏边 ≥ 4px)
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = mx + 14, top = my + 14;
    if (left + tw > global.innerWidth - 4) left = mx - tw - 14;
    if (top + th > global.innerHeight - 4) top = my - th - 14;
    if (left < 4) left = 4;
    if (top < 4) top = 4;
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
      state.snapshotOffset = parseInt(e.target.value, 10) || 0;
      // 钻取状态保留: 用户可能想看"该类别 1 周前"的子项
      state.current = aggregateByCategory(state.etfs, state.snapshotOffset);
      state.lastDate = pickLastDate(state.etfs, state.snapshotOffset);
      $('snapshot-date').textContent = `快照: ${state.lastDate || '—'}`;
      if (state.drilldown) renderLevel2(state.drilldown);
      else renderLevel1();
    });
    $('btn-back').addEventListener('click', () => {
      state.drilldown = null; $('btn-back').style.display = 'none'; renderLevel1();
    });
    $('btn-screenshot').addEventListener('click', exportPng);
    $('btn-fullscreen').addEventListener('click', () => {
      const el = $('heatmap-wrap');
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      try {
        const p = document.fullscreenElement ? exit.call(document) : req.call(el);
        if (p && p.catch) p.catch((err) => console.warn('fullscreen denied', err));
      } catch (err) { console.warn('fullscreen error', err); }
    });
    global.addEventListener('resize', window.ETF.utils.debounce(() => {
      if (state.drilldown) renderLevel2(state.drilldown);
      else if (state.current) renderLevel1();
    }, 100));
  }

  function exportPng() {
    if (!global.html2canvas) {
      alert('截图功能不可用 (html2canvas 未加载)\n请检查网络后刷新页面。');
      return;
    }
    // 读 CSS 变量背景色, 与主题一致
    const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg-2').trim() || '#161b22';
    global.html2canvas($('heatmap-wrap'), { backgroundColor: bgColor, scale: 2 }).then((cnv) => {
      cnv.toBlob((blob) => {
        if (!blob) {
          console.warn('toBlob returned null');
          alert('截图失败: 浏览器不支持 Canvas 转 PNG');
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `etf-heatmap-${state.lastDate || new Date().toISOString().slice(0, 10)}.png`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, 'image/png');
    }).catch((err) => {
      console.error('screenshot failed', err);
      alert('截图失败: ' + (err && err.message || err));
    });
  }

  function showError(err) {
    const loading = $('loading');
    if (!loading) return;
    loading.innerHTML = `<div style="color:#ef4444;text-align:center;padding:40px 20px">
      <div style="font-size:18px;font-weight:600;margin-bottom:8px">⚠ 数据加载失败</div>
      <div style="color:var(--text-mute);font-size:14px;font-family:ui-monospace,monospace;max-width:600px;margin:0 auto">${(err && err.message) || err}</div>
      <div style="margin-top:16px;font-size:13px;color:var(--text-mute)">请检查 <code>docs/csv/</code> 目录是否完整,然后<a href="javascript:location.reload()" style="color:#3b82f6">刷新页面</a>重试。</div>
    </div>`;
    // 禁用控件
    ['snapshot-select', 'btn-screenshot', 'btn-fullscreen'].forEach((id) => {
      const el = $(id); if (el) el.disabled = true;
    });
  }

  function disableScreenshotIfMissing() {
    if (global.html2canvas) return;
    const btn = $('btn-screenshot');
    if (btn) { btn.disabled = true; btn.title = '截图依赖 html2canvas 加载失败 (CDN 不可达)'; btn.style.opacity = '0.5'; }
  }

  global.addEventListener('DOMContentLoaded', async () => {
    disableScreenshotIfMissing();
    try {
      await window.ETF.ready;
      state.etfs = await window.ETF.all();
      if (!state.etfs.length) throw new Error('summary.csv 为空或全部 success=False');
      state.current = aggregateByCategory(state.etfs, state.snapshotOffset);
      state.lastDate = pickLastDate(state.etfs, state.snapshotOffset);
      $('snapshot-date').textContent = `快照: ${state.lastDate || '—'}`;
      $('loading').style.display = 'none';
      $('heatmap-wrap').style.display = '';
      $('legend').style.display = '';
      renderLevel1(); bindEvents();
      $('meta-count').textContent = `${state.etfs.length} ETFs · ${state.lastDate || '—'}`;
      // footer 动态化
      const footer = document.querySelector('footer.site-footer');
      if (footer) footer.textContent = `数据基于本地 CSV (${state.etfs.length} ETFs · ${state.etfs[0]?.rows.length || 0} trading days) — 仅供研究,不构成投资建议`;
    } catch (err) {
      console.error('heatmap load failed', err);
      showError(err);
    }
  });
})(window);