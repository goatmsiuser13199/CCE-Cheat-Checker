/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 anti-cheat-apex contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import {
    ChannelActionCreators,
    FluxDispatcher,
    GuildChannelStore,
    GuildMemberStore
} from "@webpack/common";

import type { ScanOptions } from "../types";

const GatewayConnectionStore = findByPropsLazy("getSocket");

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

function jitter(baseMs: number, ratio: number): number {
    const r = Math.max(0, Math.min(0.9, ratio));
    const d = baseMs * r;
    return Math.max(150, Math.round(baseMs - d + Math.random() * d * 2));
}

function getGatewaySocket(): any | null {
    try {
        const store = GatewayConnectionStore as any;
        const socket =
            store?.getSocket?.() ??
            store?.socket ??
            store?.default?.getSocket?.();
        return socket ?? null;
    } catch {
        return null;
    }
}

function gatewaySend(socket: any, op: number, data: any): boolean {
    try {
        if (typeof socket.send === "function") {
            // Discord GatewaySocket.send(op, data)
            if (socket.send.length >= 2) {
                socket.send(op, data);
                return true;
            }
            socket.send(JSON.stringify({ op, d: data }));
            return true;
        }
        if (typeof socket.sendGateway === "function") {
            socket.sendGateway(op, data);
            return true;
        }
        if (socket.socket?.send) {
            socket.socket.send(JSON.stringify({ op, d: data }));
            return true;
        }
    } catch {
        return false;
    }
    return false;
}

function pickChannelId(guildId: string): string | null {
    try {
        const def = GuildChannelStore.getDefaultChannel?.(guildId);
        if (def?.id) return String(def.id);

        const chans = GuildChannelStore.getChannels?.(guildId) as any;
        const selectable =
            chans?.SELECTABLE ??
            chans?.selectable ??
            chans?.TEXT ??
            chans?.text ??
            [];
        const first = Array.isArray(selectable) ? selectable[0] : selectable?.[0];
        const id = first?.channel?.id ?? first?.id ?? first;
        return id ? String(id) : null;
    } catch {
        return null;
    }
}

function cacheSize(guildId: string): number {
    try {
        return GuildMemberStore.getMemberIds?.(guildId)?.length
            ?? GuildMemberStore.getMembers?.(guildId)?.length
            ?? 0;
    } catch {
        return 0;
    }
}

function buildRanges(cursor: number, windowCount: number): number[][] {
    // Always keep [0,99] subscribed (Discord client behavior)
    const ranges: number[][] = [[0, 99]];
    for (let i = 0; i < windowCount; i++) {
        const start = cursor + i * 100;
        if (start === 0) continue;
        ranges.push([start, start + 99]);
    }
    return ranges;
}

async function waitForMemberListUpdate(
    guildId: string,
    signal: AbortSignal,
    timeoutMs: number
): Promise<boolean> {
    return new Promise(resolve => {
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            cleanup();
            resolve(ok);
        };

        const onUpdate = (e: any) => {
            if (String(e?.guildId ?? e?.guild_id ?? "") === guildId) finish(true);
        };

        const cleanup = () => {
            window.clearTimeout(timer);
            FluxDispatcher.unsubscribe("GUILD_MEMBER_LIST_UPDATE", onUpdate);
            signal.removeEventListener("abort", onAbort);
        };

        const onAbort = () => finish(false);
        const timer = window.setTimeout(() => finish(false), timeoutMs);

        FluxDispatcher.subscribe("GUILD_MEMBER_LIST_UPDATE", onUpdate);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) finish(false);
    });
}

/**
 * Auto-hydrate members the same way Discord does when you scroll the member list:
 * gateway guild subscriptions (OP 14 / OP 37) for successive 100-member ranges.
 *
 * On large guilds this mostly covers online/sidebar-visible members, not the full offline census.
 */
export async function hydrateMemberListSidebar(
    guildId: string,
    options: ScanOptions & { maxRanges: number; }
): Promise<{ rangesSent: number; before: number; after: number; error: string | null; }> {
    const before = cacheSize(guildId);
    const channelId = pickChannelId(guildId);
    if (!channelId) {
        return { rangesSent: 0, before, after: before, error: "no viewable channel" };
    }

    try {
        await ChannelActionCreators.preload?.(guildId, channelId);
    } catch {
        // preload is best-effort
    }

    const socket = getGatewaySocket();
    if (!socket) {
        return { rangesSent: 0, before, after: cacheSize(guildId), error: "gateway socket not found" };
    }

    let rangesSent = 0;
    let stagnant = 0;
    let lastSize = cacheSize(guildId);
    let error: string | null = null;

    // Discord allows a small number of concurrent ranges; mimic scroll windows of 2 (+ always 0-99)
    const windowSize = 2;
    const maxCursor = Math.max(0, (options.maxRanges - 1) * 100);

    for (let cursor = 0; cursor <= maxCursor; cursor += 100 * windowSize) {
        if (options.abortSignal.aborted) break;

        const ranges = buildRanges(cursor, windowSize);
        options.onProgress({
            phase: "scanning",
            currentGuildId: guildId,
            currentGuildName: null,
            guildIndex: 0,
            guildTotal: 0,
            message: `Member list hydrate ranges ${ranges.map(r => r.join("-")).join(", ")}`,
            rateLimited: false
        });

        // Prefer bulk OP 37, fall back to OP 14
        const bulkOk = gatewaySend(socket, 37, {
            subscriptions: {
                [guildId]: {
                    typing: true,
                    threads: false,
                    activities: true,
                    members: [],
                    member_updates: false,
                    channels: { [channelId]: ranges },
                    thread_member_lists: []
                }
            }
        });

        const ok = bulkOk || gatewaySend(socket, 14, {
            guild_id: guildId,
            typing: true,
            threads: false,
            activities: true,
            members: [],
            channels: { [channelId]: ranges }
        });

        if (!ok) {
            error = "gateway send failed";
            break;
        }

        rangesSent += ranges.length;
        await waitForMemberListUpdate(guildId, options.abortSignal, Math.max(1500, options.requestDelayMs * 2));
        await sleep(jitter(options.requestDelayMs, options.jitterRatio), options.abortSignal);

        const size = cacheSize(guildId);
        if (size <= lastSize) {
            stagnant += 1;
            // A few empty windows → likely end of visible member list
            if (stagnant >= 3 && cursor > 0) break;
        } else {
            stagnant = 0;
            lastSize = size;
        }
    }

    return {
        rangesSent,
        before,
        after: cacheSize(guildId),
        error
    };
}
