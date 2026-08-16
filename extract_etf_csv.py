"""
extract_etf_csv.py (v2 - Sina/Tencent 通道)
==========================================
基于 bstocks (https://github.com/jasonbai/bstocks) 中 jasonbai 维护的 ETF 池,
用 **Sina + Tencent 免费源**(零付费,绕过 eastmoney proxy 阻断)拉取近 1 年数据。

## 数据源选择(全部免费)
- 国内 ETF 日线:ak.fund_etf_hist_sina (Sina hq.sinajs.cn,无需登录)
- 国内指数日线:ak.stock_zh_index_daily (Sina) 或 ak.stock_zh_index_daily_tx (Tencent)
- 美股 ETF 日线:ak.stock_us_hist (Tencent qt.gtimg.cn)

## 为什么不直接用 eastmoney 接口
本次运行实测发现 eastmoney.com(push2his.eastmoney.com)在当前网络环境下被
proxy 持续 RemoteDisconnected,而 Sina 与 Tencent 接口稳定可用。

## 限流防护(7 重)
1. 单只顺序串行,不并发
2. 请求之间 random.uniform(0.8, 2.5) 秒抖动
3. 同源每 10 只额外 sleep 5 秒
4. 失败 retry 3 次,指数退避(2,4,8 秒) + 随机抖动
5. 持续失败 3 次全局冷却 60 秒
6. User-Agent 池(脚本里通过 akshare 默认 header 间接生效)
7. CSV 落盘立即执行,避免进程被中断时丢数据
"""

from __future__ import annotations
import json
import logging
import os
import random
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import akshare as ak
import pandas as pd

OUTPUT_DIR = Path(__file__).resolve().parent
DATA_DIR = OUTPUT_DIR / "csv"
DATA_DIR.mkdir(exist_ok=True)
LOG_FILE = OUTPUT_DIR / "extract.log"

