/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 anti-cheat-apex contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    FluxDispatcher,
    GuildMemberCountStore,
    GuildMemberStore,
    GuildRoleStore,
    GuildStore,
    RestAPI,
    UserStore
} from "@webpack/common";

import type {
    GuildRef,
    GuildScanStatus,
    GuildTag,
    GuildTagsMap,
    MemberSnapshot,
    MatchRow,
    ScanOptions,
    ScanResult
} from "../types";
import { hydrateMemberListSidebar } from "./hydrate";

/** Full alphabet search — thorough but noisy. */
const AGGRESSIVE_SEARCH_QUERIES = [
    ..."abcdefghijklmnopqrstuvwxyz".split(""),
    ..."0123456789".split(""),
    "_",
    ".",
    "-"
];

/** Safer subset — fewer requests, looks less like bulk scraping. */
const SAFE_SEARCH_QUERIES = [
    ..."abcdefghijklmnopqrstuvwxyz".split("")
];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = window.setTimeout(resolve, ms);
        const onAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function ensureNotAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }
}

function jitteredDelay(baseMs: number, jitterRatio: number): number {
    const ratio = Math.max(0, Math.min(0.9, jitterRatio));
    const delta = baseMs * ratio;
    return Math.max(100, Math.round(baseMs - delta + Math.random() * delta * 2));
}

async function pace(options: ScanOptions, multiplier = 1): Promise<void> {
    await sleep(jitteredDelay(options.requestDelayMs * multiplier, options.jitterRatio), options.abortSignal);
}

const MAX_429_RETRIES = 8;

async function withRetry<T>(
    label: string,
    signal: AbortSignal,
    onLog: (line: string) => void,
    onRateLimited: (active: boolean) => void,
    fn: () => Promise<T>
): Promise<T> {
    let attempt = 0;
    while (true) {
        ensureNotAborted(signal);
        try {
            const result = await fn();
            onRateLimited(false);
            return result;
        } catch (err: any) {
            const status = err?.status ?? err?.body?.status ?? err?.statusCode;
            const retryAfter =
                Number(err?.body?.retry_after ?? err?.headers?.["retry-after"] ?? 0) || 0;

            if (status === 429) {
                attempt += 1;
                if (attempt > MAX_429_RETRIES) {
                    onRateLimited(false);
                    throw new Error(`${label}: too many rate limits (${MAX_429_RETRIES} retries)`);
                }
                const waitMs = Math.max(
                    2500,
                    Math.ceil(retryAfter * 1000) + 1000,
                    2000 * attempt
                );
                onRateLimited(true);
                onLog(`[429] ${label} — waiting ${waitMs}ms (attempt ${attempt}/${MAX_429_RETRIES})`);
                await sleep(waitMs, signal);
                continue;
            }

            throw err;
        }
    }
}

function memberFromUserLike(user: any): MemberSnapshot | null {
    if (!user?.id) return null;
    return {
        userId: String(user.id),
        username: String(user.username ?? ""),
        globalName: user.globalName ?? user.global_name ?? null,
        discriminator: user.discriminator != null ? String(user.discriminator) : null,
        bot: Boolean(user.bot)
    };
}

function readCacheMembers(guildId: string): Map<string, MemberSnapshot> {
    const out = new Map<string, MemberSnapshot>();
    const members = GuildMemberStore.getMembers(guildId) ?? [];

    for (const member of members) {
        const userId = String((member as any).userId ?? (member as any).id ?? "");
        if (!userId) continue;
        const user = UserStore.getUser(userId);
        const snap = memberFromUserLike(user) ?? {
            userId,
            username: userId,
            globalName: null,
            discriminator: null,
            bot: false
        };
        out.set(userId, snap);
    }

    // Fallback via member ids if getMembers is sparse
    const ids = GuildMemberStore.getMemberIds?.(guildId) ?? [];
    for (const id of ids) {
        if (out.has(id)) continue;
        const user = UserStore.getUser(id);
        const snap = memberFromUserLike(user) ?? {
            userId: id,
            username: id,
            globalName: null,
            discriminator: null,
            bot: false
        };
        out.set(id, snap);
    }

    return out;
}

