/* ==========================================================================
   ETF Dashboard — AI summary rule engine
   window.ETF.ai: { compute(snapshot) -> { summary, risks, actions, top5, bottom5 } }
   No LLM calls — all deterministic, all from local data.
   ========================================================================== */
(function (global) {
  'use strict';

  const CATEGORY_LABELS = {
    '国内宽基': '国内宽基',
    '全球': '全球',
    '行业': '行业 ETF',
    '美股': '美股 ETF',
    '指数': '指数',
  };

  /** Compute per-window return from closes. */
  function windowReturn(closes, n) {
    if (closes.length < n + 1) return null;
    const last = closes[closes.length - 1];
    const past = closes[closes.length - 1 - n];
    return last / past - 1;
  }

  /** Find max drawdown over a window. */
  function windowDrawdown(closes, n) {
    if (closes.length < 2) return 0;
    const start = Math.max(0, closes.length - n);
    const slice = closes.slice(start);
    let peak = slice[0];
    let mdd = 0;
    for (const c of slice) {
      if (c > peak) peak = c;
      const dd = c / peak - 1;
      if (dd < mdd) mdd = dd;
    }
    return mdd;
  }

  /** Build a snapshot from a list of parsed series. */
  function buildSnapshot(series) {
    const items = series
      .filter((s) => s.rows && s.rows.length > 1)
      .map((s) => {
        const closes = s.rows.map((r) => r.close);
        return {
          code: s.code,
          name: s.name,
          category: s.category,
          closes,
          day: windowReturn(closes, 1),
          week: windowReturn(closes, 5),
          month: windowReturn(closes, 20),
          month3: windowReturn(closes, 60),
          mdd1m: windowDrawdown(closes, 20),
          mdd3m: windowDrawdown(closes, 60),
        };
      });
    return { items, asOf: global.ETF.lastDate };
  }

  /** Group items by category, average returns. */
  function byCategory(items) {
    const map = new Map();
    for (const it of items) {
      if (!map.has(it.category)) map.set(it.category, []);
      map.get(it.category).push(it);
    }
    const out = [];
    for (const [cat, arr] of map) {
      const avg = (k) => arr.reduce((a, x) => a + (x[k] ?? 0), 0) / arr.length;
      out.push({
        category: cat,
        count: arr.length,
        day: avg('day'),
        week: avg('week'),
        month: avg('month'),
        month3: avg('month3'),
      });
    }
    return out;
  }

  /** Determine trend word from average day return. */
  function trendWord(avg) {
    if (avg > 0.012) return '强势';
    if (avg > 0.003) return '偏强';
    if (avg > -0.003) return '震荡';
    if (avg > -0.012) return '偏弱';
    return '弱势';
  }

  /** A. Market summary (200-400 字). */
  function buildSummary(snap, cats) {
    const { items, asOf } = snap;
    const ups = items.filter((x) => x.day > 0).length;
    const dns = items.length - ups;
    const flat = items.filter((x) => x.day === 0).length;
    const avgDay = items.reduce((a, x) => a + x.day, 0) / items.length;
    const trend = trendWord(avgDay);

    cats.sort((a, b) => b.day - a.day);
    const leader = cats[0];
    const lagger = cats[cats.length - 1];
    const gap = leader.day - lagger.day;

    // strongest week/month category
    const weekCat = [...cats].sort((a, b) => (b.week ?? 0) - (a.week ?? 0))[0];
    const monthCat = [...cats].sort((a, b) => (b.month ?? 0) - (a.month ?? 0))[0];
    const monthLag = [...cats].sort((a, b) => (a.month ?? 0) - (b.month ?? 0))[0];

    // breadth signal
    const breadth = ups / items.length;
    const breadthWord =
      breadth > 0.7 ? '普涨' :
      breadth > 0.45 ? '分化' :
      breadth > 0.2 ? '跌多涨少' : '普跌';

    const lines = [];
    lines.push(
      `${asOf} 收盘,共追踪 ${items.length} 只 ETF,` +
      `<strong>${ups} 涨 ${dns} 跌${flat ? ' ' + flat + ' 平' : ''}</strong>,` +
      `整体呈现<strong>${breadthWord}</strong>格局,市场情绪<strong>${trend}</strong>。`
    );
    lines.push(
      `类别层面,<strong>${CATEGORY_LABELS[leader.category] || leader.category}</strong>` +
      `以 ${(leader.day * 100).toFixed(2)}% 的平均涨幅领跑,` +
      `<strong>${CATEGORY_LABELS[lagger.category] || lagger.category}</strong>` +
      `则下跌 ${(lagger.day * 100).toFixed(2)}% 居末,` +
      `类别分化达 ${(gap * 100).toFixed(2)} 个百分点。`
    );
    lines.push(
      `拉长时间看,近 1 周最强为<strong>${CATEGORY_LABELS[weekCat.category] || weekCat.category}</strong>` +
      `(${ETF.utils.pct(weekCat.week)}),` +
      `近 1 月领涨的<strong>${CATEGORY_LABELS[monthCat.category] || monthCat.category}</strong>` +
      `(${ETF.utils.pct(monthCat.month)})` +
      `与表现靠后的<strong>${CATEGORY_LABELS[monthLag.category] || monthLag.category}</strong>` +
      `(${ETF.utils.pct(monthLag.month)}) 形成显著反差,` +
      `结构化行情特征明显。`
    );
    if (Math.abs(avgDay) > 0.015) {
      lines.push(
        `当日全市场均值波动 ${ETF.utils.pct(avgDay)},` +
        `幅度较大,建议关注后续量能配合与板块轮动持续性。`
      );
    } else {
      lines.push(`整体波动温和,关注持仓品种相对强弱与趋势延续性。`);
    }
    return lines.join('\n\n');
  }

  /** B. Risk alerts (3-5 条). */
  function buildRisks(snap) {
    const { items } = snap;
    const risks = [];

    // 1. single-ETF overheat: 1m > 15%
    const hot = items
      .filter((x) => x.month != null && x.month > 0.15)
      .sort((a, b) => b.month - a.month)
      .slice(0, 2);
    if (hot.length) {
      risks.push({
        level: 'warn',
        text:
          `<strong>${hot.map((h) => h.name).join('、')}</strong> 近 1 月累计涨幅 ` +
          `${hot.map((h) => ETF.utils.pct(h.month)).join(' / ')},` +
          `显著高于市场均值,留意短期获利回吐风险。`,
      });
    }

    // 2. weak single-ETF: 1m < -10%
    const cold = items
      .filter((x) => x.month != null && x.month < -0.10)
      .sort((a, b) => a.month - b.month)
      .slice(0, 2);
    if (cold.length) {
      risks.push({
        level: 'warn',
        text:
          `<strong>${cold.map((h) => h.name).join('、')}</strong> 近 1 月回撤 ` +
          `${cold.map((h) => ETF.utils.pct(h.month)).join(' / ')},` +
          `若仍在下行通道,避免抄底过早。`,
      });
    }

    // 3. sector cluster volatility: 行业 category average 1w > 4%
    const catWeekMap = new Map();
    for (const x of items) {
      const arr = catWeekMap.get(x.category) || [];
      arr.push(x);
      catWeekMap.set(x.category, arr);
    }
    for (const [cat, arr] of catWeekMap) {
      if (arr.length < 2) continue;
      const avgW = arr.reduce((a, x) => a + (x.week ?? 0), 0) / arr.length;
      if (Math.abs(avgW) > 0.04) {
        risks.push({
          level: 'info',
          text:
            `<strong>${CATEGORY_LABELS[cat] || cat}</strong> 类别 ${arr.length} 只 ETF ` +
            `近 1 周平均涨跌幅 ${ETF.utils.pct(avgW)},` +
            `板块整体波动放大,关注联动风险。`,
        });
      }
    }

    // 4. US ETF drawdown
    const usDrawdown = items
      .filter((x) => x.category === '美股' && (x.mdd1m ?? 0) < -0.08)
      .slice(0, 2);
    if (usDrawdown.length) {
      risks.push({
        level: 'warn',
        text:
          `<strong>${usDrawdown.map((h) => h.name).join('、')}</strong> ` +
          `近 1 月最大回撤 ` +
          `${usDrawdown.map((h) => ETF.utils.pct(h.mdd1m)).join(' / ')},` +
          `进入回撤期,提示地缘与汇率风险。`,
      });
    }

    // 5. broad downside
    const dayDns = items.filter((x) => x.day < -0.02).length;
    if (dayDns > items.length * 0.4) {
      risks.push({
        level: 'warn',
        text:
          `当日下跌超过 2% 的 ETF 共 <strong>${dayDns}</strong> 只,` +
          `占样本 ${(dayDns / items.length * 100).toFixed(0)}%,` +
          `系统性回调概率上升,控制总仓位。`,
      });
    }

    // pad to at least 3
    if (risks.length < 3) {
      risks.push({
        level: 'info',
        text:
          `整体类别相关性需观察,若持仓集中于单一类别,` +
          `建议补充不同资产类别的 ETF 分散配置。`,
      });
    }
    return risks.slice(0, 5);
  }

  /** C. Action suggestions (3-5 条). */
  function buildActions(snap) {
    const { items } = snap;
    const actions = [];

    // 1. momentum confirm: 1m > 5% AND 1w > 0 AND maxDD 1m shallow
    const momentum = items
      .filter((x) =>
        (x.month ?? 0) > 0.05 &&
        (x.week ?? 0) > 0 &&
        (x.mdd1m ?? 0) > -0.05
      )
      .sort((a, b) => b.month - a.month)
      .slice(0, 2);
    if (momentum.length) {
      actions.push({
        text:
          `动量趋势确认:<strong>${momentum.map((m) => m.name).join('、')}</strong> ` +
          `近 1 月/1 周双双收阳且回撤浅,可考虑在回踩时小仓位跟进。`,
      });
    }

    // 2. below MA60 proxy: use month3 < -5% AND week negative
    const weak = items
      .filter((x) =>
        (x.month3 ?? 0) < -0.05 &&
        (x.week ?? 0) < 0
      )
      .sort((a, b) => a.month3 - b.month3)
      .slice(0, 2);
    if (weak.length) {
      actions.push({
        text:
          `跌破中期均线:<strong>${weak.map((m) => m.name).join('、')}</strong> ` +
          `近 3 月仍处下行通道,建议减仓或观望,等待企稳信号。`,
      });
    }

    // 3. low correlation suggestion: use distinct category leaders
    const cats = byCategory(items);
    const leaders = cats.filter((c) => c.month != null).sort((a, b) => b.month - a.month);
    if (leaders.length >= 2) {
      const a = leaders[0], b = leaders[1];
      actions.push({
        text:
          `组合配置:跨类别分散可考虑<strong>${CATEGORY_LABELS[a.category] || a.category}</strong>` +
          `(${ETF.utils.pct(a.month)}) + ` +
          `<strong>${CATEGORY_LABELS[b.category] || b.category}</strong>` +
          `(${ETF.utils.pct(b.month)}) 这两条相关性较低的赛道。`,
      });
    }

    // 4. defensive: gold/oil divergence
    const gold = items.find((x) => x.name.includes('黄金'));
    const oil = items.find((x) => x.name.includes('石油'));
    if (gold || oil) {
      const parts = [];
      if (gold) parts.push(`黄金 ${ETF.utils.pct(gold.month)}`);
      if (oil) parts.push(`石油 ${ETF.utils.pct(oil.month)}`);
      actions.push({
        text:
          `防御配置:近 1 月 ${parts.join('、')},` +
          `若权益仓位较高,可适当增加避险资产对冲。`,
      });
    }

    // 5. rebalance: extreme overweights
    const top1 = [...items].sort((a, b) => b.month - a.month)[0];
    const bot1 = [...items].sort((a, b) => a.month - b.month)[0];
    if (top1 && bot1) {
      actions.push({
        text:
          `板块再平衡:涨幅领先 <strong>${top1.name}</strong>` +
          `(${ETF.utils.pct(top1.month)}) 可适度止盈,` +
          `跌幅最深 <strong>${bot1.name}</strong>` +
          `(${ETF.utils.pct(bot1.month)}) 不建议立即加仓。`,
      });
    }

    return actions.slice(0, 5);
  }

  /** Top/Bottom 5 by day return. */
  function buildTopBottom(snap) {
    const sorted = [...snap.items]
      .filter((x) => x.day != null)
      .sort((a, b) => b.day - a.day);
    return {
      top5: sorted.slice(0, 5),
      bottom5: sorted.slice(-5).reverse(),
    };
  }

  const api = {
    buildSnapshot,
    compute(snap) {
      const cats = byCategory(snap.items);
      const summary = buildSummary(snap, cats);
      const risks = buildRisks(snap);
      const actions = buildActions(snap);
      const { top5, bottom5 } = buildTopBottom(snap);
      const catsSorted = [...cats].sort((a, b) => b.day - a.day);
      return { summary, risks, actions, top5, bottom5, categories: catsSorted };
    },
    run() {
      return global.ETF.ready
        .then(() => global.ETF.all())
        .then((series) => api.compute(buildSnapshot(series)));
    },
  };

  global.ETF = Object.assign(global.ETF || {}, { ai: api });
})(window);