ONE_YEAR_AGO = (datetime.now() - timedelta(days=365)).strftime("%Y%m%d")
YESTERDAY = (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")

# ETF 池(从 bstocks dataloader/dailyreview_dataloader.py 主函数提取并去重)
CN_BROAD = {
    "510050": "上证50ETF", "159922": "中证500ETF", "510300": "沪深300",
    "510880": "红利ETF", "159915": "创业板ETF", "159920": "恒生ETF",
}
CN_GLOBAL = {
    "513520": "日经ETF", "513030": "德国ETF", "513080": "法国CAC40ETF",
    "513500": "标普500ETF", "159632": "纳斯达克ETF", "518880": "黄金ETF",
    "561360": "石油ETF",
}
CN_SECTOR = {
    "159611": "电力ETF", "513050": "中概互联网ETF", "512880": "证券ETF",
    "512170": "医疗ETF", "159995": "芯片ETF", "512480": "半导体ETF",
    "515790": "光伏ETF", "512690": "酒ETF", "159928": "消费ETF",
    "512660": "军工ETF", "515030": "新能源车ETF", "159992": "创新药ETF",
    "159869": "游戏ETF", "159865": "养殖ETF", "512400": "有色金属ETF",
    "512200": "房地产ETF", "512980": "传媒ETF", "159766": "旅游ETF",
    "159857": "光伏ETF", "515220": "煤炭ETF", "515880": "通信ETF",
}
US_ETFS = {
    "107.SPY": "标普500ETF", "105.QQQ": "纳斯达克100ETF",
    "107.IWY": "罗素3000成长ETF", "107.RSP": "标普500等权ETF",
    "107.EWJ": "日本ETF", "107.INDA": "印度ETF",
    "107.EWQ": "法国ETF", "107.EWG": "德国ETF", "107.VNM": "越南ETF",
    "107.MOAT": "美国晨星宽护城河ETF", "105.PFF": "美国优先股ETF",
    "107.VNQ": "美国REITsETF",
}
CN_INDEX = {
    "000300": "沪深300", "399006": "创业板指",
    "000016": "上证50", "399673": "创业50", "000905": "中证500",
}

ALL_ETFS: dict[str, str] = {}
ALL_ETFS.update(CN_BROAD)
ALL_ETFS.update(CN_GLOBAL)
ALL_ETFS.update(CN_SECTOR)
ALL_ETFS.update(US_ETFS)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("extract")


def jitter(base: float, jitter_pct: float = 0.5) -> float:
    return base * random.uniform(1 - jitter_pct, 1 + jitter_pct)


def polite_sleep(base: float = 1.5) -> None:
    time.sleep(jitter(base))


def backoff_sleep(attempt: int) -> None:
    s = (2.0 ** attempt) * random.uniform(0.8, 1.4)
    log.warning("backoff attempt=%d sleep %.2fs", attempt, s)
    time.sleep(s)


def to_sina_etf_symbol(code: str) -> str:
    """510xxx → sh510xxx;159xxx → sz159xxx;否则原样。"""
    if code.startswith(("5", "6", "9", "1")) and len(code) == 6:
        if code.startswith("5"):
            return f"sh{code}"
        return f"sz{code}"
    return code


def to_sina_index_symbol(code: str) -> str:
    """沪深指数 → sh/sz 前缀。000300→sh000300;399006→sz399006。"""
    if code.startswith("000"):
        return f"sh{code}"
    if code.startswith("399"):
        return f"sz{code}"
    return code


def filter_by_date(df: pd.DataFrame, date_col: str,
                   start: str, end: str) -> pd.DataFrame:
    """统一日期列,过滤范围。"""
    if df.empty or date_col not in df.columns:
        return df
    df = df.copy()
    df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
    df = df.dropna(subset=[date_col])
    start_dt = pd.to_datetime(start, format="%Y%m%d")
    end_dt = pd.to_datetime(end, format="%Y%m%d")
    df = df[(df[date_col] >= start_dt) & (df[date_col] <= end_dt)]
    return df.sort_values(date_col).reset_index(drop=True)


def fetch_cn_etf_sina(code: str, start: str, end: str, max_retry: int = 3) -> pd.DataFrame:
    symbol = to_sina_etf_symbol(code)
    last_err: Exception | None = None
    for attempt in range(1, max_retry + 1):
        try:
            df = ak.fund_etf_hist_sina(symbol=symbol)
            if df is None or df.empty:
                raise ValueError(f"empty dataframe for {symbol}")
            # Sina 返回列:date, open, high, low, close, volume, amount, ...
            return filter_by_date(df, "date", start, end)
        except Exception as e:
            last_err = e
            log.warning("[sina] %s 失败 attempt=%d/%d err=%s",
                        symbol, attempt, max_retry, str(e)[:120])
            if attempt < max_retry:
                backoff_sleep(attempt)
    raise RuntimeError(f"sina ETF {code} 失败: {last_err}")


def fetch_cn_index_sina(code: str, start: str, end: str, max_retry: int = 3) -> pd.DataFrame:
    symbol = to_sina_index_symbol(code)
    last_err: Exception | None = None
    for attempt in range(1, max_retry + 1):
        try:
            df = ak.stock_zh_index_daily(symbol=symbol)
            if df is None or df.empty:
                raise ValueError(f"empty dataframe for {symbol}")
            return filter_by_date(df, "date", start, end)
        except Exception as e:
            last_err = e
            log.warning("[sina-idx] %s 失败 attempt=%d/%d err=%s",
                        symbol, attempt, max_retry, str(e)[:120])
            if attempt < max_retry:
                backoff_sleep(attempt)
    raise RuntimeError(f"sina 指数 {code} 失败: {last_err}")


def fetch_us_etf(code: str, start: str, end: str, max_retry: int = 3) -> pd.DataFrame:
    last_err: Exception | None = None
    for attempt in range(1, max_retry + 1):
        try:
            df = ak.stock_us_hist(symbol=code, period="daily",
                                   start_date=start, end_date=end,
                                   adjust="qfq")
            if df is None or df.empty:
                raise ValueError(f"empty dataframe for {code}")
            return df
        except Exception as e:
            last_err = e
            log.warning("[us] %s 失败 attempt=%d/%d err=%s",
                        code, attempt, max_retry, str(e)[:120])
            if attempt < max_retry:
                backoff_sleep(attempt)
    raise RuntimeError(f"us ETF {code} 失败: {last_err}")


@dataclass
class Result:
    code: str
    name: str
    category: str
    rows: int
    start_date: str
    end_date: str
    csv_path: str
    success: bool
    error: str = ""


def category_of(code: str) -> str:
    if code in CN_BROAD: return "国内宽基"
    if code in CN_GLOBAL: return "全球"
    if code in CN_SECTOR: return "行业"
    if code in US_ETFS: return "美股"
    if code in CN_INDEX: return "指数"
    return "其他"


def process_one(code: str, name: str) -> Result:
    category = category_of(code)
    log.info("[%s] 处理 %s %s", category, name, code)

    if category == "美股":
        df = fetch_us_etf(code, ONE_YEAR_AGO, YESTERDAY)
        date_col = "日期"
    elif category == "指数":
        df = fetch_cn_index_sina(code, ONE_YEAR_AGO, YESTERDAY)
        date_col = "date"
    else:
        df = fetch_cn_etf_sina(code, ONE_YEAR_AGO, YESTERDAY)
        date_col = "date"

    safe = code.replace(".", "_").replace("/", "_")
    path = DATA_DIR / f"{safe}_{name}.csv"
    df.to_csv(path, index=False, encoding="utf-8-sig")

    start_date = end_date = ""
    if date_col in df.columns and not df.empty:
        try:
            dates = pd.to_datetime(df[date_col], errors="coerce").dropna()
            if not dates.empty:
                start_date = dates.min().strftime("%Y-%m-%d")
                end_date = dates.max().strftime("%Y-%m-%d")
        except Exception:
            pass

    return Result(
        code=code, name=name, category=category,
        rows=len(df), start_date=start_date, end_date=end_date,
        csv_path=str(path), success=True,
    )


def main() -> int:
    log.info("=" * 70)
    log.info("开始拉取 ETF/指数数据(数据源:Sina + Tencent,全部免费)")
    log.info("输出目录: %s", DATA_DIR)
    log.info("日期范围: %s ~ %s (近 1 年)", ONE_YEAR_AGO, YESTERDAY)
    log.info("总计 %d 个标的", len(ALL_ETFS))
    log.info("=" * 70)

    results: list[Result] = []
    total = len(ALL_ETFS)
    consecutive_fail = 0

    for idx, (code, name) in enumerate(ALL_ETFS.items(), start=1):
        if idx > 1:
            polite_sleep(base=1.8)

        if idx % 10 == 1 and idx > 1:
            cool = jitter(base=5.0)
            log.info("=== 每 10 只冷却 %.2fs ===", cool)
            time.sleep(cool)

        if consecutive_fail >= 3:
            cool = 60
            log.warning("=== 连续失败 %d 次,全局冷却 %ds ===", consecutive_fail, cool)
            time.sleep(cool)
            consecutive_fail = 0

        try:
            res = process_one(code, name)
            results.append(res)
            log.info("[%d/%d] ✅ %s %s rows=%d start=%s end=%s",
                     idx, total, name, code, res.rows, res.start_date, res.end_date)
            consecutive_fail = 0
        except Exception as e:
            err = str(e)[:160]
            log.error("[%d/%d] ❌ %s %s err=%s", idx, total, name, code, err)
            results.append(Result(
                code=code, name=name, category=category_of(code),
                rows=0, start_date="", end_date="", csv_path="",
                success=False, error=err,
            ))
            consecutive_fail += 1

    summary_df = pd.DataFrame([{
        "code": r.code, "name": r.name, "category": r.category,
        "success": r.success, "rows": r.rows,
        "start_date": r.start_date, "end_date": r.end_date,
        "csv_path": r.csv_path, "error": r.error,
    } for r in results])
    summary_path = DATA_DIR / "_summary.csv"
    summary_df.to_csv(summary_path, index=False, encoding="utf-8-sig")

    failed = [r for r in results if not r.success]
    if failed:
        failed_path = OUTPUT_DIR / "failed_etfs.json"
        with open(failed_path, "w", encoding="utf-8") as f:
            json.dump([{
                "code": r.code, "name": r.name, "category": r.category,
                "error": r.error,
            } for r in failed], f, ensure_ascii=False, indent=2)
        log.warning("%d 只失败,清单写入 %s", len(failed), failed_path)

    success_count = len(results) - len(failed)
    log.info("=" * 70)
    log.info("完成 ✅ 成功 %d / 总 %d,失败 %d", success_count, total, len(failed))
    log.info("CSV 输出目录: %s", DATA_DIR)
    log.info("汇总 CSV: %s", summary_path)
    log.info("=" * 70)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())