function requestCachedMembers(guildId: string, userIds: string[]): void {
    if (!userIds.length) return;
    // Discord client path used by stock Vencord plugins
    FluxDispatcher.dispatch({
        type: "GUILD_MEMBERS_REQUEST",
        guildIds: [guildId],
        userIds
    });
}

async function tryListMembersPaginated(
    guildId: string,
    into: Map<string, MemberSnapshot>,
    options: ScanOptions
): Promise<{ ok: boolean; error: string | null; pages: number }> {
    if (!options.tryListMembersEndpoint) {
        return { ok: false, error: "disabled", pages: 0 };
    }

    let after = "0";
    let pages = 0;

    try {
        while (true) {
            ensureNotAborted(options.abortSignal);
            const res = await withRetry(
                `GET /guilds/${guildId}/members after=${after}`,
                options.abortSignal,
                options.onLog,
                rateLimited => options.onProgress({
                    phase: "scanning",
                    currentGuildId: guildId,
                    currentGuildName: GuildStore.getGuild(guildId)?.name ?? guildId,
                    guildIndex: 0,
                    guildTotal: 0,
                    message: rateLimited ? "Rate limited on list members" : "Listing members…",
                    rateLimited
                }),
                async () => RestAPI.get({
                    url: `/guilds/${guildId}/members`,
                    query: { limit: 1000, after }
                })
            );

            const body = (res?.body ?? res) as any[];
            if (!Array.isArray(body) || body.length === 0) break;

            pages += 1;
            for (const row of body) {
                const snap = memberFromUserLike(row?.user);
                if (snap) into.set(snap.userId, snap);
            }

            const last = body[body.length - 1];
            const lastId = String(last?.user?.id ?? "");
            if (!lastId || body.length < 1000) break;
            after = lastId;
            await pace(options);
        }
        return { ok: true, error: null, pages };
    } catch (err: any) {
        const status = err?.status ?? err?.body?.status ?? err?.statusCode;
        const msg = status
            ? `list members HTTP ${status}`
            : `list members failed: ${err?.message ?? String(err)}`;
        // Expected for most user accounts (privileged bot endpoint)
        return { ok: false, error: msg, pages };
    }
}

async function hydrateViaMemberSearch(
    guildId: string,
    into: Map<string, MemberSnapshot>,
    options: ScanOptions
): Promise<{ queriesRun: number; error: string | null }> {
    const queries = options.searchQueries.length ? options.searchQueries : SAFE_SEARCH_QUERIES;
    let queriesRun = 0;
    let lastError: string | null = null;

    for (const query of queries) {
        ensureNotAborted(options.abortSignal);
        try {
            const res = await withRetry(
                `GET /guilds/${guildId}/members/search q=${query}`,
                options.abortSignal,
                options.onLog,
                rateLimited => options.onProgress({
                    phase: "scanning",
                    currentGuildId: guildId,
                    currentGuildName: GuildStore.getGuild(guildId)?.name ?? guildId,
                    guildIndex: 0,
                    guildTotal: 0,
                    message: rateLimited
                        ? `Rate limited on search "${query}"`
                        : `Searching members "${query}"…`,
                    rateLimited
                }),
                async () => RestAPI.get({
                    url: `/guilds/${guildId}/members/search`,
                    query: { query, limit: 1000 }
                })
            );

            queriesRun += 1;
            const body = (res?.body ?? res) as any[];
            if (!Array.isArray(body)) continue;

            const missingForRequest: string[] = [];
            for (const row of body) {
                const snap = memberFromUserLike(row?.user);
                if (!snap) continue;
                into.set(snap.userId, snap);
                if (!UserStore.getUser(snap.userId)) missingForRequest.push(snap.userId);
            }
            if (missingForRequest.length) {
                requestCachedMembers(guildId, missingForRequest.slice(0, 100));
            }
        } catch (err: any) {
            const status = err?.status ?? err?.body?.status ?? err?.statusCode;
            lastError = status
                ? `search HTTP ${status}`
                : `search failed: ${err?.message ?? String(err)}`;
            // Missing QUERY_GUILD_MEMBERS / permission — stop burning requests
            if (status === 403 || status === 401) break;
        }

        await pace(options);
    }

    return { queriesRun, error: lastError };
}

