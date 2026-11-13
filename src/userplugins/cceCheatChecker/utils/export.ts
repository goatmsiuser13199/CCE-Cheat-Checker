/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 anti-cheat-apex contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { GuildRef, MatchRow, ScanResult } from "../types";

function csvEscape(value: string): string {
    let v = value;
    // Prevent spreadsheet formula injection when opening CSV in Excel
    if (/^[=+\-@]/.test(v)) {
        v = `'${v}`;
    }
    if (/[",\n\r]/.test(v)) {
        return `"${v.replaceAll('"', '""')}"`;
    }
    return v;
}

function safeDownloadName(filename: string): string {
    const base = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "export";
    return base.slice(0, 120);
}

function formatRoles(guild: GuildRef): string {
    const roles = guild.roles?.map(r => r.name).filter(Boolean) ?? [];
    return roles.length ? roles.join("|") : "";
}

function guildList(guilds: GuildRef[]): string {
    return guilds.map(g => {
        const roles = formatRoles(g);
        const nick = g.nick ? ` nick=${g.nick}` : "";
        return roles
            ? `${g.name} (${g.id})${nick} roles=[${roles}]`
            : `${g.name} (${g.id})${nick}`;
    }).join("; ");
}

function guildRolesOnly(guilds: GuildRef[]): string {
    return guilds.map(g => {
        const roles = formatRoles(g);
        return `${g.name}: ${roles || "(none)"}`;
    }).join(" || ");
}

export function matchesToIdList(matches: MatchRow[]): string {
    return matches.map(o => o.discordId).join("\n");
}

export function matchesToCsv(matches: MatchRow[]): string {
    const header = "discordId,username,globalName,cheatGuilds,scrimGuilds,cheatRoles,scrimRoles";
    const lines = matches.map(o =>
        [
            o.discordId,
            o.username,
            o.globalName ?? "",
            guildList(o.cheatGuilds),
            guildList(o.scrimGuilds),
            guildRolesOnly(o.cheatGuilds),
            guildRolesOnly(o.scrimGuilds)
        ].map(csvEscape).join(",")
    );
    return [header, ...lines].join("\n");
}

/** Exact `servers.name` values used by CheateHunter / SQL checker */
const KNOWN_SERVER_NAMES = [
    "AFT",
    "CCE UCX",
    "DNM",
    "EternalEC",
    "INF",
    "NCE",
    "ProlificGEC",
    "VESA"
] as const;

type KnownServerName = (typeof KNOWN_SERVER_NAMES)[number];

function mapGuildToKnownServer(guildName: string): KnownServerName | null {
    const n = guildName.trim().toLowerCase();
    if (!n) return null;
    if (n === "cce ucx" || n.startsWith("cce ucx")) return "CCE UCX";
    if (n === "aft" || n.startsWith("aft ")) return "AFT";
    if (n === "dnm" || n.startsWith("dnm ")) return "DNM";
    if (n === "eternalec" || n.startsWith("eternal ec") || n.startsWith("eternalec")) return "EternalEC";
    if (n === "inf" || n.startsWith("inf ")) return "INF";
    if (n === "nce" || n.includes("nightmare collective")) return "NCE";
    if (n === "prolificgec" || n.includes("prolific")) return "ProlificGEC";
    if (n === "vesa" || n.startsWith("vesa ")) return "VESA";
    return null;
}

function knownServersFromMatch(row: MatchRow): KnownServerName[] {
    const out: KnownServerName[] = [];
    for (const g of row.scrimGuilds) {
        const mapped = mapGuildToKnownServer(g.name);
        if (mapped && !out.includes(mapped)) out.push(mapped);
    }
    return out;
}

function hasZenOwnerRole(row: MatchRow): boolean {
    const all = [...row.cheatGuilds, ...row.scrimGuilds];
    return all.some(g =>
        (g.roles ?? []).some(r => r.name.toLowerCase().includes("zen owner"))
    );
}

function sqlEscape(value: string): string {
    return value.replaceAll("'", "''");
}

/**
 * CheateHunter / Supabase SQL Editor seed (merge-safe):
 * creates profile + discord account if missing, links known scrim servers only.
 */
export function matchesToSql(matches: MatchRow[]): string {
    if (!matches.length) return "";

    const blocks: string[] = [];
    matches.forEach((row, i) => {
        const idx = i + 1;
        const handle = row.username || row.discordId;
        const did = row.discordId;
        const account = handle;
        const servers = knownServersFromMatch(row);
        const zen = hasZenOwnerRole(row);
        const srvLabel = servers.length ? servers.join(", ") : "none";
        const display = row.globalName && row.globalName !== handle ? ` / ${row.globalName}` : "";
        const h = sqlEscape(handle);
        const a = sqlEscape(account);

        const lines: string[] = [];
        lines.push(`-- ${idx}) ${handle} (${did})${display} — Servers: ${srvLabel}`);
        lines.push(`WITH existing${idx} AS (`);
        lines.push("  SELECT profile_id AS id");
        lines.push("  FROM public.discord_accounts");
        lines.push(`  WHERE discord_id = '${did}'`);
        lines.push(`), created${idx} AS (`);
        lines.push("  INSERT INTO public.profiles (account_name, status)");
        lines.push(`  SELECT '${a}', 'no_info'`);
        lines.push(`  WHERE NOT EXISTS (SELECT 1 FROM existing${idx})`);
        lines.push("  RETURNING id");
        lines.push(`), p${idx} AS (`);
        lines.push(`  SELECT id FROM existing${idx}`);
        lines.push("  UNION ALL");
        lines.push(`  SELECT id FROM created${idx}`);
        lines.push(`), d${idx} AS (`);
        lines.push("  INSERT INTO public.discord_accounts (profile_id, discord_handle, discord_id)");
        lines.push(`  SELECT p${idx}.id, '${h}', '${did}'`);
        lines.push(`  FROM p${idx}`);
        lines.push("  WHERE NOT EXISTS (");
        lines.push(`    SELECT 1 FROM public.discord_accounts da WHERE da.discord_id = '${did}'`);
        lines.push("  )");

        let letter = "a".charCodeAt(0);
        for (const s of servers) {
            const alias = `ps${idx}${String.fromCharCode(letter)}`;
            lines.push(`), ${alias} AS (`);
            lines.push("  INSERT INTO public.profile_servers (profile_id, server_id)");
            lines.push(`  SELECT p${idx}.id, s.id`);
            lines.push(`  FROM p${idx}`);
            lines.push("  CROSS JOIN public.servers s");
            lines.push(`  WHERE s.name = '${s}'`);
            lines.push("    AND NOT EXISTS (");
            lines.push("      SELECT 1 FROM public.profile_servers ps");
            lines.push(`      WHERE ps.profile_id = p${idx}.id AND ps.server_id = s.id`);
            lines.push("    )");
            letter += 1;
        }

        if (zen) {
            lines.push(`), cm${idx} AS (`);
            lines.push("  INSERT INTO public.cheat_motives (profile_id, motive)");
            lines.push(`  SELECT p${idx}.id, 'Cronus Owner'`);
            lines.push(`  FROM p${idx}`);
            lines.push("  WHERE NOT EXISTS (");
            lines.push("      SELECT 1 FROM public.cheat_motives cm");
            lines.push(`      WHERE cm.profile_id = p${idx}.id AND cm.motive = 'Cronus Owner'`);
            lines.push("    )");
        }

        lines.push(")");
        lines.push("SELECT 1;");
        blocks.push(lines.join("\n"));
    });

    return blocks.join("\n\n");
}

export function scanResultToJson(result: ScanResult): string {
    return JSON.stringify(result, null, 2);
}

export function downloadTextFile(filename: string, content: string, mime = "text/plain"): void {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = safeDownloadName(filename);
    a.rel = "noopener";
    a.click();
    URL.revokeObjectURL(url);
}
