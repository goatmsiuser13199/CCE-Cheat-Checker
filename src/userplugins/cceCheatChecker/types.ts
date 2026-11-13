/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 anti-cheat-apex contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type GuildTag = "scrim" | "cheat" | "ignore";

export type GuildTagsMap = Record<string, GuildTag>;

export interface RoleRef {
    id: string;
    name: string;
}

export interface GuildRef {
    id: string;
    name: string;
    /** Nickname on that server, if any */
    nick?: string | null;
    /** Roles on that server (excluding @everyone) */
    roles?: RoleRef[];
}

export interface MemberSnapshot {
    userId: string;
    username: string;
    globalName: string | null;
    discriminator: string | null;
    bot: boolean;
}

export interface GuildScanStatus {
    guildId: string;
    guildName: string;
    tag: Exclude<GuildTag, "ignore">;
    recoveredCount: number;
    approximateMemberCount: number | null;
    incomplete: boolean;
    lastError: string | null;
    sources: string[];
}

export interface MatchRow {
    discordId: string;
    username: string;
    globalName: string | null;
    discriminator: string | null;
    cheatGuilds: GuildRef[];
    scrimGuilds: GuildRef[];
}

export interface ScanProgress {
    phase: "idle" | "dry-run" | "scanning" | "done" | "cancelled" | "error";
    currentGuildId: string | null;
    currentGuildName: string | null;
    guildIndex: number;
    guildTotal: number;
    message: string;
    rateLimited: boolean;
}

export interface ScanResult {
    scannedAt: string;
    dryRun: boolean;
    excludeBots: boolean;
    selfUserId: string | null;
    guildStatuses: GuildScanStatus[];
    matches: MatchRow[];
    logs: string[];
}

export interface ScanOptions {
    dryRun: boolean;
    excludeBots: boolean;
    /** Base delay between requests (ms). Jitter is applied on top. */
    requestDelayMs: number;
    /** Extra pause between guilds (ms). */
    guildPauseMs: number;
    /** Randomize delays (± percent, e.g. 0.35 = ±35%). */
    jitterRatio: number;
    searchQueries: string[];
    tryListMembersEndpoint: boolean;
    /** Auto-scroll member list via gateway subscriptions (like opening the sidebar). */
    autoHydrateMemberList: boolean;
    /** Max 100-member windows to request per guild (safe ~40, aggressive ~120). */
    maxMemberListRanges: number;
    abortSignal: AbortSignal;
    onProgress: (progress: ScanProgress) => void;
    onLog: (line: string) => void;
}
