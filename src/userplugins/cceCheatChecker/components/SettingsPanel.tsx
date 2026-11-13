/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 anti-cheat-apex contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Margins } from "@components/margins";
import { Paragraph } from "@components/Paragraph";
import { copyWithToast } from "@utils/discord";
import { OptionType } from "@utils/types";
import { React, TextInput, useEffect, useMemo, useState } from "@webpack/common";

import type { GuildTag, GuildTagsMap, ScanProgress, ScanResult } from "../types";
import { downloadTextFile, matchesToCsv, matchesToIdList, matchesToSql, scanResultToJson } from "../utils/export";
import { getSearchQueries, listVisibleGuilds, runCheatCheckScan } from "../utils/scan";

const DS_TAGS = "cceCheatChecker:guildTags";
const DS_LAST = "cceCheatChecker:lastScan";

export const settings = definePluginSettings({
    excludeBots: {
        type: OptionType.BOOLEAN,
        description: "Exclude bot accounts from match results",
        default: true
    },
    safeMode: {
        type: OptionType.BOOLEAN,
        description: "Safe mode (recommended): slower pacing, jitter, fewer searches — lowers ban risk",
        default: true
    },
    requestDelayMs: {
        type: OptionType.NUMBER,
        description: "Delay between Discord requests in ms (Safe mode forces at least 2000)",
        default: 2000
    },
    guildPauseMs: {
        type: OptionType.NUMBER,
        description: "Pause between servers in ms (Safe mode forces at least 5000)",
        default: 5000
    },
    tryListMembersEndpoint: {
        type: OptionType.BOOLEAN,
        description: "Advanced: try bot-style member list endpoint (keep OFF)",
        default: false
    },
    autoHydrateMemberList: {
        type: OptionType.BOOLEAN,
        description: "Auto-load members by simulating member-list scrolling (recommended)",
        default: true
    },
    maxMemberListRanges: {
        type: OptionType.NUMBER,
        description: "Max member-list windows per server (100 members each). Safe mode caps at 40",
        default: 40
    },
    panel: {
        type: OptionType.COMPONENT,
        description: "CCE Cheat Checker panel",
        component: () => <SettingsPanel />
    }
});

const TAG_COLORS: Record<GuildTag, string> = {
    cheat: "var(--status-danger)",
    scrim: "var(--status-positive)",
    ignore: "var(--text-muted)"
};

const TAG_ORDER: GuildTag[] = ["cheat", "scrim", "ignore"];

function TagButton({
    active,
    tag,
    onClick
}: {
    active: boolean;
    tag: GuildTag;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            style={{
                marginRight: 6,
                padding: "2px 8px",
                borderRadius: 4,
                border: active ? `1px solid ${TAG_COLORS[tag]}` : "1px solid var(--background-modifier-accent)",
                background: active ? "var(--background-modifier-selected)" : "var(--background-secondary)",
                color: active ? TAG_COLORS[tag] : "var(--text-normal)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: active ? 700 : 500,
                textTransform: "uppercase"
            }}
        >
            {tag}
        </button>
    );
}

