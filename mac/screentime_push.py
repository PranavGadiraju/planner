#!/usr/bin/python3
"""
planner: push Mac screen time (knowledgeC.db) to the Worker.

Runs hourly from a LaunchAgent (mac/com.pranav.planner-screentime.plist) with /usr/bin/python3,
which must have Full Disk Access. Standard library only; Python 3.9 compatible.

What it does, in order:
  1. copies knowledgeC.db (+ -wal + -shm) to a temp dir and opens the copy read-only (URI mode=ro)
  2. reads app intervals for THIS Mac (ZSOURCE.ZDEVICEID IS NULL) in the window
       [max(watermark - 3 h, now - 26 h) floored to the UTC hour, now)
     (hour-aligned so every re-sent hour row is complete; the Worker replaces the window's rows)
     from '/app/inFocus', falling back to '/app/usage' when inFocus coverage is suspiciously low
     (fewer than 25 % of the rows /app/usage gives); logs which stream was used
  3. splits every interval at UTC hour boundaries into per-app seconds (clamped to 3600 per hour),
     ignoring com.apple.loginwindow, screen-saver bundles and com.apple.dock
  4. unions every app interval into focus intervals with a 120 s gap tolerance, drops unions
     shorter than 60 s and records the top app of each union
  5. resolves bundle ids it has not seen before to app names with mdfind
     (cached in ~/.config/planner/app_names.json)
  6. ABORTS without posting when the window yields zero rows
  7. POSTs one JSON body to $PLANNER_URL/api/screentime with the MAC_TOKEN from the login Keychain
     (`security find-generic-password -s planner-mac-token -w`, fallback ~/.config/planner/mac_token)
  8. writes the watermark ~/.config/planner/last_run only after a 2xx
  9. always removes the temp dir

Flags:
  --dry-run            print the payload summary instead of posting (no watermark write)
  --since ISO          override the window start (e.g. 2026-09-27T00:00:00Z); capped at 48 h back
  --print-payload      also print the full JSON body (useful with --dry-run)

Environment:
  PLANNER_URL                 base URL of the Worker, e.g. https://planner.example.workers.dev (required unless --dry-run)
  PLANNER_KNOWLEDGEC_PATH     override the knowledgeC.db path (tests use a fake DB with the real table names)
  PLANNER_CONFIG_DIR          override ~/.config/planner (watermark, app-name cache, token fallback file)
  PLANNER_MAC_TOKEN           override the token lookup (tests / one-off runs); never put it in the plist
"""

import argparse
import datetime as dt
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from typing import Dict, List, Optional, Tuple

APPLE_EPOCH_OFFSET = 978307200  # seconds between 1970-01-01 and 2001-01-01 (Core Data dates)
DEFAULT_DB = os.path.expanduser("~/Library/Application Support/Knowledge/knowledgeC.db")
CONFIG_DIR = os.environ.get("PLANNER_CONFIG_DIR") or os.path.expanduser("~/.config/planner")
WATERMARK_FILE = os.path.join(CONFIG_DIR, "last_run")
NAMES_CACHE_FILE = os.path.join(CONFIG_DIR, "app_names.json")
TOKEN_FILE = os.path.join(CONFIG_DIR, "mac_token")
KEYCHAIN_SERVICE = "planner-mac-token"

LOOKBACK_MAX_S = 26 * 3600      # never look further back than this on a normal run
WATERMARK_OVERLAP_S = 3 * 3600  # re-send this much before the watermark so late-written rows are picked up
SINCE_CAP_S = 48 * 3600         # --since backfills are capped to keep the D1 write budget sane
GAP_TOLERANCE_S = 120           # merge app intervals separated by less than this into one focus interval
MIN_UNION_S = 60                # drop focus intervals shorter than this
INFOCUS_MIN_COVERAGE = 0.25     # fall back to /app/usage when inFocus rows < 25 % of usage rows
NAME_MISS_RETRY_DAYS = 7        # re-run mdfind for unresolved bundle ids after this many days
HTTP_TIMEOUT_S = 30

IGNORED_BUNDLES = {"com.apple.loginwindow", "com.apple.dock"}


def log(msg: str) -> None:
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print("{} {}".format(ts, msg), flush=True)


