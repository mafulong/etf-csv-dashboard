# ETF CSV Dashboard

> 纯前端的静态 ETF 数据看板 — 基于本地 CSV,无后端、无 LLM 调用。
> 数据每周由 GitHub Actions 自动从免费接口拉取并提交。

## 截图

| 首页 | 综合仪表盘 |
|:--:|:--:|
| _(截图占位符)_ | _(截图占位符)_ |

| AI 解读 | 组合诊断 |
|:--:|:--:|
| _(截图占位符)_ | _(截图占位符)_ |

## 功能

- **行情看板** —— 46 只 ETF 的当日 / 近 1 周 / 近 1 月 / 近 3 月涨跌,类别筛选。
- **AI 解读** —— 基于规则的引擎自动生成市场总结、风险提示、操作建议。
- **组合诊断** —— 输入 ETF 代码 + 持仓数量,本地计算总市值、收益、最大回撤、行业暴露饼图、与沪深 300 对比的 Beta / Alpha / 相关系数。
- **持仓持久化** —— localStorage 保存 / 加载组合。

## 数据源

- 国内 ETF 日线: `ak.fund_etf_hist_sina` (Sina `hq.sinajs.cn`)
- 国内指数日线: `ak.stock_zh_index_daily` (Sina)
- 美股 ETF 日线: `ak.stock_us_daily` (Sina 美股通道)
- ETF 池来源于 [bstocks](https://github.com/jasonbai/bstocks) 中 jasonbai 维护的清单。

| 类别 | 数量 | 代表 |
|:--|:--:|:--|
| 国内宽基 | 6 | 沪深 300 / 上证 50 / 创业板 |
| 全球 | 7 | 黄金 / 石油 / 标普 500 |
| 行业 | 21 | 半导体 / 酒 / 医疗 / 军工 |
| 美股 | 12 | SPY / QQQ / VNQ |

合计 **46 只 ETF + 1 个基准指数**。

## 项目结构

```
.
├── csv/                          # 数据目录 (46 个 CSV + _summary.csv)
│   ├── _summary.csv              # 元数据
│   ├── 510300_沪深300.csv        # CSV schema: date,open,high,low,close,volume,...
│   └── ...
├── docs/                         # 静态站点
│   ├── index.html                # 首页
│   ├── dashboard.html            # 综合仪表盘
│   ├── ai-summary.html           # AI 解读
│   ├── portfolio.html            # 组合诊断
│   └── assets/
│       ├── css/style.css
│       └── js/
│           ├── load.js           # window.ETF
│           ├── utils.js          # window.ETF.utils
│           └── ai.js             # window.ETF.ai
├── extract_etf_csv.py            # CN 数据拉取
├── extract_us_etf.py             # 美股数据拉取
└── .github/workflows/
    └── refresh-data.yml          # 每周一 08:00(北京时间)自动拉取
```

## 本地运行

```bash
# 拉取最新 CSV
pip install akshare
python extract_etf_csv.py
python extract_us_etf.py

# 启动静态站点
python3 -m http.server 8080 --directory docs
# 打开 http://localhost:8080
```

## GitHub Actions

- 触发:`schedule`(每周一 08:00 北京时间)+ `workflow_dispatch`(手动)
- 步骤:`actions/checkout@v4` → `actions/setup-python@v5` → `pip install akshare pandas` → 跑两个 Python 脚本 → 自动 commit + push
- 失败不会让 workflow 报错 — `git commit ... || exit 0` 保证没有更新时也成功退出

## License

MIT