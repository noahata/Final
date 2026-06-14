const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { HttpsProxyAgent } = require('https-proxy-agent');

if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============ PROXY CONFIGURATION (FIX 410/429 ERRORS) ============
// Free proxies (update these if they stop working)
const FREE_PROXIES = [
    'http://38.154.227.167:80',
    'http://154.205.152.154:8181',
    'http://198.23.239.134:6540',
    'http://20.111.54.16:8123',
    'http://72.10.164.178:55351'
];

let currentProxyIndex = 0;
let proxyAgent = null;

function getProxyAgent() {
    // Use environment proxy if provided
    if (process.env.PROXY_URL) {
        return new HttpsProxyAgent(process.env.PROXY_URL);
    }
    
    // Otherwise use free proxy rotation
    const proxy = FREE_PROXIES[currentProxyIndex % FREE_PROXIES.length];
    console.log(`Using proxy: ${proxy}`);
    return new HttpsProxyAgent(proxy);
}

function rotateProxy() {
    currentProxyIndex++;
    proxyAgent = getProxyAgent();
    console.log(`Rotated to proxy #${currentProxyIndex + 1}`);
}

let lastRequestTime = 0;
let requestCount = 0;
const MAX_REQUESTS_PER_MINUTE = 10;

async function rateLimitedRequest(callback) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    
    if (now - lastRequestTime > 60000) {
        requestCount = 0;
    }
    
    if (requestCount >= MAX_REQUESTS_PER_MINUTE) {
        const waitTime = 60000 - (now - lastRequestTime);
        console.log(`Rate limit waiting ${Math.ceil(waitTime / 1000)} seconds...`);
        await wait(waitTime);
        requestCount = 0;
        rotateProxy(); // Rotate proxy on rate limit
    }
    
    if (timeSinceLastRequest < 5000) {
        await wait(5000 - timeSinceLastRequest);
    }
    
    lastRequestTime = Date.now();
    requestCount++;
    
    return await callback();
}

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('ERROR: BOT_TOKEN not set');
    process.exit(1);
}

const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const TARGET_CHANNEL_HANDLE = '@Tewahdotube-21';
const CLIENT_ID = '635922113777-8c182r05vi5ve32nkqgqc2n5bbldhn18.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04F_QRLOYNyOdCgYIARAAGAQSNwF-L9IrWsT9K73DNxaQfqrmd6fgYUhdeQaFAvSJtB8y3eV6ZA3skvwUfUacaRTr53opx0mrn_k';

const WATERMARK_TEXT = 'Noah_Technical';

let agent = null;
let cookiesLoaded = false;
let cookieString = '';

// Load cookies
if (process.env.YT_COOKIES) {
    try {
        const cookies = JSON.parse(process.env.YT_COOKIES);
        agent = ytdl.createAgent(cookies);
        // Create cookie string for headers
        cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        cookiesLoaded = true;
        console.log('Cookies loaded');
    } catch (e) {
        console.log('Failed to parse cookies:', e.message);
    }
}

if (!agent && fs.existsSync('cookies.json')) {
    try {
        const cookiesJson = fs.readFileSync('cookies.json', 'utf8');
        const cookies = JSON.parse(cookiesJson);
        agent = ytdl.createAgent(cookies);
        cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        cookiesLoaded = true;
        console.log('Cookies loaded from file');
    } catch (e) {
        console.log('Failed to load cookies.json:', e.message);
    }
}

// Initialize proxy
proxyAgent = getProxyAgent();

const API_KEYS = [
    'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg',
    'AIzaSyAXzQXd0AONNgSI8E6D5_BeweMqyz4iGTg',
    'AIzaSyDjLVpU8M9VFBAuj-_pvSyDW1BbUfCjyIY'
];

let currentKey = 0, keyUsage = [0,0,0], keyReset = [Date.now(),Date.now(),Date.now()];
let lastVideoId = null;
let isProcessing = false;
let scheduledCache = null;
let lastCache = 0;
let monitorCount = 0;

