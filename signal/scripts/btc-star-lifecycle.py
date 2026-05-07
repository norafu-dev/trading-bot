# -*- coding: utf-8 -*-
"""
BTC 星辰 生命周期分析脚本

把 BTC 星辰频道的消息按"仓位生命周期"组装：
    open → [add * N] → [partial_tp * M] → close_*
然后给出：胜率、加仓表现、sync 接现状表现、PnL 等关键统计。

为什么需要这个：
  BTC 星辰是上链交易员的镜像 bot，决策规则（要不要跟加仓、要不要跟
  startup-sync 持仓）需要靠真实历史表现来判断，而不是直觉。让脚本
  随时能跑出最新统计，配合 bias 提醒，避免基于太少样本下结论。

数据源（按可用性回退）：
  1. --via-export   → 调本地 signal server 的 /api/discord/export，
                       拉 Discord 历史。需要 server 在跑。
  2. 默认           → 离线读 data/messages/messages.jsonl。
                       只包含 server 启动后实时监听到的消息，跨度有限。

用法：
    # 离线，默认 30 天窗口
    python signal/scripts/btc-star-lifecycle.py

    # 在线拉过去 60 天
    python signal/scripts/btc-star-lifecycle.py --via-export --days 60

    # 指定不同的频道
    python signal/scripts/btc-star-lifecycle.py --channel-id 1234567890

设计取舍：
  - 不写 .ts。这是一次性分析工具，Python 的 regex + 字典处理写起来
    比 TypeScript 顺，且不用过工具链。
  - 数据源仍然是 messages.jsonl 的"原始 Discord 消息"，不是
    operations.jsonl 的"已开 operation"。这是故意的：原交易员的全部
    动作都在 messages.jsonl，无论我们的管线是否决定跟单。这才是评估
    "BTC 星辰本身的策略表现"应该看的源头。
"""

import argparse
import io
import json
import os
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Force UTF-8 stdout. On Windows the default is the OEM codepage (GBK / cp936)
# which can't encode our Chinese labels and ⚠️ emoji — UnicodeEncodeError at
# print time defeats the whole point of a quick-look script.
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)

# ── Configuration ───────────────────────────────────────────────────────────

# Project root resolved as scripts/.. (signal/scripts → signal → repo)
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent

DEFAULT_CHANNEL_ID = "1477018485614969072"  # nurse-btc-star channel
DEFAULT_AUTHOR_ID = "1477018859750817872"   # BTC 星辰 KOL

# ── Message classification ──────────────────────────────────────────────────


def classify(text: str) -> str:
    """Map a btc-star message to one of seven event kinds."""
    if "状态：发现新开仓动作" in text:
        return "open"
    if "状态：仓位已增加" in text:
        return "add"
    if "状态：部分止盈" in text:
        return "partial_tp"
    if "状态：止盈平仓" in text or "做多止盈" in text or "做空止盈" in text:
        return "close_win"
    if "状态：止损平仓" in text:
        return "close_loss"
    if "状态：启动监控" in text:
        return "sync"
    if "状态：监控已关闭" in text:
        return "close_monitor"
    return "unknown"


def extract_symbol(text: str) -> str | None:
    """Pull the ticker out of "标的：XYZUSDT" or "总结：XYZUSDT" header."""
    m = re.search(r"(?:标的|总结)：([A-Z0-9]+)", text)
    return m.group(1) if m else None


def extract_price(text: str, label: str) -> float | None:
    """Find a labelled price like "入场均价：$ 378.75"."""
    m = re.search(rf"{label}[^\d-]*\$?\s*([\d.,]+)", text)
    return float(m.group(1).replace(",", "")) if m else None


def extract_side(text: str) -> str | None:
    if "做空 (Short)" in text:
        return "short"
    if "做多 (Long)" in text:
        return "long"
    return None


