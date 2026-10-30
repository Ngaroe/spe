const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { spawn } = require("child_process");
const fetch = require("node-fetch");

const PORT = process.env.PORT || 7000;
const PUBLIC_HOST = process.env.PUBLIC_HOST || `http://127.0.0.1:${PORT}`;

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

        if (totalDurationMs > 0) {
            let posMs = ((nowMs - epochMs) % totalDurationMs + totalDurationMs) % totalDurationMs;
            for (let i = 0; i < items.length; i++) {
                const durMs = durationsMs[i];
                if (posMs < durMs) {
                    const currentItem = items[i];
                    return {
                        title: currentItem.title || currentItem.name || currentItem.video_id || ch.name,
                        mp4Url: resolveArchiveUrl(currentItem),
                        offsetSeconds: Math.floor(posMs / 1000)
                    };
                }
                posMs -= durMs;
            }
        }
    }
    return null;
}

const manifest = {
    id: "org.fisheatduck.spelunkrtv.live",
    version: "5.0.0",
    name: "Spelunkr Cable Network",
    description: "Fully synchronized 24/7 live cable feed remuxed via FFmpeg",
    resources: ["catalog", "meta", "stream"],
    types: ["tv"],
    idPrefixes: ["spelunkr_"],
    catalogs: [{ type: "tv", id: "spelunkr_dial", name: "Spelunkr TV Guide (Live)" }]
};

const builder = new addonBuilder(manifest);

async function buildChannelMeta(ch) {
    const live = await getCurrentBroadcast(ch);
    const nowPlayingLine = live ? `🟢 ON NOW: ${live.title}\n\n` : "";
    const posterText = encodeURIComponent(`CH ${ch.num}\n${ch.name.split("·")[1] ? ch.name.split("·")[1].trim() : ch.slug}`);

    return {
        id: `spelunkr_${ch.slug}`,
        type: "tv",
        name: ch.name,
        genres: [ch.genre],
        description: `${nowPlayingLine}${ch.desc}`,
        poster: `https://placehold.co/600x600/0d0d0d/00ff66/png?text=${posterText}`,
        background: `https://placehold.co/1280x720/080808/00ff66/png?text=${posterText}`,
        posterShape: "square"
    };
}

builder.defineCatalogHandler(async ({ type, id }) => {
    if (type !== "tv" || id !== "spelunkr_dial") return { metas: [] };
    const channels = await getDynamicChannels();
    const metas = await Promise.all(channels.map(ch => buildChannelMeta(ch)));
    return { metas, cacheMaxAge: 60 };
});

builder.defineMetaHandler(async ({ type, id }) => {
    const slug = id.replace("spelunkr_", "");
    const channels = await getDynamicChannels();
    const ch = channels.find(c => c.slug === slug || c.num === slug);
    if (!ch) return { meta: null };
    const meta = await buildChannelMeta(ch);
    return { meta, cacheMaxAge: 30 };
});

builder.defineStreamHandler(async ({ type, id }) => {
    const slug = id.replace("spelunkr_", "");
    const channels = await getDynamicChannels();
    const ch = channels.find(c => c.slug === slug || c.num === slug);
    if (!ch) return { streams: [] };

    const live = await getCurrentBroadcast(ch);
    const streams = [
        {
            name: `📺 CH ${ch.num} LIVE`,
            title: live ? `Live Broadcast: ${live.title}` : `Tune In Live: ${ch.name}`,
            url: `${PUBLIC_HOST}/live/${ch.slug}.ts`,
            behaviorHints: { notWebReady: true }
        }
    ];

    if (live && live.mp4Url) {
        streams.push({
            name: `📼 Rewind Tape`,
            title: `Play Current Tape From 00:00: ${live.title}`,
            url: live.mp4Url
        });
    }

    return { streams, cacheMaxAge: 15 };
});

const app = express();
app.use(getRouter(builder.getInterface()));

// Live FFmpeg streaming proxy route
app.get("/live/:channelSlug.ts", async (req, res) => {
    const channels = await getDynamicChannels();
    const ch = channels.find(c => c.slug === req.params.channelSlug || c.num === req.params.channelSlug);
    if (!ch) return res.status(404).send("Channel not found");

    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

    let clientDisconnected = false;
    let activeFfmpeg = null;

    const cleanup = () => {
        clientDisconnected = true;
        if (activeFfmpeg && !activeFfmpeg.killed) {
            activeFfmpeg.kill("SIGKILL");
        }
    };

    req.on("close", cleanup);
    res.on("close", cleanup);

    while (!clientDisconnected) {
        const live = await getCurrentBroadcast(ch);
        if (!live || !live.mp4Url) {
            res.status(503).end("Could not resolve broadcast stream.");
            break;
        }

        await new Promise((resolve) => {
            const ffmpegArgs = [
                "-reconnect", "1",
                "-reconnect_streamed", "1",
                "-reconnect_delay_max", "5",
                "-ss", String(live.offsetSeconds),
                "-re",
                "-i", live.mp4Url,
                "-c", "copy",
                "-bsf:v", "h264_mp4toannexb",
                "-f", "mpegts",
                "-mpegts_copyts", "1",
                "pipe:1"
            ];

            activeFfmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "ignore"] });
            activeFfmpeg.stdout.pipe(res, { end: false });

            activeFfmpeg.on("close", () => resolve());
            activeFfmpeg.on("error", () => resolve());
        });

        if (!clientDisconnected) {
            await new Promise(r => setTimeout(r, 500));
        }
    }
});

app.listen(PORT, () => {
    console.log(`Spelunkr Live Addon running at ${PUBLIC_HOST}/manifest.json`);
});
