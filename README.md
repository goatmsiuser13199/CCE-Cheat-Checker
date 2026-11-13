# CCE Cheat Checker

[![Download ZIP](https://img.shields.io/badge/Download-ZIP-2ea44f?style=for-the-badge&logo=github)](https://github.com/goatmsiuser13199/CCE-Cheat-Checker/archive/refs/heads/main.zip)

Vencord plugin that finds Discord users present in both **cheat** servers and **scrim** servers (especially **CCE UCX**), then exports IDs / CSV / SQL.

Scan + export only — no bot, no messages, no auto-bans.

---

## Dedicated account (required)

**Do not use your main Discord account.**

Automating a user account can violate [Discord’s self-bot rules](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots) and get the account banned.

Use a **scanner-only alt** that is already in:

1. **CCE UCX** (and any other scrim servers you care about)
2. **As many cheat / Cronus / Zen servers as possible**

Keep **Safe mode** ON. Don’t spam full scans.

---

## Verify before you ban

A match is **not** automatic proof someone should be banned.

**CCE staff / mods** may also be in cheat servers on their **main** account (monitoring, research). Always check roles / staff roster before any action. Never mass-ban from the export alone.

---

## Install (Windows)

Needs **Git** + **Node.js (LTS)** installed once.

1. [Download ZIP](https://github.com/goatmsiuser13199/CCE-Cheat-Checker/archive/refs/heads/main.zip) → unzip
2. Double-click **`Install.bat`**
3. Fully quit Discord (tray too) and reopen it
4. **Settings → Vencord → Plugins → enable CCECheatChecker**

Double-click `Install.bat` again anytime to update.

---

## How to use

1. Log in with the **scanner alt**
2. Tag **CCE UCX** / scrims as **scrim**
3. Tag cheat / Cronus / Zen servers as **cheat**
4. Leave the rest as **ignore**
5. Keep **Safe mode** + **Auto-hydrate** ON
6. **Dry-run** (optional check) → **Scan**
7. Export: **Copy IDs** / **Copy CSV** / **Copy SQL** / Download JSON·CSV

**Copy SQL** is only for **bWRapido** — paste it into the CheatHunter Supabase SQL Editor to add users directly to the database (merge-safe; known scrim servers only: AFT, CCE UCX, DNM, EternalEC, INF, NCE, ProlificGEC, VESA). Everyone else can ignore it and use Copy IDs / CSV.

---

## Limits (reminders)

- On huge servers (CCE), Discord mostly exposes **online / visible** members — treat results as a **lower bound**, not a full roster.
- Member search often returns **403** on user accounts; the plugin continues with cache + member-list scroll.
- Turning off Safe mode increases ban risk.
- `(no roles / unknown)` = that member wasn’t fully loaded in cache for that server.
