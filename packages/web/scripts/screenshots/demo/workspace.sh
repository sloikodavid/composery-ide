#!/usr/bin/env bash
# Builds the demo workspace INSIDE a Composery container: a freelancer's business
# an AI agent runs (a morning brief, clients, proposals, and automations - from a
# revenue tracker to a whisper+ffmpeg video pipeline and a lead scraper).
#
#   docker cp screenshots/demo/workspace.sh <container>:/tmp/workspace.sh
#   docker exec -u user <container> bash /tmp/workspace.sh
set -euo pipefail

rm -rf "$HOME/workspace"
mkdir -p "$HOME/workspace"/{brief,clients,proposals,automations,data}
cd "$HOME/workspace"

cat > CLAUDE.md <<'EOF'
# How you work for me

I am a freelancer. You run on my Composery instance at 06:00 every morning,
while my laptop is closed.

## Every morning

1. Run everything in `automations/`.
2. Write one short brief to `brief/YYYY-MM-DD.md`. Lead with what changed.
3. Draft anything that needs a reply. I approve, you send.

## Rules

- Money first, then clients, then everything else.
- Never invent a number. If an automation fails, say that it failed.
- Keep the brief under a screen. I read it on my phone.

## Operating notes

- Work autonomously. Never ask me clarifying questions. If something is
  ambiguous, pick the sensible default and tell me what you picked, in one line.
- Standard library only. Do not add a dependency unless there is no alternative.
- Invoices live in `data/invoices.csv`, subscriptions in `data/subscriptions.csv`.
- Today is 2026-07-13.
EOF

cat > brief/2026-07-13.md <<'EOF'
# Monday, 13 July

**Money** $4,210 invoiced this month. Two payments landed overnight. Acme is
still sitting on $1,800, now six days late.

**Needs you (3)**

- Northwind wants the proposal by Wednesday. The draft is ready in
  `proposals/northwind.md`.
- The Acme invoice is six days overdue. Chase email drafted, waiting on you.
- Figma renews on Thursday, $240 for the year. Cancel or keep?

**Worth knowing**

- Lumen has opened the proposal four times and still has not replied.
- A competitor moved to usage-based pricing on Friday.

**Today** Two calls, both after 14:00. Your morning is clear.
EOF

cat > brief/overnight.md <<'EOF'
# While you slept

Five automations ran. Nothing needs fixing.

- **Acme paid.** The $1,800 landed at 2:14 - the polite chase worked.
- **14 new leads** scored, 3 hot. Intro drafts are waiting in `drafts/`.
- **7 shorts** cut from Monday's stream, queued for your review.
- **Figma renews Thursday**, $240. One word and it's cancelled.

First call at 14:00. Your morning is clear.
EOF

cat > data/invoices.csv <<'EOF'
number,client,amount,issued,due,status
2026-039,Acme,1200.00,2026-05-30,2026-06-16,paid
2026-040,Kestrel,600.00,2026-06-10,2026-06-27,paid
2026-041,Acme,1800.00,2026-06-20,2026-07-07,unpaid
2026-042,Northwind,2400.00,2026-06-28,2026-07-15,unpaid
2026-043,Lumen,950.00,2026-07-01,2026-07-18,unpaid
EOF

cat > data/subscriptions.csv <<'EOF'
name,plan,amount,interval,renews_on
Figma,Professional,240.00,year,2026-07-16
Notion,Plus,96.00,year,2026-07-15
ElevenLabs,Creator,22.00,month,2026-07-17
Vercel,Pro,20.00,month,2026-07-19
Anthropic,Max,100.00,month,2026-08-02
EOF

cat > clients/acme.md <<'EOF'
# Acme

- Contact: Sam Reyes, sam@acme.co
- Retainer: $1,800 a month, invoiced on the 20th
- Started: March 2026

## Notes

Sam pays late but always pays. Chase once, politely, then leave it alone.
EOF

cat > clients/northwind.md <<'EOF'
# Northwind

