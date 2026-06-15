const Telegraf = require('telegraf');
const google = require('googleapis');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const puppeteer = require('puppeteer');

const BOT_TOKEN = process.env.BOT_TOKEN;
const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const TARGET_CHANNEL_HANDLE = '@Tewahdotube-21';
const CLIENT_ID = '635922113777-8c182r05vi5ve32nkqgqc2n5bbldhn18.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04F_QRLOYNyOdCgYIARAAGAQSNwF-L9IrWsT9K73DNxaQfqrmd6fgYUhdeQaFAvSJtB8y3eV6ZA3skvwUfUacaRTr53opx0mrn_k';

const API_KEYS = [
    'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg',
    'AIzaSyAXzQXd0AONNgSI8E6D5_BeweMqyz4iGTg',
    'AIzaSyDjLVpU8M9VFBAuj-_pvSyDW1BbUfCjyIY'
];

let currentKey = 0;
let keyUsage = [0,0,0];
let keyReset = [Date.now(), Date.now(), Date.now()];
let lastVideoId = null;
let isProcessing = false;
let scheduledCache = null;
let lastCache = 0;
let monitorCount = 0;
let consecutiveErrors = 0;
let publishedVideos = new Map();
let youtubeAuth = null;
let oauth2Client = null;

const PORT = process.env.PORT || 3000;
const app = express();

app.get('/', (req, res) => res.send('YouTube Bot Running'));
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        lastVideoId: lastVideoId,
        monitorCount: monitorCount,
        watching: publishedVideos.size,
        uptime: process.uptime()
    });
});
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

function getApiKey() {
    const now = Date.now();
    for(let i = 0; i < API_KEYS.length; i++) {
        if(now - keyReset[i] > 86400000) {
            keyUsage[i] = 0;
            keyReset[i] = now;
        }
        if(keyUsage[i] < 50) {
            keyUsage[i]++;
            return API_KEYS[i];
        }
    }
    return null;
}

function getYoutube() {
    const key = getApiKey();
    return key ? google.youtube({ version: 'v3', auth: key }) : null;
}

async function initAuth() {
    oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
    console.log('Auth initialized');
}

async function refreshToken() {
    try {
        await oauth2Client.refreshAccessToken();
        console.log('Token refreshed');
    } catch(e) {
        console.error('Token refresh failed:', e.message);
    }
}

async function getUploadsPlaylistId(channelId) {
    try {
        const youtube = getYoutube();
        if(!youtube) return null;
        const res = await youtube.channels.list({ part: 'contentDetails', id: channelId });
        return res.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
    } catch(e) {
        return null;
    }
}

async function getYourUploadsPlaylistId() {
    try {
        const res = await youtubeAuth.channels.list({ part: 'contentDetails', id: YOUR_CHANNEL_ID });
        return res.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
    } catch(e) {
        return null;
    }
}

async function getLatestPost() {
    try {
        const youtube = getYoutube();
        if(!youtube) return null;
        const playlistId = await getUploadsPlaylistId(TARGET_CHANNEL_ID);
        if(!playlistId) return null;
        const res = await youtube.playlistItems.list({ part: 'snippet', playlistId, maxResults: 1 });
        if(!res.data.items?.length) return null;
        const latest = res.data.items[0];
        return {
            id: latest.snippet.resourceId.videoId,
            title: latest.snippet.title,
            publishedAt: latest.snippet.publishedAt,
            url: `https://www.youtube.com/watch?v=${latest.snippet.resourceId.videoId}`
        };
    } catch(e) {
        return null;
    }
}

async function getScheduledShorts(force = false) {
    const now = Date.now();
    if(!force && scheduledCache && (now - lastCache) < 60000) return scheduledCache;
    try {
        const playlistId = await getYourUploadsPlaylistId();
        if(!playlistId) return [];
        const res = await youtubeAuth.playlistItems.list({ part: 'snippet', playlistId, maxResults: 50 });
        const scheduled = [];
        for(let i = 0; i < (res.data.items || []).length; i += 10) {
            const batch = res.data.items.slice(i, i + 10);
            const videoIds = batch.map(item => item.snippet.resourceId.videoId);
            const videoRes = await youtubeAuth.videos.list({ part: 'status,snippet', id: videoIds.join(',') });
            for(const video of videoRes.data.items || []) {
                const status = video?.status;
                if(status?.privacyStatus === 'private' && status?.publishAt && new Date(status.publishAt) > new Date()) {
                    scheduled.push({
                        id: video.id,
                        title: video.snippet.title,
                        time: new Date(status.publishAt)
                    });
                }
            }
        }
        scheduled.sort((a,b) => a.time - b.time);
        scheduledCache = scheduled;
        lastCache = now;
        return scheduled;
    } catch(e) {
        return [];
    }
}

async function publishVideo(id, title) {
    try {
        console.log(`Publishing: ${title}`);
        await youtubeAuth.videos.update({
            part: 'status',
            requestBody: {
                id: id,
                status: { privacyStatus: 'public' }
            }
        });
        console.log(`Published: ${title}`);
        publishedVideos.set(id, {
            publishTime: Date.now(),
            title: title,
            status: 'checking'
        });
        scheduledCache = null;
        return true;
    } catch(e) {
        console.error(`Failed to publish: ${e.message}`);
        return false;
    }
    }
