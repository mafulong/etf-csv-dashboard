"""
extract_us_etf.py (US ETF 补全脚本)
====================================
bstocks 的 us_dataloader.py 用的 `ak.stock_us_hist(symbol='107.SPY')` 走 eastmoney,
当前网络下不可用。改用 `ak.stock_us_daily(symbol='SPY')`(Sina 美股通道)补全。
"""

import json
import logging
import random
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import akshare as ak
import pandas as pd

OUTPUT_DIR = Path(__file__).resolve().parent
DATA_DIR = OUTPUT_DIR / "csv"
DATA_DIR.mkdir(exist_ok=True)
LOG_FILE = OUTPUT_DIR / "extract_us.log"

# bstocks/us_dataloader.py 中的 12 个美股 ETF;ticker 去前缀
US_ETFS = {
    "SPY": "标普500ETF",
    "QQQ": "纳斯达克100ETF",
    "IWY": "罗素3000成长ETF",
    "RSP": "标普500等权ETF",
    "EWJ": "日本ETF",
    "INDA": "印度ETF",
    "EWQ": "法国ETF",
    "EWG": "德国ETF",
    "VNM": "越南ETF",
    "MOAT": "美国晨星宽护城河ETF",
    "PFF": "美国优先股ETF",
    "VNQ": "美国REITsETF",
}

ONE_YEAR_AGO = (datetime.now() - timedelta(days=365)).strftime("%Y%m%d")
YESTERDAY = (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("us-extract")


def jitter(base: float, jitter_pct: float = 0.5) -> float:
    return base * random.uniform(1 - jitter_pct, 1 + jitter_pct)


def fetch_us_daily(symbol: str, max_retry: int = 3) -> pd.DataFrame:
    """ak.stock_us_daily(symbol='SPY') 返回所有历史,从 date 列过滤近 1 年。"""
    last_err: Exception | None = None
    for attempt in range(1, max_retry + 1):
        try:
            df = ak.stock_us_daily(symbol=symbol, adjust="qfq")
            if df is None or df.empty:
                raise ValueError(f"empty dataframe for {symbol}")
            # 过滤近 1 年
            df = df.copy()
            df["date"] = pd.to_datetime(df["date"], errors="coerce")
            df = df.dropna(subset=["date"])
            start_dt = pd.to_datetime(ONE_YEAR_AGO, format="%Y%m%d")
            end_dt = pd.to_datetime(YESTERDAY, format="%Y%m%d")
            df = df[(df["date"] >= start_dt) & (df["date"] <= end_dt)]
            return df.sort_values("date").reset_index(drop=True)
        except Exception as e:
            last_err = e
            log.warning("[us] %s 失败 attempt=%d/%d err=%s",
                        symbol, attempt, max_retry, str(e)[:120])
            if attempt < max_retry:
                time.sleep(jitter(2.0 ** attempt))
    raise RuntimeError(f"us ETF {symbol} 失败: {last_err}")


def main() -> int:
    log.info("=" * 70)
    log.info("补全 12 个美股 ETF 近 1 年数据 (Sina 通道)")
    log.info("=" * 70)

    summary = []
    consecutive_fail = 0
    for idx, (symbol, name) in enumerate(US_ETFS.items(), start=1):
        if idx > 1:
            time.sleep(jitter(2.0))

        if consecutive_fail >= 3:
            cool = 60
            log.warning("=== 连续失败 %d 次,全局冷却 %ds ===", consecutive_fail, cool)
            time.sleep(cool)
            consecutive_fail = 0

        try:
            df = fetch_us_daily(symbol)
            path = DATA_DIR / f"{symbol}_{name}.csv"
            df.to_csv(path, index=False, encoding="utf-8-sig")

            start_date = df["date"].min().strftime("%Y-%m-%d") if not df.empty else ""
            end_date = df["date"].max().strftime("%Y-%m-%d") if not df.empty else ""

            log.info("[%d/%d] ✅ %s (%s) rows=%d start=%s end=%s",
                     idx, len(US_ETFS), name, symbol, len(df), start_date, end_date)
            summary.append({
                "code": symbol, "name": name, "category": "美股",
                "success": True, "rows": len(df),
                "start_date": start_date, "end_date": end_date,
                "csv_path": str(path), "error": "",
            })
            consecutive_fail = 0
        except Exception as e:
            err = str(e)[:160]
            log.error("[%d/%d] ❌ %s (%s) err=%s", idx, len(US_ETFS), name, symbol, err)
            summary.append({
                "code": symbol, "name": name, "category": "美股",
                "success": False, "rows": 0,
                "start_date": "", "end_date": "",
                "csv_path": "", "error": err,
            })
            consecutive_fail += 1

    # 合并到 _summary.csv (append mode)
    summary_path = DATA_DIR / "_summary.csv"
    summary_df = pd.DataFrame(summary)
    if summary_path.exists():
        existing = pd.read_csv(summary_path)
        # 移除已存在的美股行
        existing = existing[existing["category"] != "美股"]
        combined = pd.concat([existing, summary_df], ignore_index=True)
    else:
        combined = summary_df
    combined.to_csv(summary_path, index=False, encoding="utf-8-sig")

    failed = [s for s in summary if not s["success"]]
    log.info("=" * 70)
    log.info("美股补全完成 ✅ 成功 %d / 总 %d", len(summary) - len(failed), len(US_ETFS))
    log.info("=" * 70)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())