- Contact: Dana Okafor, dana@northwind.io
- Project: onboarding rebuild, $2,400 fixed
- Proposal due: Wednesday 15 July
EOF

cat > proposals/northwind.md <<'EOF'
# Northwind - onboarding rebuild

**Scope** Rework the path from signup to first value. Three weeks, $2,400 fixed.

1. Audit the current funnel and instrument every drop-off.
2. Rebuild the first-run experience.
3. Hand it over with a dashboard you can read without me.
EOF

cat > automations/revenue.py <<'EOF'
"""What landed, and what is still owed."""
import csv
from datetime import date
from pathlib import Path

INVOICES = Path(__file__).parent.parent / "data" / "invoices.csv"


def check() -> dict:
    """Total invoiced this month, and the amount still outstanding."""
    invoiced = outstanding = 0.0
    today = date.today()

    for row in csv.DictReader(INVOICES.open()):
        issued = date.fromisoformat(row["issued"])
        amount = float(row["amount"])

        if (issued.year, issued.month) == (today.year, today.month):
            invoiced += amount
        if row["status"] == "unpaid":
            outstanding += amount

    return {"invoiced": round(invoiced, 2), "outstanding": round(outstanding, 2)}
EOF

cat > automations/renewals.py <<'EOF'
"""Flag subscriptions renewing soon, so nothing bills me by surprise."""
import csv
from datetime import date, timedelta
from pathlib import Path

SUBSCRIPTIONS = Path(__file__).parent.parent / "data" / "subscriptions.csv"
WINDOW_DAYS = 7


def check(within_days: int = WINDOW_DAYS) -> dict:
    today = date.today()
    horizon = today + timedelta(days=within_days)

    upcoming = [
        row
        for row in csv.DictReader(SUBSCRIPTIONS.open())
        if today <= date.fromisoformat(row["renews_on"]) <= horizon
    ]
    upcoming.sort(key=lambda row: row["renews_on"])

    return {
        "upcoming": upcoming,
        "total_due": round(sum(float(row["amount"]) for row in upcoming), 2),
    }
EOF

cat > automations/inbox.py <<'EOF'
"""Find the mail that actually needs a human, and draft the replies."""
import os
from dataclasses import dataclass

from imapclient import IMAPClient

NEEDS_REPLY = ("?", "can you", "could you", "invoice", "when will")


@dataclass
class Thread:
    sender: str
    subject: str
    body: str


def unanswered() -> list[Thread]:
    with IMAPClient(os.environ["MAIL_HOST"]) as mail:
        mail.login(os.environ["MAIL_USER"], os.environ["MAIL_PASSWORD"])
        mail.select_folder("INBOX")

        out = []
        for _, data in mail.fetch(mail.search(["UNSEEN"]), ["ENVELOPE", "BODY[TEXT]"]).items():
            envelope = data[b"ENVELOPE"]
            body = data[b"BODY[TEXT]"].decode(errors="ignore")

            if any(hint in body.lower() for hint in NEEDS_REPLY):
                out.append(
                    Thread(
                        envelope.from_[0].mailbox.decode(),
                        envelope.subject.decode(),
                        body,
                    )
                )
        return out
EOF

cat > automations/clips.py <<'EOF'
"""Turn one long video into a week of vertical shorts, overnight.

Runs on the server at 02:00. Nothing here needs my laptop to be awake: the
transcription, the scoring and the ffmpeg render all happen on the instance.
"""
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

MEDIA = Path.home() / "media"
CLIPS = MEDIA / "clips"
MIN_SECONDS, MAX_SECONDS = 22, 58


@dataclass
class Moment:
    start: float
    end: float
    hook: str
    score: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def transcribe(video: Path) -> list[dict]:
    """Word-level transcript, straight off the instance's own GPU-less CPU."""
    out = subprocess.run(
        ["whisper-cli", "-m", "models/base.en.bin", "-f", str(video), "-oj"],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)["segments"]