def extract_pnl(text: str) -> float | None:
    """Realised pnl from "已实现盈亏：+0.96 USDT" / "累计总盈亏：+3300 USDT"."""
    m = re.search(r"(?:已实现盈亏|累计总盈亏)[^\d+\-]*([+\-][\d.,]+)\s*USDT", text)
    return float(m.group(1).replace(",", "")) if m else None


# ── Data loading ────────────────────────────────────────────────────────────


def load_from_jsonl(channel_id: str, author_id: str, since_iso: str) -> list[dict]:
    """Read data/messages/messages.jsonl and filter to the target channel/author/time.

    Reports breakdown counts to stderr so an empty result is diagnosable
    (wrong channel? wrong window? jsonl missing entirely?).
    """
    path = REPO_ROOT / "data" / "messages" / "messages.jsonl"
    if not path.exists():
        print(f"WARN: {path} does not exist", file=sys.stderr)
        return []
    total = ch_match = author_match = window_match = 0
    out = []
    for line in path.open("r", encoding="utf-8"):
        try:
            m = json.loads(line)
        except Exception:
            continue
        total += 1
        if m.get("channelId") != channel_id:
            continue
        ch_match += 1
        if author_id and m.get("authorId") != author_id:
            continue
        author_match += 1
        ts = m.get("receivedAt") or m.get("timestamp")
        if ts and ts < since_iso:
            continue
        window_match += 1
        text = (m.get("content") or "").strip()
        for e in m.get("embeds") or []:
            desc = (e.get("description") or "").strip()
            if desc:
                text += "\n" + desc
        out.append({"timestamp": ts, "text": text, "messageId": m.get("messageId")})
    print(
        f"[jsonl] read {total} msgs → {ch_match} matched channel "
        f"→ {author_match} matched author → {window_match} in window",
        file=sys.stderr,
    )
    return out


def load_via_export(
    server: str, channel_id: str, since_iso: str, until_iso: str
) -> list[dict]:
    """Hit the running signal server's /api/discord/export to fetch history."""
    url = f"{server}/api/discord/export"
    body = {
        "channelIds": [channel_id],
        "authorIds": [],
        "dateFrom": since_iso[:10],
        "dateTo": until_iso[:10],
        "limit": 500,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)
    if not data.get("ok"):
        raise RuntimeError(f"export failed: {data}")
    # /export already returns {timestamp, text, ...} per record
    return data.get("messages", [])


# ── Lifecycle assembly ──────────────────────────────────────────────────────


def build_events(msgs: list[dict]) -> list[dict]:
    out = []
    for m in msgs:
        text = m.get("text") or ""
        kind = classify(text)
        sym = extract_symbol(text)
        if not sym:
            continue
        ev = {"ts": m["timestamp"], "kind": kind, "symbol": sym}
        if kind == "open":
            ev["entry"] = extract_price(text, "入场均价")
            ev["side"] = extract_side(text)
        elif kind == "add":
            ev["add_price"] = extract_price(text, "加仓价格")
        elif kind == "partial_tp":
            ev["exit_price"] = extract_price(text, "成交价格")
            ev["pnl"] = extract_pnl(text)
        elif kind in ("close_win", "close_loss"):
            ev["exit_price"] = extract_price(text, "平仓均价")
            ev["pnl"] = extract_pnl(text)
        out.append(ev)
    out.sort(key=lambda e: e["ts"])
    return out


def build_lifecycles(events: list[dict]) -> list[dict]:
    """Group events into per-position lifecycles keyed by symbol."""
    lifecycles = []
    current = {}  # symbol → in-progress lifecycle
    for ev in events:
        sym = ev["symbol"]
        # New lifecycle starts on 'open' OR on 'sync' if we don't have one open
        if ev["kind"] == "open" or (ev["kind"] == "sync" and sym not in current):
            if sym in current:
                # Position re-opened without an explicit close — flush the prior
                current[sym]["still_open"] = True
                lifecycles.append(current[sym])
            current[sym] = {"symbol": sym, "events": [ev]}
        elif sym in current:
            current[sym]["events"].append(ev)
            if ev["kind"] in ("close_win", "close_loss"):
                lifecycles.append(current[sym])
                del current[sym]
    for lc in current.values():
        lc["still_open"] = True
        lifecycles.append(lc)
    return lifecycles


