#!/usr/bin/env python3
"""
Ghost Nav — Weekly Commute Report Generator
GHOST-REPORT-001

Loads commutes, calls the routing API, compares to last week,
saves history, and renders a Jinja2 HTML report.
"""

import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, date

# Attempt Jinja2 import; graceful error if missing
try:
    from jinja2 import Environment, FileSystemLoader, select_autoescape
except ImportError:
    print("jinja2 not installed. Run: pip3 install jinja2")
    sys.exit(1)

DIR          = os.path.dirname(os.path.abspath(__file__))
DATA_DIR     = os.path.join(DIR, 'data')
REPORTS_DIR  = os.path.join(DIR, 'reports')
TEMPLATES_DIR = os.path.join(DIR, 'templates')
COMMUTES_FILE  = os.path.join(DATA_DIR, 'commutes.json')
HISTORY_FILE   = os.path.join(DATA_DIR, 'weekly_history.json')
API_BASE       = 'http://localhost:8766'
MAX_HISTORY_WEEKS = 8

DEFAULT_COMMUTES = [
    {
        "name": "Summerville to Charleston",
        "start": [33.0185, -80.1762],
        "end":   [32.7765, -79.9311]
    }
]


# ─── Data helpers ──────────────────────────────────────────────────────────────

def load_commutes():
    """Load commutes.json, creating defaults if missing."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(COMMUTES_FILE):
        print(f"[weekly_report] commutes.json not found — creating default at {COMMUTES_FILE}")
        with open(COMMUTES_FILE, 'w', encoding='utf-8') as f:
            json.dump(DEFAULT_COMMUTES, f, indent=2)
        return DEFAULT_COMMUTES
    with open(COMMUTES_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def load_history():
    """Load weekly_history.json, creating empty list if missing."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(HISTORY_FILE):
        return []
    try:
        with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return []


def save_history(history):
    """Persist weekly_history.json, keeping only last MAX_HISTORY_WEEKS weeks."""
    os.makedirs(DATA_DIR, exist_ok=True)
    # Keep the most recent weeks
    trimmed = history[-MAX_HISTORY_WEEKS:] if len(history) > MAX_HISTORY_WEEKS else history
    with open(HISTORY_FILE, 'w', encoding='utf-8') as f:
        json.dump(trimmed, f, indent=2)


# ─── API call ──────────────────────────────────────────────────────────────────

def call_route_api(start, end, mode='both'):
    """
    POST /api/v1/route  → dict with fastest/ghost/cameras_avoided keys.
    Returns None if server is unreachable.
    """
    payload = json.dumps({
        'start': start,
        'end':   end,
        'mode':  mode,
    }).encode('utf-8')
    req = urllib.request.Request(
        f'{API_BASE}/api/v1/route',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        print(f"[weekly_report] API unreachable ({e}) — using stub data")
        return None
    except Exception as e:
        print(f"[weekly_report] API error: {e} — using stub data")
        return None


def stub_route_data(commute_name):
    """Fallback data when server is offline (for offline build/test)."""
    return {
        'fastest':         {'cameras': 5, 'privacy_score': 50},
        'ghost':           {'cameras': 2, 'privacy_score': 80},
        'cameras_avoided': 3,
        '_stub':           True,
    }


# ─── Per-commute stats ─────────────────────────────────────────────────────────

def collect_commute_stats(commute):
    """Call API for one commute and return a normalised stats dict."""
    name  = commute['name']
    start = commute['start']
    end   = commute['end']

    print(f"[weekly_report] Routing: {name}")
    data = call_route_api(start, end, mode='both')

    if data is None:
        data = stub_route_data(name)

    fastest  = data.get('fastest', {})
    ghost    = data.get('ghost', {})

    fastest_cameras = fastest.get('cameras', 0)
    ghost_cameras   = ghost.get('cameras', 0)
    cameras_avoided = data.get('cameras_avoided', max(0, fastest_cameras - ghost_cameras))
    privacy_score   = ghost.get('privacy_score', fastest.get('privacy_score', 50))

    return {
        'name':             name,
        'start':            start,
        'end':              end,
        'fastest_cameras':  fastest_cameras,
        'ghost_cameras':    ghost_cameras,
        'cameras_avoided':  cameras_avoided,
        'privacy_score':    privacy_score,
        'stub':             data.get('_stub', False),
    }


# ─── Trend calculation ─────────────────────────────────────────────────────────

def compute_trends(current_stats_list, history):
    """
    For each commute in current_stats_list, look up last week's entry and
    compute a trend string.
    Returns augmented list with 'trend' key per commute.
    """
    last_week_map = {}
    if history:
        last_entry = history[-1]
        for cs in last_entry.get('commutes', []):
            last_week_map[cs['name']] = cs

    result = []
    for cs in current_stats_list:
        name = cs['name']
        prev = last_week_map.get(name)
        if prev is None:
            trend = "No previous data"
        else:
            delta = cs['fastest_cameras'] - prev.get('fastest_cameras', cs['fastest_cameras'])
            if delta > 0:
                trend = f"+{delta} camera{'s' if delta != 1 else ''} detected"
            elif delta < 0:
                removed = abs(delta)
                trend = f"-{removed} camera{'s' if removed != 1 else ''} removed"
            else:
                trend = "No change"
        result.append({**cs, 'trend': trend})
    return result


# ─── Report rendering ──────────────────────────────────────────────────────────

def render_html(commute_stats, week_label):
    """Render weekly_report.html Jinja2 template."""
    env = Environment(
        loader=FileSystemLoader(TEMPLATES_DIR),
        autoescape=select_autoescape(['html']),
    )
    tmpl = env.get_template('weekly_report.html')
    return tmpl.render(
        week_label=week_label,
        commutes=commute_stats,
        generated_at=datetime.now().strftime('%Y-%m-%d %H:%M'),
    )


# ─── Main entry point ──────────────────────────────────────────────────────────

def generate_weekly_report(filter_name=None):
    """
    Full pipeline:
      1. Load commutes
      2. Call API for each
      3. Load history, compute trends
      4. Save updated history
      5. Render + save HTML
    Returns rendered HTML string.
    """
    os.makedirs(REPORTS_DIR, exist_ok=True)

    commutes = load_commutes()
    if filter_name:
        commutes = [c for c in commutes if c['name'].lower() == filter_name.lower()]
        if not commutes:
            return f"<h1>No commute named '{filter_name}'</h1>"

    today      = date.today()
    week_label = today.strftime('%B %d, %Y')
    week_key   = today.strftime('%Y-W%W')

    # Collect stats for all commutes
    current_stats = [collect_commute_stats(c) for c in commutes]

    # Load history and compute trends
    history = load_history()
    augmented = compute_trends(current_stats, history)

    # Append this week's snapshot
    new_entry = {
        'week':     week_key,
        'date':     today.isoformat(),
        'commutes': current_stats,
    }
    # Replace existing entry for this week if already present
    existing_weeks = [e['week'] for e in history]
    if week_key in existing_weeks:
        history = [e if e['week'] != week_key else new_entry for e in history]
    else:
        history.append(new_entry)

    save_history(history)
    print(f"[weekly_report] History saved ({len(history)} week(s))")

    # Render HTML
    html = render_html(augmented, week_label)

    # Save report file
    report_filename = f"weekly-{today.isoformat()}.html"
    report_path     = os.path.join(REPORTS_DIR, report_filename)
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"[weekly_report] Report saved → {report_path}")

    return html


if __name__ == '__main__':
    html = generate_weekly_report()
    print(f"[weekly_report] Done. {len(html)} bytes of HTML generated.")