function ProgressBar({ value }: { value: number }) {
    const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
    return (
        <div style={{ height: 8, background: "var(--background-modifier-accent)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: "var(--brand-500)" }} />
        </div>
    );
}

function SettingsPanel() {
    const {
        excludeBots,
        safeMode,
        requestDelayMs,
        guildPauseMs,
        tryListMembersEndpoint,
        autoHydrateMemberList,
        maxMemberListRanges
    } = settings.use([
        "excludeBots",
        "safeMode",
        "requestDelayMs",
        "guildPauseMs",
        "tryListMembersEndpoint",
        "autoHydrateMemberList",
        "maxMemberListRanges"
    ]);

    const [guildTags, setGuildTags] = useState<GuildTagsMap>({});
    const [filter, setFilter] = useState("");
    const [resultFilter, setResultFilter] = useState("");
    const [logs, setLogs] = useState<string[]>([]);
    const [progress, setProgress] = useState<ScanProgress>({
        phase: "idle",
        currentGuildId: null,
        currentGuildName: null,
        guildIndex: 0,
        guildTotal: 0,
        message: "Idle",
        rateLimited: false
    });
    const [result, setResult] = useState<ScanResult | null>(null);
    const [abortController, setAbortController] = useState<AbortController | null>(null);

    const guilds = useMemo(() => listVisibleGuilds(), [guildTags, progress.phase]);

    useEffect(() => {
        void (async () => {
            const tags = await DataStore.get<GuildTagsMap>(DS_TAGS);
            if (tags) setGuildTags(tags);
            const last = await DataStore.get<ScanResult>(DS_LAST);
            if (last) setResult(last);
        })();
    }, []);

    const persistTags = async (next: GuildTagsMap) => {
        setGuildTags(next);
        await DataStore.set(DS_TAGS, next);
    };

    const setTag = (guildId: string, tag: GuildTag) => {
        void persistTags({ ...guildTags, [guildId]: tag });
    };

    const groupedGuilds = useMemo(() => {
        const q = filter.trim().toLowerCase();
        const filtered = guilds.filter(g => {
            if (!q) return true;
            return g.name.toLowerCase().includes(q) || g.id.includes(q);
        });

        const groups: Record<GuildTag, typeof guilds> = {
            cheat: [],
            scrim: [],
            ignore: []
        };

        for (const g of filtered) {
            const tag = guildTags[g.id] ?? "ignore";
            groups[tag].push(g);
        }

        for (const tag of TAG_ORDER) {
            groups[tag].sort((a, b) => a.name.localeCompare(b.name));
        }

        return groups;
    }, [guilds, guildTags, filter]);

    const taggedCounts = useMemo(() => ({
        cheat: Object.values(guildTags).filter(t => t === "cheat").length,
        scrim: Object.values(guildTags).filter(t => t === "scrim").length,
        ignore: guilds.filter(g => (guildTags[g.id] ?? "ignore") === "ignore").length
    }), [guildTags, guilds]);

    const scanning = progress.phase === "scanning" || progress.phase === "dry-run";

    const startScan = async (dryRun: boolean) => {
        if (scanning) return;
        if (taggedCounts.cheat < 1 || taggedCounts.scrim < 1) {
            setLogs(prev => [...prev, "Need at least 1 cheat guild and 1 scrim guild tagged."]);
            return;
        }

        const ac = new AbortController();
        setAbortController(ac);
        setLogs([]);
        setResult(null);

        try {
            const delay = Math.min(60_000, Math.max(500, Number(requestDelayMs) || 2000));
            const pause = Math.min(120_000, Math.max(0, Number(guildPauseMs) || 0));
            const ranges = Math.min(120, Math.max(5, Number(maxMemberListRanges) || 40));
            const scanResult = await runCheatCheckScan(guildTags, {
                dryRun,
                excludeBots,
                requestDelayMs: safeMode ? Math.max(2000, delay) : delay,
                guildPauseMs: safeMode ? Math.max(5000, pause) : pause,
                jitterRatio: safeMode ? 0.4 : 0.15,
                searchQueries: getSearchQueries(safeMode ? "safe" : "aggressive"),
                tryListMembersEndpoint: safeMode ? false : tryListMembersEndpoint,
                autoHydrateMemberList,
                maxMemberListRanges: safeMode ? Math.min(40, ranges) : ranges,
                abortSignal: ac.signal,
                onProgress: setProgress,
                onLog: line => setLogs(prev => [...prev.slice(-400), line])
            });
            setResult(scanResult);
            if (!dryRun) await DataStore.set(DS_LAST, scanResult);
        } catch (err: any) {
            setLogs(prev => [...prev, `Fatal: ${err?.message ?? String(err)}`]);
        } finally {
            setAbortController(null);
        }
    };

    const cancelScan = () => abortController?.abort();

    const matches = result?.matches ?? [];
    const visibleMatches = matches.filter(o => {
        const q = resultFilter.trim().toLowerCase();
        if (!q) return true;
        return (
            o.discordId.includes(q) ||
            o.username.toLowerCase().includes(q) ||
            (o.globalName ?? "").toLowerCase().includes(q) ||
            o.cheatGuilds.some(g => g.name.toLowerCase().includes(q) || g.id.includes(q)) ||
            o.scrimGuilds.some(g => g.name.toLowerCase().includes(q) || g.id.includes(q))
        );
    });

    const progressValue = progress.guildTotal > 0 ? progress.guildIndex / progress.guildTotal : 0;
    const anyIncomplete = result?.guildStatuses.some(s => s.incomplete) ?? false;

    return (
        <div>
            <Heading tag="h3" className={Margins.bottom8}>CCE Cheat Checker</Heading>

            <div
                className={Margins.bottom16}
                style={{
                    padding: 12,
                    borderRadius: 8,
                    border: "1px solid var(--status-danger)",
                    background: "var(--background-secondary)"
                }}
            >
                <Paragraph style={{ color: "var(--status-danger)", fontWeight: 700, marginBottom: 6 }}>
                    Use a dedicated Discord account
                </Paragraph>
                <Paragraph style={{ marginBottom: 6 }}>
                    Do <strong>not</strong> run this on your main account. Frequent scans can get the account
                    banned (Discord forbids automating user accounts). Use a throwaway / scanner-only alt.
                </Paragraph>
                <Paragraph style={{ marginBottom: 0, color: "var(--text-muted)" }}>
                    That alt must already be a member of <strong>CCE UCX</strong> (scrim) and as many
                    cheat / Cronus / Zen servers as possible. The plugin only sees servers you are in.
                </Paragraph>
            </div>

            <Heading tag="h3" className={Margins.bottom8}>Quick start</Heading>
            <Paragraph className={Margins.bottom8}>
                1. Tag <strong>CCE UCX</strong> (and other scrim communities) as <strong>scrim</strong>.{" "}
                2. Tag every cheat / Cronus / Zen server as <strong>cheat</strong>.{" "}
                3. Leave everything else as <strong>ignore</strong>.{" "}
                4. Keep <strong>Safe mode</strong> ON → Dry-run → Scan → export CSV/JSON.
            </Paragraph>
            <Paragraph className={Margins.bottom8} style={{ color: "var(--text-muted)" }}>
                A match = a user found in at least one cheat server and one scrim server (e.g. CCE).
                Huge servers (like CCE) usually only expose online / visible members — treat results as a
                lower bound, not a full census. Scan and export only; no messages, joins, or auto-bans.
            </Paragraph>
            <Paragraph className={Margins.bottom16} style={{ color: "var(--status-warning)" }}>
                <strong>Do not ban from this list blindly.</strong> Matches can include CCE staff /
                moderators who joined cheat servers on their <strong>main</strong> account (research,
                monitoring, etc.). Always verify manually before any action.
            </Paragraph>

            <Heading tag="h3" className={Margins.bottom8}>Server tags</Heading>
            <Paragraph className={Margins.bottom8}>
                {taggedCounts.cheat} cheat · {taggedCounts.scrim} scrim · {taggedCounts.ignore} ignore · {guilds.length} total
                {taggedCounts.cheat < 1 || taggedCounts.scrim < 1
                    ? " — tag at least 1 cheat and 1 scrim before scanning"
                    : ""}
            </Paragraph>
            <TextInput
                value={filter}
                onChange={setFilter}
                placeholder="Filter servers by name or ID"
            />

            <div
                className={Margins.top8}
                style={{
                    maxHeight: 420,
                    overflow: "auto",
                    marginBottom: 16,
                    border: "1px solid var(--background-modifier-accent)",
                    borderRadius: 8,
                    padding: 8
                }}
            >
                {TAG_ORDER.map(sectionTag => {
                    const list = groupedGuilds[sectionTag];
                    if (!list.length) return null;
                    return (
                        <div key={sectionTag} style={{ marginBottom: 10 }}>
                            <div
                                style={{
                                    position: "sticky",
                                    top: 0,
                                    zIndex: 1,
                                    background: "var(--background-secondary)",
                                    color: TAG_COLORS[sectionTag],
                                    fontSize: 11,
                                    fontWeight: 800,
                                    letterSpacing: 0.6,
                                    textTransform: "uppercase",
                                    padding: "6px 4px",
                                    borderBottom: `1px solid ${TAG_COLORS[sectionTag]}`
                                }}
                            >
                                {sectionTag} ({list.length})
                            </div>
                            {list.map(g => {
                                const tag = guildTags[g.id] ?? "ignore";
                                return (
                                    <div
                                        key={g.id}
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "space-between",
                                            gap: 8,
                                            padding: "6px 4px",
                                            borderBottom: "1px solid var(--background-modifier-accent)"
                                        }}
                                    >
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                {g.name}
                                            </div>
                                            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{g.id}</div>
                                        </div>
                                        <div style={{ display: "flex", flexShrink: 0 }}>
                                            {TAG_ORDER.map(t => (
                                                <TagButton key={t} tag={t} active={tag === t} onClick={() => setTag(g.id, t)} />
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    );
                })}
            </div>

            <Heading tag="h3" className={Margins.bottom8}>Scan controls</Heading>
            <Flex className={Margins.bottom8} style={{ gap: 8, flexWrap: "wrap" }}>
                <Button disabled={scanning} onClick={() => void startScan(true)}>Dry-run</Button>
                <Button disabled={scanning} onClick={() => void startScan(false)}>Scan</Button>
                <Button variant="dangerSecondary" disabled={!scanning} onClick={cancelScan}>Cancel</Button>
            </Flex>
            <Paragraph className={Margins.bottom8}>
                {progress.phase.toUpperCase()} — {progress.message}
                {progress.rateLimited ? " · RATE LIMITED" : ""}
                {progress.currentGuildName ? ` · ${progress.currentGuildName}` : ""}
                {progress.guildTotal ? ` · ${progress.guildIndex}/${progress.guildTotal}` : ""}
            </Paragraph>
            <ProgressBar value={progressValue} />

            <Heading tag="h3" className={Margins.top16 + " " + Margins.bottom8}>Logs</Heading>
            <pre
                style={{
                    maxHeight: 160,
                    overflow: "auto",
                    background: "var(--background-secondary)",
                    padding: 8,
                    borderRadius: 8,
                    fontSize: 11,
                    whiteSpace: "pre-wrap"
                }}
            >
                {logs.length ? logs.join("\n") : "No logs yet."}
            </pre>

            <Heading tag="h3" className={Margins.top16 + " " + Margins.bottom8}>
                Results {result ? `(${matches.length} matches)` : ""}
            </Heading>
            {anyIncomplete && (
                <Paragraph className={Margins.bottom8} style={{ color: "var(--status-warning)" }}>
                    Incomplete member list on one or more servers — treat matches as a lower bound, not a full census.
                </Paragraph>
            )}

            {result?.guildStatuses?.length ? (
                <div className={Margins.bottom8} style={{ fontSize: 12 }}>
                    {result.guildStatuses.map(s => (
                        <div key={s.guildId} style={{ marginBottom: 4 }}>
                            [{s.tag}] {s.guildName}: recovered={s.recoveredCount}
                            {s.approximateMemberCount != null ? ` / ~${s.approximateMemberCount}` : ""}
                            {s.incomplete ? " · incomplete" : " · possibly complete"}
                            {s.lastError ? ` · ${s.lastError}` : ""}
                            {" · "}{s.sources.join(", ")}
                        </div>
                    ))}
                </div>
            ) : null}

            <Flex className={Margins.bottom8} style={{ gap: 8, flexWrap: "wrap" }}>
                <Button
                    disabled={!matches.length}
                    onClick={() => copyWithToast(matchesToIdList(matches), "Discord IDs copied")}
                >
                    Copy IDs
                </Button>
                <Button
                    disabled={!matches.length}
                    onClick={() => copyWithToast(matchesToCsv(matches), "CSV copied")}
                >
                    Copy CSV
                </Button>
                <Button
                    disabled={!matches.length}
                    onClick={() => copyWithToast(matchesToSql(matches), "SQL copied — paste into Supabase SQL Editor")}
                >
                    Copy SQL
                </Button>
                <Button
                    variant="secondary"
                    disabled={!result}
                    onClick={() => result && downloadTextFile("cce-cheat-check.json", scanResultToJson(result), "application/json")}
                >
                    Download JSON
                </Button>
                <Button
                    variant="secondary"
                    disabled={!matches.length}
                    onClick={() => downloadTextFile("cce-cheat-check.csv", matchesToCsv(matches), "text/csv")}
                >
                    Download CSV
                </Button>
            </Flex>

            <TextInput
                value={resultFilter}
                onChange={setResultFilter}
                placeholder="Filter results by id / username / guild"
            />

            <div
                className={Margins.top8}
                style={{ maxHeight: 320, overflow: "auto", border: "1px solid var(--background-modifier-accent)", borderRadius: 8 }}
            >
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                        <tr style={{ textAlign: "left", background: "var(--background-secondary)" }}>
                            <th style={{ padding: 6 }}>ID</th>
                            <th style={{ padding: 6 }}>User</th>
                            <th style={{ padding: 6 }}>Cheat (+ roles)</th>
                            <th style={{ padding: 6 }}>Scrim (+ roles)</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visibleMatches.length === 0 ? (
                            <tr>
                                <td colSpan={4} style={{ padding: 8, color: "var(--text-muted)" }}>
                                    No matches yet. Tag servers and run Scan.
                                </td>
                            </tr>
                        ) : visibleMatches.map(o => (
                            <tr key={o.discordId} style={{ borderTop: "1px solid var(--background-modifier-accent)", verticalAlign: "top" }}>
                                <td style={{ padding: 6, fontFamily: "var(--font-code)" }}>{o.discordId}</td>
                                <td style={{ padding: 6 }}>
                                    {o.globalName ? `${o.globalName} (@${o.username})` : o.username}
                                </td>
                                <td style={{ padding: 6 }}>
                                    {o.cheatGuilds.map(g => (
                                        <div key={g.id} style={{ marginBottom: 4 }}>
                                            <div style={{ fontWeight: 600 }}>{g.name}{g.nick ? ` (${g.nick})` : ""}</div>
                                            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                                                {(g.roles?.map(r => r.name).join(", ")) || "(no roles / unknown)"}
                                            </div>
                                        </div>
                                    ))}
                                </td>
                                <td style={{ padding: 6 }}>
                                    {o.scrimGuilds.map(g => (
                                        <div key={g.id} style={{ marginBottom: 4 }}>
                                            <div style={{ fontWeight: 600 }}>{g.name}{g.nick ? ` (${g.nick})` : ""}</div>
                                            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                                                {(g.roles?.map(r => r.name).join(", ")) || "(no roles / unknown)"}
                                            </div>
                                        </div>
                                    ))}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export default SettingsPanel;