# ── Analysis ────────────────────────────────────────────────────────────────


def lc_pnl(lc: dict) -> float:
    return sum(e["pnl"] for e in lc["events"] if e.get("pnl") is not None)


def has_close_win(lc: dict) -> bool:
    return any(e["kind"] == "close_win" for e in lc["events"])


def has_close_loss(lc: dict) -> bool:
    return any(e["kind"] == "close_loss" for e in lc["events"])


def report(events: list[dict], lifecycles: list[dict], days: int) -> None:
    closed = [lc for lc in lifecycles if not lc.get("still_open")]
    sync_starts = [lc for lc in lifecycles if lc["events"][0]["kind"] == "sync"]
    open_starts = [lc for lc in lifecycles if lc["events"][0]["kind"] == "open"]

    print("=" * 70)
    print(f"BTC 星辰 — 仓位生命周期分析（最近 {days} 天）")
    print("=" * 70)

    if not events:
        print("没有数据。可能原因：")
        print("  - server 还没启动 → messages.jsonl 是空的")
        print("  - 时间窗口太短，BTC 星辰这段时间没发消息")
        print("  - 加 --via-export 从 Discord 历史拉取（需 server 在跑）")
        return

    print(f"事件总数: {len(events)}")
    print(f"识别出 {len(lifecycles)} 笔仓位生命周期")
    print(f"  - 已平仓: {len(closed)}")
    print(f"  - 未平仓: {sum(1 for lc in lifecycles if lc.get('still_open'))}")
    print(f"  - 以 'open' 开头: {len(open_starts)}")
    print(f"  - 以 'sync' 开头: {len(sync_starts)}  （bot 重启后接现状）")

    # ── Win rate
    wins = sum(1 for lc in closed if has_close_win(lc))
    losses = sum(1 for lc in closed if has_close_loss(lc))
    win_rate = 100 * wins / max(len(closed), 1)
    total_pnl = sum(lc_pnl(lc) for lc in closed)
    print(f"\n胜率: {wins} 胜 / {losses} 负 / {len(closed)} 总  → {win_rate:.0f}%")
    print(f"已实现盈亏（原交易员视角）: {total_pnl:+,.2f} USDT")

    # ── BIAS WARNING (zero loss data is the most dangerous blind spot)
    if losses == 0 and len(closed) >= 5:
        print(
            "\n⚠️  样本中 0 个止损 — 几乎一定不是真实长期胜率，是窗口效应。"
            "\n    跟单决策时不能把当前胜率当作可靠基线。"
        )
    if len(closed) < 30:
        print(
            f"\n⚠️  样本量小 (n={len(closed)})。统计推论不可靠 — 建议 ≥ 30 笔再看。"
        )

    # ── Add behaviour
    add_counts = [sum(1 for e in lc["events"] if e["kind"] == "add") for lc in closed]
    if add_counts:
        no_add = sum(1 for c in add_counts if c == 0)
        print(
            f"\n加仓次数 avg/max: {sum(add_counts)/len(add_counts):.1f} / {max(add_counts)}"
            f"   ({no_add}/{len(add_counts)} 笔从未加仓 = {100*no_add/len(add_counts):.0f}%)"
        )

    # ── DCA vs breakout add
    add_better = add_worse = 0
    for lc in closed:
        open_ev = next((e for e in lc["events"] if e["kind"] == "open"), None)
        if not (open_ev and open_ev.get("entry") and open_ev.get("side")):
            continue
        entry, side = open_ev["entry"], open_ev["side"]
        for ev in lc["events"]:
            if ev["kind"] != "add" or not ev.get("add_price"):
                continue
            ap = ev["add_price"]
            if (side == "long" and ap < entry) or (side == "short" and ap > entry):
                add_better += 1
            else:
                add_worse += 1
    if add_better + add_worse > 0:
        print(
            f"\n加仓性质: {add_better} 摊低成本 / {add_worse} 突破加码"
            f"  → {'明显偏 DCA' if add_better > add_worse * 1.5 else '明显偏加码' if add_worse > add_better * 1.5 else '基本对半'}"
        )

    # ── sync vs open comparison
    sync_closed = [lc for lc in sync_starts if not lc.get("still_open")]
    open_closed = [lc for lc in open_starts if not lc.get("still_open")]
    if sync_closed:
        sw = sum(1 for lc in sync_closed if has_close_win(lc))
        sp = sum(lc_pnl(lc) for lc in sync_closed)
        print(f"\nsync 开头: {sw}/{len(sync_closed)} 胜  PnL {sp:+,.2f}")
    if open_closed:
        ow = sum(1 for lc in open_closed if has_close_win(lc))
        op_p = sum(lc_pnl(lc) for lc in open_closed)
        print(f"open 开头: {ow}/{len(open_closed)} 胜  PnL {op_p:+,.2f}")

    # ── add vs no-add (only on closed open-starts to control)
    no_add_lcs = [lc for lc in open_closed if not any(e["kind"] == "add" for e in lc["events"])]
    add_lcs = [lc for lc in open_closed if any(e["kind"] == "add" for e in lc["events"])]
    if no_add_lcs or add_lcs:
        print(f"\n加仓 vs 不加仓（已平仓 open 开头）:")
        if no_add_lcs:
            print(
                f"  不加仓: {len(no_add_lcs)} 笔, "
                f"{sum(1 for lc in no_add_lcs if has_close_win(lc))} 胜, "
                f"PnL {sum(lc_pnl(lc) for lc in no_add_lcs):+,.2f}"
            )
        if add_lcs:
            print(
                f"  有加仓: {len(add_lcs)} 笔, "
                f"{sum(1 for lc in add_lcs if has_close_win(lc))} 胜, "
                f"PnL {sum(lc_pnl(lc) for lc in add_lcs):+,.2f}"
            )

    # ── Frequency
    if events:
        first = datetime.fromisoformat(events[0]["ts"].replace("Z", "+00:00"))
        last = datetime.fromisoformat(events[-1]["ts"].replace("Z", "+00:00"))
        span_days = max((last - first).days, 1)
        print(
            f"\n样本时间: {first.date()} ~ {last.date()} ({span_days} 天)"
            f"   开仓频率: {len(open_starts)/span_days:.1f} 次/天"
        )