def iso(ts: float) -> str:
    """Unix seconds -> ISO-8601 UTC with milliseconds, like the Worker writes."""
    d = dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + "{:03d}Z".format(d.microsecond // 1000)


def parse_iso(s: str) -> float:
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    d = dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.timestamp()


def is_ignored(bundle: str) -> bool:
    if bundle in IGNORED_BUNDLES:
        return True
    return "screensaver" in bundle.lower()


# ------------------------------------------------------------------------------------------ window

def read_watermark() -> Optional[float]:
    try:
        with open(WATERMARK_FILE, "r", encoding="utf-8") as f:
            return parse_iso(f.read())
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        log("warning: unreadable watermark {}: {}".format(WATERMARK_FILE, e))
        return None


def write_watermark(ts: float) -> None:
    os.makedirs(CONFIG_DIR, exist_ok=True)
    tmp = WATERMARK_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(iso(ts) + "\n")
    os.replace(tmp, WATERMARK_FILE)


def align_hour(ts: float) -> float:
    """Floor to the UTC hour. The Worker deletes-and-replaces the window's hour rows, so the window must start on
    an hour boundary: a window starting mid-hour would re-send a partial count for that hour and overwrite the
    complete one from the previous run."""
    return ts - (ts % 3600)


def compute_window(now: float, since: Optional[str]) -> Tuple[float, float]:
    if since:
        start = parse_iso(since)
        if now - start > SINCE_CAP_S:
            log("--since is more than 48 h ago; capping the window at 48 h to protect the D1 write budget")
            return align_hour(now - SINCE_CAP_S) + 3600.0, now  # ceil to the next hour: the Worker rejects > 48 h
        return align_hour(start), now
    wm = read_watermark()
    floor = now - LOOKBACK_MAX_S
    if wm is None:
        log("no watermark yet ({}); using the full 26 h window".format(WATERMARK_FILE))
        return align_hour(floor), now
    return align_hour(max(wm - WATERMARK_OVERLAP_S, floor)), now


# ------------------------------------------------------------------------------------------ database

def copy_db(src: str, tmpdir: str) -> str:
    dst = os.path.join(tmpdir, "knowledgeC.db")
    shutil.copy2(src, dst)
    for suffix in ("-wal", "-shm"):
        if os.path.exists(src + suffix):
            shutil.copy2(src + suffix, dst + suffix)
    return dst


ROWS_SQL = """
SELECT ZOBJECT.ZVALUESTRING,
       ZOBJECT.ZSTARTDATE + {off} AS start_unix,
       ZOBJECT.ZENDDATE + {off}   AS end_unix
  FROM ZOBJECT
  LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
 WHERE ZOBJECT.ZSTREAMNAME = ?
   AND ZSOURCE.ZDEVICEID IS NULL
   AND ZOBJECT.ZVALUESTRING IS NOT NULL
   AND ZOBJECT.ZSTARTDATE IS NOT NULL
   AND ZOBJECT.ZSTARTDATE + {off} < ?
   AND (ZOBJECT.ZENDDATE IS NULL OR ZOBJECT.ZENDDATE + {off} > ?)
 ORDER BY ZOBJECT.ZSTARTDATE
""".format(off=APPLE_EPOCH_OFFSET)

COUNT_SQL = """
SELECT COUNT(*)
  FROM ZOBJECT
  LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
 WHERE ZOBJECT.ZSTREAMNAME = ?
   AND ZSOURCE.ZDEVICEID IS NULL
   AND ZOBJECT.ZVALUESTRING IS NOT NULL
   AND ZOBJECT.ZSTARTDATE IS NOT NULL
   AND ZOBJECT.ZSTARTDATE + {off} < ?
   AND (ZOBJECT.ZENDDATE IS NULL OR ZOBJECT.ZENDDATE + {off} > ?)
""".format(off=APPLE_EPOCH_OFFSET)

Interval = Tuple[str, float, float]  # (bundle_id, start_unix, end_unix)


def count_rows(conn: sqlite3.Connection, stream: str, start: float, end: float) -> int:
    row = conn.execute(COUNT_SQL, (stream, end, start)).fetchone()
    return int(row[0]) if row else 0


def read_intervals(conn: sqlite3.Connection, stream: str, start: float, end: float) -> List[Interval]:
    out: List[Interval] = []
    for bundle, s, e in conn.execute(ROWS_SQL, (stream, end, start)):
        if not bundle or is_ignored(bundle):
            continue
        s = float(s)
        e = float(e) if e is not None else end  # open row = app still in front
        s = max(s, start)
        e = min(e, end)
        if e <= s:
            continue
        out.append((bundle, s, e))
    return out


def choose_stream(conn: sqlite3.Connection, start: float, end: float) -> Tuple[str, int]:
    infocus = count_rows(conn, "/app/inFocus", start, end)
    usage = count_rows(conn, "/app/usage", start, end)
    if usage == 0 and infocus == 0:
        return "/app/inFocus", 0
    if infocus < INFOCUS_MIN_COVERAGE * usage:
        log("stream: /app/inFocus has {} rows vs {} in /app/usage (< 25 %) -> using /app/usage".format(infocus, usage))
        return "/app/usage", usage
    log("stream: using /app/inFocus ({} rows; /app/usage has {})".format(infocus, usage))
    return "/app/inFocus", infocus


# ------------------------------------------------------------------------------------------ aggregation

def split_hours(intervals: List[Interval]) -> Dict[Tuple[str, str], float]:
    """Seconds per (hour_start ISO, bundle), split at UTC hour boundaries."""
    acc: Dict[Tuple[str, str], float] = {}
    for bundle, s, e in intervals:
        cur = s
        while cur < e:
            hour_start = cur - (cur % 3600)
            hour_end = hour_start + 3600
            seg_end = min(e, hour_end)
            key = (iso(hour_start), bundle)
            acc[key] = acc.get(key, 0.0) + (seg_end - cur)
            cur = seg_end
    return acc


def hours_payload(acc: Dict[Tuple[str, str], float]) -> List[dict]:
    rows = []
    for (hour_start, bundle), secs in sorted(acc.items()):
        n = int(round(secs))
        if n <= 0:
            continue
        rows.append({"hour_start": hour_start, "app_id": bundle, "seconds": min(3600, n)})
    return rows


def focus_intervals(intervals: List[Interval]) -> List[dict]:
    """Union of all app intervals with a gap tolerance; each union carries the app with the most seconds."""
    if not intervals:
        return []
    ordered = sorted(intervals, key=lambda x: (x[1], x[2]))
    unions: List[dict] = []
    cur_s, cur_e = ordered[0][1], ordered[0][2]
    per_app: Dict[str, float] = {ordered[0][0]: ordered[0][2] - ordered[0][1]}

    def flush() -> None:
        if cur_e - cur_s >= MIN_UNION_S:
            top = max(per_app.items(), key=lambda kv: kv[1])[0]
            unions.append({"start": iso(cur_s), "end": iso(cur_e), "top_app": top})

    for bundle, s, e in ordered[1:]:
        if s <= cur_e + GAP_TOLERANCE_S:
            cur_e = max(cur_e, e)
            per_app[bundle] = per_app.get(bundle, 0.0) + (e - s)
        else:
            flush()
            cur_s, cur_e = s, e
            per_app = {bundle: e - s}
    flush()
    return unions


# ------------------------------------------------------------------------------------------ app names

def load_names_cache() -> Dict[str, dict]:
    try:
        with open(NAMES_CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        log("warning: unreadable {}: {} (starting a fresh cache)".format(NAMES_CACHE_FILE, e))
        return {}


def save_names_cache(cache: Dict[str, dict]) -> None:
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        tmp = NAMES_CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=1, sort_keys=True)
        os.replace(tmp, NAMES_CACHE_FILE)
    except OSError as e:
        log("warning: could not write {}: {}".format(NAMES_CACHE_FILE, e))


def mdfind_name(bundle: str) -> Optional[str]:
    try:
        out = subprocess.run(
            ["mdfind", "kMDItemCFBundleIdentifier == '{}'".format(bundle.replace("'", ""))],
            capture_output=True, text=True, timeout=10, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        line = line.strip()
        if line.endswith(".app"):
            return os.path.basename(line)[:-4]
    return None


def resolve_names(bundles: List[str], now: float) -> Tuple[List[dict], int]:
    cache = load_names_cache()
    changed = False
    resolved = 0
    for b in sorted(set(bundles)):
        entry = cache.get(b)
        if isinstance(entry, dict) and entry.get("label"):
            continue
        if isinstance(entry, dict) and entry.get("checked_at"):
            try:
                if now - parse_iso(entry["checked_at"]) < NAME_MISS_RETRY_DAYS * 86400:
                    continue
            except ValueError:
                pass
        label = mdfind_name(b)
        cache[b] = {"label": label, "checked_at": iso(now)}
        changed = True
        if label:
            resolved += 1
    if changed:
        save_names_cache(cache)
    apps = []
    for b in sorted(set(bundles)):
        entry = cache.get(b) or {}
        apps.append({"app_id": b, "label": entry.get("label")})
    return apps, resolved


# ------------------------------------------------------------------------------------------ token + post

def read_token() -> Optional[str]:
    env = os.environ.get("PLANNER_MAC_TOKEN")
    if env and env.strip():
        return env.strip()
    try:
        r = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True, timeout=30, check=False,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except (OSError, subprocess.SubprocessError) as e:
        log("warning: keychain lookup failed: {}".format(e))
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            t = f.read().strip()
            if t:
                return t
    except OSError:
        pass
    return None


def api_url() -> Optional[str]:
    base = os.environ.get("PLANNER_URL", "").strip().rstrip("/")
    if not base:
        return None
    if base.endswith("/api/screentime"):
        return base
    return base + "/api/screentime"


def post(url: str, token: str, payload: dict) -> Tuple[int, str]:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token,
                 "User-Agent": "planner-screentime-push/1"},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            return resp.status, resp.read(2000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(2000).decode("utf-8", "replace")


# ------------------------------------------------------------------------------------------ main

def summarize(payload: dict, stream: str, row_count: int) -> None:
    hours = payload["hours"]
    total = sum(h["seconds"] for h in hours)
    per_app: Dict[str, int] = {}
    for h in hours:
        per_app[h["app_id"]] = per_app.get(h["app_id"], 0) + h["seconds"]
    top = sorted(per_app.items(), key=lambda kv: -kv[1])[:8]
    hour_set = sorted({h["hour_start"] for h in hours})
    log("summary: device={} stream={} rows={} window={} -> {}".format(
        payload["device"], stream, row_count, payload["window"]["from"], payload["window"]["to"]))
    log("summary: {} hour rows over {} hours, {} intervals, {} apps, {} min total".format(
        len(hours), len(hour_set), len(payload["intervals"]), len(payload["apps"]), total // 60))
    labels = {a["app_id"]: a.get("label") for a in payload["apps"]}
    for app, secs in top:
        name = labels.get(app) or "?"
        log("summary:   {:>6} min  {}  ({})".format(secs // 60, app, name))
    for iv in payload["intervals"][:5]:
        log("summary:   interval {} -> {}  top {}".format(iv["start"], iv["end"], iv["top_app"]))
    if len(payload["intervals"]) > 5:
        log("summary:   ... {} more intervals".format(len(payload["intervals"]) - 5))


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description="Push Mac screen time from knowledgeC.db to the planner Worker.")
    ap.add_argument("--dry-run", action="store_true", help="print the payload summary instead of posting")
    ap.add_argument("--since", metavar="ISO", help="override the window start (capped at 48 h back)")
    ap.add_argument("--print-payload", action="store_true", help="also print the full JSON payload")
    args = ap.parse_args(argv)

    now = dt.datetime.now(dt.timezone.utc).timestamp()
    now = float(int(now))  # whole seconds
    src = os.environ.get("PLANNER_KNOWLEDGEC_PATH") or DEFAULT_DB
    start, end = compute_window(now, args.since)
    log("window {} -> {} ({:.1f} h) from {}".format(iso(start), iso(end), (end - start) / 3600, src))

    if not os.path.exists(src):
        log("error: {} does not exist".format(src))
        return 1

    tmpdir = tempfile.mkdtemp(prefix="planner-knowledgec-")
    try:
        try:
            db_copy = copy_db(src, tmpdir)
        except PermissionError as e:
            log("error: cannot read knowledgeC.db ({}). Grant Full Disk Access to {} "
                "(System Settings > Privacy & Security > Full Disk Access; drag the binary into the list) "
                "and re-run.".format(e, sys.executable))
            return 1
        conn = sqlite3.connect("file:{}?mode=ro".format(db_copy), uri=True)
        try:
            stream, row_count = choose_stream(conn, start, end)
            if row_count == 0:
                log("no rows in the window from either stream; nothing to send (aborting without posting)")
                return 0
            intervals = read_intervals(conn, stream, start, end)
        finally:
            conn.close()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if not intervals:
        log("rows exist but none survive filtering/clamping; nothing to send")
        return 0

    acc = split_hours(intervals)
    hours = hours_payload(acc)
    if not hours:
        log("zero hour rows after aggregation; nothing to send")
        return 0
    ivs = focus_intervals(intervals)
    apps, resolved = resolve_names([h["app_id"] for h in hours], now)
    if resolved:
        log("resolved {} new app name(s) with mdfind".format(resolved))

    payload = {
        "source": "mac",
        "device": socket.gethostname().split(".")[0] or "mac",
        "window": {"from": iso(start), "to": iso(end)},
        "hours": hours,
        "intervals": ivs,
        "apps": apps,
    }
    summarize(payload, stream, row_count)
    if args.print_payload:
        print(json.dumps(payload, indent=1))

    if args.dry_run:
        log("dry run: not posting, watermark untouched")
        return 0

    url = api_url()
    if not url:
        log("error: PLANNER_URL is not set (e.g. https://planner.example.workers.dev)")
        return 1
    token = read_token()
    if not token:
        log("error: no token. Store it with: security add-generic-password -U -a \"$USER\" -s {} -w   "
            "(or write it to {})".format(KEYCHAIN_SERVICE, TOKEN_FILE))
        return 1

    try:
        status, text = post(url, token, payload)
    except (urllib.error.URLError, OSError, ValueError) as e:
        log("error: POST {} failed: {}".format(url, e))
        return 1
    if 200 <= status < 300:
        write_watermark(end)
        log("ok: POST {} -> {} ({} hour rows, {} intervals); watermark {}".format(
            url, status, len(hours), len(ivs), iso(end)))
        return 0
    log("error: POST {} -> {}: {}".format(url, status, text.strip()[:300]))
    log("watermark not advanced; the next run re-sends this window")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