function approximateCount(guildId: string): number | null {
    try {
        const n = GuildMemberCountStore.getMemberCount(guildId);
        return typeof n === "number" && n >= 0 ? n : null;
    } catch {
        return null;
    }
}

function resolveMemberRoles(guildId: string, userId: string): { nick: string | null; roles: { id: string; name: string; }[]; } {
    const member = GuildMemberStore.getMember(guildId, userId);
    const nick = member?.nick ?? null;
    const roleIds: string[] = Array.isArray(member?.roles) ? member!.roles.map(String) : [];

    const roles = roleIds
        .filter(id => id !== guildId) // skip @everyone
        .map(id => {
            const role = GuildRoleStore.getRole?.(guildId, id);
            return {
                id,
                name: role?.name ? String(role.name) : id
            };
        })
        // highest position first when available
        .sort((a, b) => {
            const ra = GuildRoleStore.getRole?.(guildId, a.id);
            const rb = GuildRoleStore.getRole?.(guildId, b.id);
            return (rb?.position ?? 0) - (ra?.position ?? 0);
        });

    return { nick, roles };
}

function guildMembership(guildId: string, userId: string): GuildRef {
    const { nick, roles } = resolveMemberRoles(guildId, userId);
    return {
        id: guildId,
        name: GuildStore.getGuild(guildId)?.name ?? guildId,
        nick,
        roles
    };
}