# ── CLI ────────────────────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--days", type=int, default=30, help="lookback window in days")
    p.add_argument(
        "--channel-id", default=DEFAULT_CHANNEL_ID, help="Discord channel ID"
    )
    p.add_argument(
        "--author-id",
        default=DEFAULT_AUTHOR_ID,
        help="filter by author when reading messages.jsonl",
    )
    p.add_argument(
        "--via-export",
        action="store_true",
        help="fetch messages from running signal server's /api/discord/export",
    )
    p.add_argument(
        "--server", default="http://localhost:3001", help="signal server base URL"
    )
    args = p.parse_args()

    now = datetime.now(timezone.utc)
    since = (now - timedelta(days=args.days)).isoformat()
    until = now.isoformat()

    if args.via_export:
        try:
            msgs = load_via_export(args.server, args.channel_id, since, until)
        except Exception as e:
            print(
                f"export 调用失败 ({e})。回退到离线读 messages.jsonl",
                file=sys.stderr,
            )
            msgs = load_from_jsonl(args.channel_id, args.author_id, since)
    else:
        msgs = load_from_jsonl(args.channel_id, args.author_id, since)

    events = build_events(msgs)
    lifecycles = build_lifecycles(events)
    report(events, lifecycles, args.days)
    return 0


if __name__ == "__main__":
    sys.exit(main())