let zeroViewVideos = new Map();
let isZeroViewProcessing = false;
const ZERO_VIEW_CHECK_DELAY = 2 * 60 * 60 * 1000;
const REUPLOAD_DELAY = 30;

const TEMP_DIR = path.join(__dirname, 'temp_downloads');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

let activeDownloads = new Map();

const PORT = process.env.PORT || 3000;
const app = express();
app.get('/', (req, res) => res.send('Bot Running'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
let youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

function getApiKey() {
    const now = Date.now();
    for(let i=0; i<API_KEYS.length; i++) {
        if(now - keyReset[i] > 100000) { keyUsage[i] = 0; keyReset[i] = now; }
        if(keyUsage[i] < 50) {
            currentKey = i;
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

async function refreshToken() {
    try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
        console.log('Token refreshed');
    } catch(e) { console.error('Token refresh failed:', e.message); }
}
setInterval(refreshToken, 45 * 60 * 1000);

async function getUploadsPlaylistId(channelId) {
    try {
        const youtube = getYoutube();
        if(!youtube) return null;
        const res = await youtube.channels.list({ part: 'contentDetails', id: channelId });
        if(res.data.items && res.data.items.length > 0) {
            return res.data.items[0].contentDetails.relatedPlaylists.uploads;
        }
        return null;
    } catch(e) {
        return null;
    }
}

async function getYourUploadsPlaylistId() {
    try {
        const res = await youtubeAuth.channels.list({ part: 'contentDetails', id: YOUR_CHANNEL_ID });
        if(res.data.items && res.data.items.length > 0) {
            return res.data.items[0].contentDetails.relatedPlaylists.uploads;
        }
        return null;
    } catch(e) {
        return null;
    }
}

async function getLatestPost() {
    try {
        const youtube = getYoutube();
        if(!youtube) return null;
        const uploadsPlaylistId = await getUploadsPlaylistId(TARGET_CHANNEL_ID);
        if(!uploadsPlaylistId) return null;
        const res = await youtube.playlistItems.list({ part: 'snippet', playlistId: uploadsPlaylistId, maxResults: 1 });
        if(!res.data.items || res.data.items.length === 0) return null;
        const latest = res.data.items[0];
        return {
            id: latest.snippet.resourceId.videoId,
            title: latest.snippet.title,
            url: `https://www.youtube.com/watch?v=${latest.snippet.resourceId.videoId}`
        };
    } catch(e) {
        return null;
    }
}

async function getScheduledShorts(force=false) {
    const now = Date.now();
    if(!force && scheduledCache && (now - lastCache) < 60000) return scheduledCache;
    try {
        const uploadsPlaylistId = await getYourUploadsPlaylistId();
        if(!uploadsPlaylistId) return [];
        const res = await youtubeAuth.playlistItems.list({ part: 'snippet', playlistId: uploadsPlaylistId, maxResults: 50 });
        const scheduled = [];
        for(let i=0; i<(res.data.items||[]).length; i+=10) {
            const batch = res.data.items.slice(i, i+10);
            const videoIds = batch.map(item => item.snippet.resourceId.videoId);
            const videoRes = await youtubeAuth.videos.list({ part: 'status,snippet', id: videoIds.join(',') });
            for(const video of videoRes.data.items||[]) {
                const status = video?.status;
                if(status?.privacyStatus === 'private' && status?.publishAt) {
                    const publishTime = new Date(status.publishAt);
                    if(publishTime > new Date()) {
                        scheduled.push({ id: video.id, title: video.snippet.title, time: publishTime });
                    }
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
        await youtubeAuth.videos.update({ part: 'status', requestBody: { id: id, status: { privacyStatus: 'public' } } });
        console.log(`Published`);
        scheduledCache = null;
        return true;
    } catch(e) { 
        console.error(`Failed:`, e.message);
        return false;
    }
}

async function monitor() {
    if(isProcessing) return;
    isProcessing = true;
    monitorCount++;
    try {
        const latestPost = await getLatestPost();
        if(!latestPost) return;
        
        if(latestPost.id !== lastVideoId && lastVideoId !== null) {
            console.log(`NEW VIDEO DETECTED!`);
            const scheduled = await getScheduledShorts(true);
            if(scheduled.length > 0) {
                await publishVideo(scheduled[0].id, scheduled[0].title);
            }
            lastVideoId = latestPost.id;
        } else if(lastVideoId === null) {
            lastVideoId = latestPost.id;
        }
    } catch(e) { 
        console.error('Monitor error:', e.message);
    } finally { 
        isProcessing = false;
    }
}

async function getPublicCount() {
    try {
        let count = 0, page = null;
        do {
            const res = await youtubeAuth.search.list({ part: 'snippet', channelId: YOUR_CHANNEL_ID, type: 'video', maxResults: 50, pageToken: page });
            const ids = (res.data.items||[]).map(i => i.id.videoId).filter(id=>id);
            if(ids.length) {
                const videos = await youtubeAuth.videos.list({ part: 'status', id: ids.join(',') });
                count += (videos.data.items||[]).filter(v => v?.status?.privacyStatus === 'public').length;
            }
            page = res.data.nextPageToken;
        } while(page);
        return count;
    } catch(e) { return 0; }
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond < 1024) return bytesPerSecond.toFixed(1) + " B/s";
    if (bytesPerSecond < 1024 * 1024) return (bytesPerSecond / 1024).toFixed(1) + " KB/s";
    return (bytesPerSecond / (1024 * 1024)).toFixed(1) + " MB/s";
}

function extractVideoId(url) {
    let cleanUrl = url.split('?')[0];
    cleanUrl = cleanUrl.split('&')[0];
    
    const patterns = [
        /(?:youtube\.com\/watch\?v=)([^&]+)/,
        /(?:youtu\.be\/)([^?]+)/,
        /(?:youtube\.com\/shorts\/)([^?]+)/
    ];
    
    for (const pattern of patterns) {
        const match = cleanUrl.match(pattern);
        if (match) return match[1];
    }
    return null;
}

async function addWatermark(inputPath, outputPath) {
    return new Promise((resolve) => {
        ffmpeg(inputPath)
            .videoFilter(`drawtext=text='${WATERMARK_TEXT}':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.5:boxborderw=5:x=W-tw-10:y=H-th-10`)
            .audioCodec('copy')
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', () => {
                fs.copyFileSync(inputPath, outputPath);
                resolve(outputPath);
            })
            .run();
    });
}

async function safeReply(ctx, text) {
    try {
        return await ctx.reply(text);
    } catch (e) {
        console.log('Reply error:', e.message);
        return await ctx.reply("Error sending message");
    }
}

async function safeEdit(bot, chatId, messageId, text) {
    try {
        return await bot.telegram.editMessageText(chatId, messageId, null, text);
    } catch (e) {
        console.log('Edit error:', e.message);
    }
}

async function getVideoInfoWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await rateLimitedRequest(async () => {
                const options = {
                    agent: proxyAgent,
                    requestOptions: {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Cookie': cookieString
                        }
                    }
                };
                if (agent) options.agent = agent;
                return await ytdl.getInfo(url, options);
            });
        } catch (error) {
            console.log(`Attempt ${i + 1} failed: ${error.message}`);
            
            if (error.statusCode === 429 || error.statusCode === 410 || error.message.includes('429') || error.message.includes('410')) {
                console.log(`Block detected! Rotating proxy...`);
                rotateProxy();
                const waitTime = (i + 1) * 30000;
                console.log(`Waiting ${waitTime / 1000} seconds...`);
                await wait(waitTime);
                continue;
            }
            
            if (i === retries - 1) throw error;
            await wait(5000);
        }
    }
    throw new Error('Failed after retries');
    }
