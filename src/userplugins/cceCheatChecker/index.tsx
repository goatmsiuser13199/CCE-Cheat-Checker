/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 anti-cheat-apex contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

import { settings } from "./components/SettingsPanel";

export default definePlugin({
    name: "CCECheatChecker",
    description: "Find Discord users who appear in both CCE/scrim servers and cheat servers. Uses your logged-in client — use a dedicated alt. Scan/export only; no bot required.",
    authors: [{ name: "anti-cheat-apex", id: 0n }],
    settings,
    tags: ["utility", "moderation", "apex", "cce"]
});
