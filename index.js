const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { spawn } = require("child_process");
const fetch = require("node-fetch");

const PORT = process.env.PORT || 10000;
const PUBLIC_HOST = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;

const DATA_CDN = "https://data.spelunkr.tv";
const SUPABASE_URL = "https://jbuopkuluyfjwgsrigry.supabase.co/rest/v1";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpidW9wa3VsdXlmandnc3JpZ3J5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4MDExNDMsImV4cCI6MjA4NzM3NzE0M30.wMlZLvoXi8G8IOiu2j2H_yoHUBvLVpcHWczizZ0DnIM";

let lineupCache = { data: null, fetchedAt: 0 };
let versionsCache = { data: null, fetchedAt: 0 };
const manifestCache = new Map();

async function getLineup() {
    const now = Date.now();
    if (lineupCache.data && (now - lineupCache.fetchedAt) < 300000) return lineupCache.data;
    try {
        const res = await fetch(`${DATA_CDN}/lineup.json`, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (res.ok) {
            const json = await res.json();
            lineupCache = { data: json, fetchedAt: now };
            return json;
        }
    } catch (e) {}
    return null;
}

async function getScheduleVersions() {
    const now = Date.now();
    if (versionsCache.data && (now - versionsCache.fetchedAt) < 300000) return versionsCache.data;
    try {
        const res = await fetch(`${SUPABASE_URL}/schedule_versions?select=channel_id,version,manifest_path,details_path,epoch_ms`, {
            headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` }
        });
        if (res.ok) {
            const json = await res.json();
            versionsCache = { data: json, fetchedAt: now };
            return json;
        }
    } catch (e) {}
    return null;
}

function resolveArchiveUrl(item) {
    if (!item) return null;
    if (item.url && item.url.startsWith("http")) return item.url;
    const vid = item.video_id || item.path || item.file || item.id;
    if (typeof vid === "string") {
        if (vid.startsWith("http")) return vid;
        if (vid.includes("/")) return `https://archive.org/download/${vid}`;
    }
    return null;
}

async function getDynamicChannels() {
    const lineup = await getLineup();
    const rawChannels = (lineup && lineup.channels) || [];
    return rawChannels.map((c, index) => {
        const numStr = String(c.number || c.num || (index + 1)).padStart(2, "0");
        const slug = c.slug || c.id || `channel-${numStr}`;
        return {
            num: numStr,
            slug: slug,
            name: c.name || `CH ${numStr} · ${slug.toUpperCase()}`,
            genre: c.genre || c.category || "Retro TV",
            desc: c.description || c.desc || "24/7 broadcast channel on Spelunkr."
        };
    });
}

async function getCurrentBroadcast(ch) {
    const nowMs = Date.now();
    const lineup = await getLineup();
    const versions = await getScheduleVersions();

    let channelEntry = null;
    if (lineup && Array.isArray(lineup.channels)) {
        channelEntry = lineup.channels.find(c => c.slug === ch.slug || String(c.number || c.num) === ch.num);
    }

    let versionEntry = null;
    if (Array.isArray(versions)) {
        versionEntry = versions.find(v => v.channel_id === ch.slug || String(v.channel_id) === String(ch.num));
    }

    const manifestPath = (versionEntry && versionEntry.manifest_path) || (channelEntry && channelEntry.manifest_path);
    const epochMs = Number((versionEntry && versionEntry.epoch_ms) || (channelEntry && (channelEntry.epoch_ms || channelEntry.epoch)) || 0);

    let items = (channelEntry && (channelEntry.schedule || channelEntry.items || channelEntry.tapes || channelEntry.playlist)) || null;

    if (!items && manifestPath) {
        const fullUrl = manifestPath.startsWith("http") ? manifestPath : `${DATA_CDN}/${manifestPath.replace(/^\//, "")}`;
        let cached = manifestCache.get(fullUrl);
        if (!cached || (nowMs - cached.fetchedAt) > 600000) {
            try {
                const res = await fetch(fullUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
                if (res.ok) {
                    const data = await res.json();
                    cached = { data, fetchedAt: nowMs };
                    manifestCache.set(fullUrl, cached);
                }
            } catch (e) {}
        }
        if (cached && cached.data) {
            items = Array.isArray(cached.data) ? cached.data : (cached.data.items || cached.data.playlist || cached.data.schedule || cached.data.videos || []);
        }
    }

    if (Array.isArray(items) && items.length > 0) {
        const durationsMs = items.map(it => Number(it.duration_ms || (it.duration_s || it.duration || 0) * 1000));
        const totalDurationMs = durationsMs.reduce((a, b) => a + b, 0);

        if (