export function listVisibleGuilds(): GuildRef[] {
    const fromMap = GuildStore.getGuilds?.() ?? {};
    let list = Object.values(fromMap) as any[];

    if (!list.length && typeof (GuildStore as any).getGuildIds === "function") {
        const ids: string[] = (GuildStore as any).getGuildIds() ?? [];
        list = ids.map(id => GuildStore.getGuild(id)).filter(Boolean);
    }

    return list
        .map((g: any) => ({ id: String(g.id), name: String(g.name ?? g.id) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function getSearchQueries(mode: "safe" | "aggressive"): string[] {
    return mode === "aggressive" ? [...AGGRESSIVE_SEARCH_QUERIES] : [...SAFE_SEARCH_QUERIES];
}

export async function runCheatCheckScan(
    guildTags: GuildTagsMap,
    options: ScanOptions
): Promise<ScanResult> {
    const logs: string[] = [];
    const log = (line: string) => {
        const stamped = `[${new Date().toISOString()}] ${line}`;
        logs.push(stamped);
        options.onLog(stamped);
    };

    const selfUserId = UserStore.getCurrentUser()?.id ?? null;
    const tagged = Object.entries(guildTags)
        .filter(([, tag]) => tag === "cheat" || tag === "scrim")
        .map(([guildId, tag]) => ({
            guildId,
            tag: tag as Exclude<GuildTag, "ignore">,
            name: GuildStore.getGuild(guildId)?.name ?? guildId
        }));

    options.onProgress({
        phase: options.dryRun ? "dry-run" : "scanning",
        currentGuildId: null,
        currentGuildName: null,
        guildIndex: 0,
        guildTotal: tagged.length,
        message: options.dryRun ? "Dry-run plan" : "Starting scan",
        rateLimited: false
    });

    log(`Tagged guilds: ${tagged.length} (excludeBots=${options.excludeBots}, dryRun=${options.dryRun})`);
    for (const g of tagged) {
        log(`  - [${g.tag}] ${g.name} (${g.guildId})`);
    }

    if (options.dryRun) {
        options.onProgress({
            phase: "done",
            currentGuildId: null,
            currentGuildName: null,
            guildIndex: tagged.length,
            guildTotal: tagged.length,
            message: "Dry-run complete (no network member hydration)",
            rateLimited: false
        });
        return {
            scannedAt: new Date().toISOString(),
            dryRun: true,
            excludeBots: options.excludeBots,
            selfUserId,
            guildStatuses: tagged.map(g => ({
                guildId: g.guildId,
                guildName: g.name,
                tag: g.tag,
                recoveredCount: readCacheMembers(g.guildId).size,
                approximateMemberCount: approximateCount(g.guildId),
                incomplete: true,
                lastError: null,
                sources: ["cache-preview"]
            })),
            matches: [],
            logs
        };
    }

    const cheatMembers = new Map<string, MemberSnapshot>();
    const scrimMembers = new Map<string, MemberSnapshot>();
    const cheatGuildsByUser = new Map<string, GuildRef[]>();
    const scrimGuildsByUser = new Map<string, GuildRef[]>();
    const guildStatuses: GuildScanStatus[] = [];

    try {
        for (let i = 0; i < tagged.length; i++) {
            ensureNotAborted(options.abortSignal);
            const g = tagged[i];
            options.onProgress({
                phase: "scanning",
                currentGuildId: g.guildId,
                currentGuildName: g.name,
                guildIndex: i + 1,
                guildTotal: tagged.length,
                message: `Scanning ${g.name}`,
                rateLimited: false
            });
            log(`Scanning [${g.tag}] ${g.name} (${g.guildId})`);

            const recovered = readCacheMembers(g.guildId);
            const sources = ["cache"];
            let lastError: string | null = null;

            if (options.autoHydrateMemberList) {
                options.onProgress({
                    phase: "scanning",
                    currentGuildId: g.guildId,
                    currentGuildName: g.name,
                    guildIndex: i + 1,
                    guildTotal: tagged.length,
                    message: `Auto-hydrating member list for ${g.name}`,
                    rateLimited: false
                });
                const hydrated = await hydrateMemberListSidebar(g.guildId, {
                    ...options,
                    maxRanges: Math.max(5, options.maxMemberListRanges || 40),
                    onProgress: p => options.onProgress({
                        ...p,
                        guildIndex: i + 1,
                        guildTotal: tagged.length,
                        currentGuildId: g.guildId,
                        currentGuildName: g.name
                    })
                });
                sources.push(`member-list(${hydrated.rangesSent}r,${hydrated.before}->${hydrated.after})`);
                log(`  member-list hydrate ranges=${hydrated.rangesSent} ${hydrated.before}->${hydrated.after}${hydrated.error ? ` (${hydrated.error})` : ""}`);
                if (hydrated.error) {
                    lastError = hydrated.error;
                }
                for (const [id, snap] of readCacheMembers(g.guildId)) {
                    recovered.set(id, snap);
                }
            }

            const listed = await tryListMembersPaginated(g.guildId, recovered, {
                ...options,
                onProgress: p => options.onProgress({
                    ...p,
                    guildIndex: i + 1,
                    guildTotal: tagged.length,
                    currentGuildId: g.guildId,
                    currentGuildName: g.name
                })
            });
            if (listed.ok) {
                sources.push(`list-members(${listed.pages}p)`);
                log(`  list-members ok pages=${listed.pages} size=${recovered.size}`);
            } else if (listed.error && listed.error !== "disabled") {
                lastError = listed.error;
                log(`  list-members skipped: ${listed.error}`);
            }

            const searched = await hydrateViaMemberSearch(g.guildId, recovered, {
                ...options,
                onProgress: p => options.onProgress({
                    ...p,
                    guildIndex: i + 1,
                    guildTotal: tagged.length,
                    currentGuildId: g.guildId,
                    currentGuildName: g.name
                })
            });
            if (searched.queriesRun > 0) {
                sources.push(`member-search(${searched.queriesRun}q)`);
                log(`  member-search queries=${searched.queriesRun} size=${recovered.size}`);
            }
            if (searched.error) {
                lastError = lastError ? `${lastError}; ${searched.error}` : searched.error;
                log(`  member-search note: ${searched.error}`);
            }

            // Re-merge cache after any GUILD_MEMBERS_REQUEST side effects
            for (const [id, snap] of readCacheMembers(g.guildId)) {
                recovered.set(id, snap);
            }

            const approx = approximateCount(g.guildId);
            const incomplete = approx == null
                ? true
                : recovered.size < Math.max(0, approx - 1);

            guildStatuses.push({
                guildId: g.guildId,
                guildName: g.name,
                tag: g.tag,
                recoveredCount: recovered.size,
                approximateMemberCount: approx,
                incomplete,
                lastError,
                sources
            });
            log(`  recovered=${recovered.size} approx=${approx ?? "?"} incomplete=${incomplete}`);

            const targetMap = g.tag === "cheat" ? cheatMembers : scrimMembers;
            const guildMap = g.tag === "cheat" ? cheatGuildsByUser : scrimGuildsByUser;

            for (const [userId, snap] of recovered) {
                if (selfUserId && userId === selfUserId) continue;
                if (options.excludeBots && snap.bot) continue;
                targetMap.set(userId, snap);
                const membership = guildMembership(g.guildId, userId);
                const list = guildMap.get(userId) ?? [];
                const existing = list.findIndex(x => x.id === membership.id);
                if (existing >= 0) list[existing] = membership;
                else list.push(membership);
                guildMap.set(userId, list);
            }

            await pace(options, 1);
            if (options.guildPauseMs > 0 && i < tagged.length - 1) {
                log(`  guild pause ${options.guildPauseMs}ms`);
                await sleep(
                    jitteredDelay(options.guildPauseMs, options.jitterRatio),
                    options.abortSignal
                );
            }
        }

        const matches: MatchRow[] = [];
        for (const [userId, cheatSnap] of cheatMembers) {
            if (!scrimMembers.has(userId)) continue;
            const scrimSnap = scrimMembers.get(userId)!;
            matches.push({
                discordId: userId,
                username: cheatSnap.username || scrimSnap.username,
                globalName: cheatSnap.globalName ?? scrimSnap.globalName,
                discriminator: cheatSnap.discriminator ?? scrimSnap.discriminator,
                cheatGuilds: cheatGuildsByUser.get(userId) ?? [],
                scrimGuilds: scrimGuildsByUser.get(userId) ?? []
            });
        }
        matches.sort((a, b) => a.username.localeCompare(b.username) || a.discordId.localeCompare(b.discordId));

        log(`Match count: ${matches.length}`);
        options.onProgress({
            phase: "done",
            currentGuildId: null,
            currentGuildName: null,
            guildIndex: tagged.length,
            guildTotal: tagged.length,
            message: `Done — ${matches.length} matches`,
            rateLimited: false
        });

        return {
            scannedAt: new Date().toISOString(),
            dryRun: false,
            excludeBots: options.excludeBots,
            selfUserId,
            guildStatuses,
            matches,
            logs
        };
    } catch (err: any) {
        if (err?.name === "AbortError") {
            log("Scan cancelled");
            options.onProgress({
                phase: "cancelled",
                currentGuildId: null,
                currentGuildName: null,
                guildIndex: 0,
                guildTotal: tagged.length,
                message: "Cancelled",
                rateLimited: false
            });
            return {
                scannedAt: new Date().toISOString(),
                dryRun: false,
                excludeBots: options.excludeBots,
                selfUserId,
                guildStatuses,
                matches: [],
                logs
            };
        }

        log(`Scan error: ${err?.message ?? String(err)}`);
        options.onProgress({
            phase: "error",
            currentGuildId: null,
            currentGuildName: null,
            guildIndex: 0,
            guildTotal: tagged.length,
            message: err?.message ?? String(err),
            rateLimited: false
        });
        throw err;
    }
}
