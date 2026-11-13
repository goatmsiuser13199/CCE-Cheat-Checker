# CCE Cheat Checker

Vencord userplugin: tag Discord servers as **cheat** or **scrim**, scan visible members with your logged-in client, and export users who appear on both sides (e.g. CCE + cheat servers).

## Dedicated account

Use a **scanner-only Discord alt**. Do not use your main account.

Frequent scans can trigger rate limits or a ban (Discord forbids automating user accounts). The alt must already be in:

- **CCE UCX** (and any other scrim servers you want)
- **As many cheat / Cronus / Zen / script servers as possible**

If the account is not in a server, that server will not appear in the tag list and cannot be scanned.

## Install

**Easiest:** double-click `Install.bat` at the repo root. See the [root README](../../../README.md#easy-install-windows).

Manual:

1. Clone [Vencord](https://github.com/Vendicated/Vencord) and run `pnpm install`.
2. Copy this folder to `Vencord/src/userplugins/cceCheatChecker`.
3. `pnpm build` then inject into your Discord branch (Stable / PTB / Canary).
4. Restart Discord and enable **CCECheatChecker**.

## Usage

1. Open plugin settings.
2. Tag servers: **cheat** / **scrim** / **ignore**.
3. Keep **Safe mode** ON.
4. **Dry-run** → check the plan.
5. **Scan** → wait for completion.
6. Export: Copy IDs, Copy CSV, **Copy SQL** (merge-safe seed for the SQL checker), Download JSON / CSV.

**Copy SQL** links only known scrim servers (`AFT`, `CCE UCX`, `DNM`, `EternalEC`, `INF`, `NCE`, `ProlificGEC`, `VESA`). Cheat servers are not inserted as `profile_servers`. A **Zen Owner** role adds `cheat_motives` → `Cronus Owner`.

### Verify before you ban

Matches can include **CCE staff** who are also in cheat servers on their **main** account. That is expected and does **not** mean they should be banned. Always cross-check staff / mod roles before any punishment. Never ban from the export list alone.

## Settings

| Setting | Default | Purpose |
|--------|---------|---------|
| `excludeBots` | `true` | Drop bots from matches |
| `safeMode` | `true` | Slower pacing, jitter, fewer searches |
| `requestDelayMs` | `2000` | Base delay between requests (safe ≥ 2000) |
| `guildPauseMs` | `5000` | Pause between servers (safe ≥ 5000) |
| `tryListMembersEndpoint` | `false` | Bot-like list endpoint — keep OFF |
| `autoHydrateMemberList` | `true` | Simulate scrolling the member list |
| `maxMemberListRanges` | `40` | Windows of 100 members (safe caps at 40) |

Tags and the last scan result are stored locally via Vencord `DataStore`.

## How members are loaded

Per tagged server:

1. Local `GuildMemberStore` cache
2. Optional gateway member-list hydration (sidebar scroll simulation)
3. Optional `GET /guilds/:id/members` (usually blocked for users)
4. Optional `GET /guilds/:id/members/search` (often 403 for users)

If recovered count &lt; approximate member count → marked **incomplete**.

## Files

| File | Role |
|------|------|
| `index.tsx` | Plugin definition |
| `components/SettingsPanel.tsx` | Settings UI |
| `utils/scan.ts` | Scan / rate limits / matches |
| `utils/hydrate.ts` | Member-list gateway hydration |
| `utils/export.ts` | CSV / JSON / download |
| `types.ts` | Shared types |

## Manual test checklist

- [ ] Small cheat + scrim pair → matches match a manual spot check
- [ ] Large server → `incomplete` shown, no crash
- [ ] List-members on/off → 403 does not abort the whole scan
- [ ] Rate limit → logged wait, then resume (or fail after max retries)
- [ ] Cancel mid-scan → phase `cancelled`, tags unchanged
- [ ] Re-scan → tags intact, new result OK
- [ ] Exports open correctly; bots excluded when setting is ON