def pick_moments(segments: list[dict], limit: int = 7) -> list[Moment]:
    """Score every window, keep the ones that open with a hook and land a point."""
    moments: list[Moment] = []

    for i, seg in enumerate(segments):
        window = segments[i : i + 12]
        span = window[-1]["end"] - seg["start"]
        if not MIN_SECONDS <= span <= MAX_SECONDS:
            continue

        text = " ".join(s["text"] for s in window)
        score = sum(
            weight
            for phrase, weight in (
                ("here is the thing", 3.0), ("most people", 2.5), ("the mistake", 2.5),
                ("what nobody tells you", 3.0), ("so what i do", 2.0), ("?", 0.4),
            )
            if phrase in text.lower()
        )
        if score:
            moments.append(Moment(seg["start"], window[-1]["end"], text[:80], score))

    moments.sort(key=lambda m: m.score, reverse=True)
    return moments[:limit]


def render(video: Path, moment: Moment, index: int) -> Path:
    """Crop to 9:16, burn captions, hand back something postable."""
    CLIPS.mkdir(parents=True, exist_ok=True)
    out = CLIPS / f"{video.stem}-{index:02d}.mp4"

    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{moment.start:.2f}", "-to", f"{moment.end:.2f}", "-i", str(video),
            "-vf", "crop=ih*9/16:ih,scale=1080:1920,subtitles=captions.srt:force_style='Fontsize=18'",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-c:a", "aac", "-b:a", "160k",
            str(out),
        ],
        check=True,
    )
    return out


def run(video: Path) -> list[Path]:
    moments = pick_moments(transcribe(video))
    return [render(video, moment, i) for i, moment in enumerate(moments, start=1)]
EOF

cat > automations/leads.py <<'EOF'
"""Find people who already have the problem I fix, then score them.

Scrapes on a schedule, enriches, and only ever surfaces the handful worth a
real email. The rest never reach me.
"""
import csv
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx

OUT = Path(__file__).parent.parent / "data" / "leads.csv"
HIRING = re.compile(r"\b(hiring|looking for|need help with)\b", re.I)


@dataclass
class Lead:
    company: str
    site: str
    signal: str
    stack: str
    score: int


def enrich(site: str) -> tuple[str, str]:
    """Read the site once. What they run tells me whether I can actually help."""
    html = httpx.get(site, timeout=10, follow_redirects=True).text

    stack = ",".join(
        name for name, needle in (
            ("next", "/_next/"), ("webflow", "webflow"), ("hubspot", "hs-scripts"),
            ("shopify", "cdn.shopify"), ("wordpress", "wp-content"),
        ) if needle in html
    )
    signal = match.group(0) if (match := HIRING.search(html)) else ""
    return stack, signal


def score(lead: Lead) -> int:
    """Cheap heuristic. It only has to be better than me guessing at 11pm."""
    points = 0
    points += 40 if lead.signal else 0
    points += 30 if "next" in lead.stack else 0
    points += 20 if "hubspot" in lead.stack else 0
    points -= 25 if "webflow" in lead.stack else 0
    return max(0, min(100, points))


def run(companies: dict[str, str]) -> list[Lead]:
    leads = []
    for company, site in companies.items():
        stack, signal = enrich(site)
        lead = Lead(company, site, signal, stack, 0)
        lead.score = score(lead)
        if lead.score >= 50:
            leads.append(lead)

    leads.sort(key=lambda l: l.score, reverse=True)
    with OUT.open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=[f.name for f in Lead.__dataclass_fields__.values()])
        writer.writeheader()
        writer.writerows(asdict(lead) for lead in leads)
    return leads
EOF

# The agent creates drafts/ at runtime; it should not be tracked.
printf '__pycache__\n.env\ndrafts/\n' > .gitignore

git init -q
git config user.email me@example.com
git config user.name "Me"
git add -A
git commit -qm "Morning brief, clients, and automations"
echo "workspace built: $(ls | tr '\n' ' ')"
