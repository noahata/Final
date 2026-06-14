const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// Set ffmpeg path
if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
}

// ============ ANTI-429: Add delays between requests ============
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Track request count and last request time
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
        console.log(`Rate limit approaching, waiting ${Math.ceil(waitTime / 1000)} seconds...`);
        await wait(waitTime);
        requestCount = 0;
    }
    
    if (timeSinceLastRequest < 5000) {
        await wait(5000 - timeSinceLastRequest);
    }
    
    lastRequestTime = Date.now();
    requestCount++;
    
    return await callback();
}

// ============ CHECK BOT TOKEN ============
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('ERROR: BOT_TOKEN environment variable is not set!');
    process.exit(1);
}

// ============ CREDENTIALS ============
const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const TARGET_CHANNEL_HANDLE = '@Tewahdotube-21';
const CLIENT_ID = '635922113777-8c182r05vi5ve32nkqgqc2n5bbldhn18.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04F_QRLOYNyOdCgYIARAAGAQSNwF-L9IrWsT9K73DNxaQfqrmd6fgYUhdeQaFAvSJtB8y3eV6ZA3skvwUfUacaRTr53opx0mrn_k';

// ============ WATERMARK SETTINGS ============
const WATERMARK_TEXT = 'Noah_Technical';
const WATERMARK_POSITION = 'bottom-right';
const WATERMARK_FONT_SIZE = 24;
const WATERMARK_COLOR = 'white';

// ============ LOAD COOKIES ============
let agent = null;
let cookiesLoaded = false;

if (process.env.YT_COOKIES) {
    try {
        const cookies = JSON.parse(process.env.YT_COOKIES);
        agent = ytdl.createAgent(cookies);
        cookiesLoaded = true;
        console.log('✅ Cookies loaded from environment variable!');
    } catch (e) {
        console.log('⚠️ Failed to parse YT_COOKIES env var:', e.message);
    }
}

if (!agent && fs.existsSync('cookies.json')) {
    try {
        const cookiesJson = fs.readFileSync('cookies.json', 'utf8');
        const cookies = JSON.parse(cookiesJson);
        agent = ytdl.createAgent(cookies);
        cookiesLoaded = true;
        console.log('✅ Cookies loaded from cookies.json file!');
    } catch (e) {
        console.log('⚠️ Failed to load cookies.json:', e.message);
    }
}

if (!agent) {
    console.log('⚠️ No cookies loaded. You may get 410 errors.');
}

// ============ API KEYS ============
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
    console.log('📁 Created temp directory');
}

let activeDownloads = new Map();

const PORT = process.env.PORT || 3000;
const app = express();
app.get('/', (req, res) => res.send('Bot Running'));
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// Setup OAuth
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
        console.log('✅ Token refreshed');
    } catch(e) { console.error('❌ Token refresh failed:', e.message); }
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
        console.log(`📤 Publishing: ${title}`);
        await youtubeAuth.videos.update({ part: 'status', requestBody: { id: id, status: { privacyStatus: 'public' } } });
        console.log(`✅ Published`);
        scheduledCache = null;
        return true;
    } catch(e) { 
        console.error(`❌ Failed:`, e.message);
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
            console.log(`🎬 NEW VIDEO DETECTED!`);
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
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(1)} B/s`;
    if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
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
// ============ DOWNLOAD AND SCHEDULE WITH RATE LIMIT HANDLING ============

async function getVideoInfoWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await rateLimitedRequest(async () => {
                const options = {};
                if (agent) options.agent = agent;
                return await ytdl.getInfo(url, options);
            });
        } catch (error) {
            console.log(`Attempt ${i + 1} failed: ${error.message}`);
            
            if (error.statusCode === 429 || error.message.includes('429')) {
                const waitTime = (i + 1) * 30000;
                console.log(`Rate limited! Waiting ${waitTime / 1000} seconds...`);
                await wait(waitTime);
                continue;
            }
            
            if (i === retries - 1) throw error;
            await wait(5000);
        }
    }
    throw new Error('Failed after retries');
}

async function downloadWithRetry(url, format, streamOptions, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await new Promise((resolve, reject) => {
                const stream = ytdl(url, { ...streamOptions, format: format });
                let errorHandler = (err) => reject(err);
                stream.on('error', errorHandler);
                resolve(stream);
            });
        } catch (error) {
            console.log(`Download attempt ${i + 1} failed: ${error.message}`);
            if (error.message.includes('429')) {
                await wait((i + 1) * 45000);
                continue;
            }
            if (i === retries - 1) throw error;
            await wait(10000);
        }
    }
    throw new Error('Download failed after retries');
}

async function downloadAndSchedule(url, chatId, messageId) {
    return new Promise(async (resolve, reject) => {
        const videoId = extractVideoId(url);
        if (!videoId) {
            reject(new Error('Invalid YouTube URL'));
            return;
        }
        
        try {
            await safeEdit(bot, chatId, messageId, `📡 Getting video information...\n⏳ Please wait...`);
            
            const info = await getVideoInfoWithRetry(url);
            const videoTitle = info.videoDetails.title;
            const timestamp = Date.now();
            const tempPath = path.join(TEMP_DIR, `${videoId}_${timestamp}_temp.mp4`);
            const watermarkedPath = path.join(TEMP_DIR, `${videoId}_${timestamp}_wm.mp4`);
            
            const format = ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' });
            if (!format) throw new Error('No video format found');
            
            const totalSize = parseInt(format.contentLength) || 0;
            const startTime = Date.now();
            let lastUpdate = 0;
            
            await safeEdit(bot, chatId, messageId, `📹 Found: ${videoTitle.substring(0, 50)}\n\n📥 Downloading...`);
            
            const streamOptions = {};
            if (agent) streamOptions.agent = agent;
            
            const writeStream = fs.createWriteStream(tempPath);
            const downloadStream = await downloadWithRetry(url, format, streamOptions);
            
            downloadStream.on('progress', async (chunk, downloaded, total) => {
                const now = Date.now();
                if (now - lastUpdate > 3000 && total) {
                    lastUpdate = now;
                    const percent = (downloaded / total) * 100;
                    const elapsed = (now - startTime) / 1000;
                    const speed = downloaded / elapsed;
                    const remaining = (total - downloaded) / speed;
                    const barLength = 20;
                    const filled = Math.floor(percent / 5);
                    const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
                    
                    await safeEdit(bot, chatId, messageId,
                        `📥 Downloading...\n\n[${bar}] ${percent.toFixed(1)}%\n\n` +
                        `📦 ${formatFileSize(downloaded)} / ${formatFileSize(total)}\n` +
                        `⚡ ${formatSpeed(speed)}\n` +
                        `⏱️ ${Math.ceil(remaining)}s left`
                    );
                }
            });
            
            downloadStream.pipe(writeStream);
            
            writeStream.on('finish', async () => {
                await safeEdit(bot, chatId, messageId, `✅ Downloaded!\n\n🎨 Adding watermark...`);
                await addWatermark(tempPath, watermarkedPath);
                fs.unlinkSync(tempPath);
                
                const scheduleDate = new Date();
                scheduleDate.setDate(scheduleDate.getDate() + 7);
                
                await safeEdit(bot, chatId, messageId, `📤 Uploading to YouTube...\n📅 Scheduled for: ${scheduleDate.toLocaleString()}`);
                
                const response = await youtubeAuth.videos.insert({
                    part: 'snippet,status',
                    requestBody: {
                        snippet: {
                            title: `[SCHEDULED] ${videoTitle.substring(0, 80)}`,
                            description: `Scheduled via Bot\nWatermark: ${WATERMARK_TEXT}\nDate: ${scheduleDate.toLocaleString()}`,
                            categoryId: '22'
                        },
                        status: {
                            privacyStatus: 'private',
                            publishAt: scheduleDate.toISOString(),
                            selfDeclaredMadeForKids: false
                        }
                    },
                    media: { body: fs.createReadStream(watermarkedPath), mimeType: 'video/mp4' }
                });
                
                fs.unlinkSync(watermarkedPath);
                scheduledCache = null;
                
                resolve({ videoId: response.data.id, scheduleDate, title: videoTitle });
            });
            
            writeStream.on('error', reject);
            downloadStream.on('error', reject);
            
        } catch (error) {
            console.error('Download error:', error.message);
            
            if (error.message.includes('429')) {
                reject(new Error(`RATE LIMIT EXCEEDED (429)\n\nYouTube is temporarily blocking requests.\n\nPlease wait 30-60 minutes and try again.`));
            } else if (error.message.includes('410')) {
                reject(new Error(`VIDEO NOT AVAILABLE (410)\n\nThe video may be deleted or private.\n\nTry a different video.`));
            } else {
                reject(error);
            }
        }
    });
}

// ============ ZERO VIEWS FUNCTION ============

async function getPublicVideos() {
    try {
        let videos = [], page = null;
        do {
            const res = await youtubeAuth.search.list({ part: 'snippet', channelId: YOUR_CHANNEL_ID, type: 'video', maxResults: 50, pageToken: page });
            const ids = (res.data.items||[]).map(i => i.id.videoId);
            if(ids.length) {
                const vRes = await youtubeAuth.videos.list({ part: 'statistics,snippet,status', id: ids.join(',') });
                for(const v of vRes.data.items||[]) {
                    if(v?.status?.privacyStatus === 'public') {
                        videos.push({
                            id: v.id,
                            title: v.snippet.title,
                            viewCount: parseInt(v.statistics.viewCount) || 0,
                            publishTime: new Date(v.snippet.publishedAt)
                        });
                    }
                }
            }
            page = res.data.nextPageToken;
        } while(page);
        return videos;
    } catch(e) { return []; }
}

async function reuploadZeroView(videoId, title, chatId) {
    if (isZeroViewProcessing) return;
    isZeroViewProcessing = true;
    
    try {
        const msg = await bot.telegram.sendMessage(chatId, `⚠️ Zero-view video detected!\n\n${title.substring(0, 50)}\n🔄 Re-uploading...`);
        
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const timestamp = Date.now();
        const tempPath = path.join(TEMP_DIR, `${videoId}_${timestamp}.mp4`);
        
        const streamOptions = {};
        if (agent) streamOptions.agent = agent;
        
        await new Promise((resolve, reject) => {
            const stream = ytdl(url, { ...streamOptions, quality: 'lowest' });
            const write = fs.createWriteStream(tempPath);
            stream.pipe(write);
            write.on('finish', resolve);
            write.on('error', reject);
        });
        
        const scheduleDate = new Date();
        scheduleDate.setDate(scheduleDate.getDate() + REUPLOAD_DELAY);
        
        const response = await youtubeAuth.videos.insert({
            part: 'snippet,status',
            requestBody: {
                snippet: {
                    title: `[REUPLOAD] ${title.substring(0, 80)}`,
                    description: `Auto-reuploaded (0 views after 2 hours)\nDate: ${scheduleDate.toLocaleString()}`,
                    categoryId: '22'
                },
                status: {
                    privacyStatus: 'private',
                    publishAt: scheduleDate.toISOString(),
                    selfDeclaredMadeForKids: false
                }
            },
            media: { body: fs.createReadStream(tempPath), mimeType: 'video/mp4' }
        });
        
        await youtubeAuth.videos.delete({ id: videoId });
        fs.unlinkSync(tempPath);
        
        await bot.telegram.editMessageText(chatId, msg.message_id, null, 
            `✅ Video re-uploaded!\n\n${title.substring(0, 50)}\n📅 New schedule: ${scheduleDate.toLocaleString()}\n🆔 ${response.data.id}`
        );
    } catch(e) {
        console.error('Reupload error:', e.message);
    } finally {
        isZeroViewProcessing = false;
    }
}

async function checkZeroViews() {
    try {
        const videos = await getPublicVideos();
        const now = Date.now();
        
        for(const v of videos) {
            const age = now - v.publishTime;
            if(v.viewCount === 0 && age >= ZERO_VIEW_CHECK_DELAY && !zeroViewVideos.has(v.id)) {
                console.log(`⚠️ Zero view: ${v.title.substring(0, 50)}`);
                zeroViewVideos.set(v.id, { title: v.title, age, warned: false });
            }
        }
        
        for(const [id, info] of zeroViewVideos) {
            if(!info.warned) {
                info.warned = true;
                zeroViewVideos.set(id, info);
                
                setTimeout(async () => {
                    const video = (await getPublicVideos()).find(v => v.id === id);
                    if(video && video.viewCount === 0) {
                        await reuploadZeroView(id, info.title, process.env.ADMIN_CHAT_ID || 'YOUR_CHAT_ID');
                        zeroViewVideos.delete(id);
                    }
                }, 5 * 60 * 1000);
            }
        }
    } catch(e) {
        console.error('Check error:', e.message);
    }
}

function startZeroMonitoring() {
    console.log(`🔍 Zero-view monitor active`);
    setTimeout(() => checkZeroViews(), 60000);
    setInterval(checkZeroViews, 30 * 60 * 1000);
}

function cleanup() {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(TEMP_DIR, file);
            if (now - fs.statSync(filePath).mtimeMs > 3600000) {
                fs.unlinkSync(filePath);
            }
        });
    } catch(e) {}
}
setInterval(cleanup, 3600000);

// ============ TELEGRAM BOT WITH FULL KEYBOARD ============
const bot = new Telegraf(BOT_TOKEN);

// FULL KEYBOARD - All buttons
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            ['📊 STATUS', '📅 SCHEDULED', '🎯 TARGET LATEST'],
            ['📥 SCHEDULE VIDEO', '⚠️ ZERO VIEWS', '🍪 COOKIE STATUS'],
            ['🔄 REFRESH', '📹 TEST VIDEO', '❓ HELP']
        ],
        resize_keyboard: true
    }
};

// Start command with keyboard
bot.start(async (ctx) => {
    const scheduled = await getScheduledShorts();
    const count = await getPublicCount();
    const cookieStatus = cookiesLoaded ? '✅' : '❌';
    
    await ctx.reply(
        `🤖 *YouTube Bot Active*\n\n` +
        `📹 Your videos: ${count}\n` +
        `📅 Scheduled: ${scheduled.length}\n` +
        `🏷️ Watermark: ${WATERMARK_TEXT}\n` +
        `🍪 Cookies: ${cookieStatus}\n` +
        `🚦 Rate Limit: ACTIVE (5s delay)\n` +
        `⏱️ Monitor: EVERY 1 MINUTE\n\n` +
        `📌 Send a YouTube link OR use the buttons below!`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

// Help command
bot.help(async (ctx) => {
    await ctx.reply(
        `📖 *Bot Commands*\n\n` +
        `📊 STATUS - Bot status and stats\n` +
        `📅 SCHEDULED - List your scheduled videos\n` +
        `🎯 TARGET LATEST - Latest video from target channel\n` +
        `📥 SCHEDULE VIDEO - Instructions to schedule a video\n` +
        `⚠️ ZERO VIEWS - Check zero-view videos\n` +
        `🍪 COOKIE STATUS - Check cookie status\n` +
        `🔄 REFRESH - Refresh data\n` +
        `📹 TEST VIDEO - Send a test video link\n` +
        `❓ HELP - Show this help\n\n` +
        `📌 Or just send any YouTube link!`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

// Button: STATUS
bot.hears('📊 STATUS', async (ctx) => {
    const scheduled = await getScheduledShorts();
    const count = await getPublicCount();
    const cookieStatus = cookiesLoaded ? '✅ Loaded' : '❌ Missing';
    await ctx.reply(
        `📊 *BOT STATUS*\n\n` +
        `📹 Your videos: ${count}\n` +
        `📅 Scheduled: ${scheduled.length}\n` +
        `🍪 Cookies: ${cookieStatus}\n` +
        `🚦 Rate limit: Active (5s delay)\n` +
        `⏱️ Monitor: Every 1 minute\n` +
        `🔄 Checks: ${monitorCount}\n` +
        `⚠️ Zero tracked: ${zeroViewVideos.size}\n` +
        `📁 Temp files: ${fs.readdirSync(TEMP_DIR).length}`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

// Button: SCHEDULED
bot.hears('📅 SCHEDULED', async (ctx) => {
    const scheduled = await getScheduledShorts();
    if (scheduled.length === 0) {
        await ctx.reply(`📭 *No scheduled videos*\n\nSend a YouTube link to schedule one!`, { parse_mode: 'Markdown', ...mainKeyboard });
    } else {
        let msg = `📅 *SCHEDULED VIDEOS (${scheduled.length})*\n\n`;
        scheduled.slice(0, 15).forEach((s, i) => {
            msg += `${i+1}. ${s.title.substring(0, 45)}\n   ⏰ ${s.time.toLocaleString()}\n\n`;
        });
        if (scheduled.length > 15) msg += `_...and ${scheduled.length - 15} more_`;
        await ctx.reply(msg, { parse_mode: 'Markdown', ...mainKeyboard });
    }
});

// Button: TARGET LATEST
bot.hears('🎯 TARGET LATEST', async (ctx) => {
    const latest = await getLatestPost();
    if (latest) {
        await ctx.reply(
            `🎯 *Latest from ${TARGET_CHANNEL_HANDLE}*\n\n` +
            `📌 *${latest.title}*\n` +
            `🔗 ${latest.url}`,
            { parse_mode: 'Markdown', ...mainKeyboard, disable_web_page_preview: true }
        );
    } else {
        await ctx.reply(`❌ Could not fetch latest post from target channel.`, { ...mainKeyboard });
    }
});

// Button: SCHEDULE VIDEO
bot.hears('📥 SCHEDULE VIDEO', async (ctx) => {
    await ctx.reply(
        `📥 *How to Schedule a Video*\n\n` +
        `Simply send me any YouTube link!\n\n` +
        `✅ Supported formats:\n` +
        `• https://youtu.be/XXXXX\n` +
        `• https://www.youtube.com/watch?v=XXXXX\n` +
        `• https://youtube.com/shorts/XXXXX\n\n` +
        `🏷️ Watermark: "${WATERMARK_TEXT}"\n` +
        `📅 Schedule: 7 days from now\n\n` +
        `⚠️ The video will be added to your YouTube Studio as "Scheduled"`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

// Button: ZERO VIEWS
bot.hears('⚠️ ZERO VIEWS', async (ctx) => {
    if (zeroViewVideos.size === 0) {
        await ctx.reply(
            `✅ *No Zero-View Videos*\n\n` +
            `All your public videos have views!\n\n` +
            `⚙️ Auto re-upload is active for videos with 0 views after 2 hours.`,
            { parse_mode: 'Markdown', ...mainKeyboard }
        );
    } else {
        let msg = `⚠️ *ZERO-VIEW VIDEOS (${zeroViewVideos.size})*\n\n`;
        for (const [id, info] of zeroViewVideos) {
            const age = Math.floor((Date.now() - info.age) / (60 * 60 * 1000));
            msg += `📹 ${info.title.substring(0, 40)}\n   ⏰ ${age} hours old - Will re-upload\n\n`;
        }
        await ctx.reply(msg, { parse_mode: 'Markdown', ...mainKeyboard });
    }
});

// Button: COOKIE STATUS
bot.hears('🍪 COOKIE STATUS', async (ctx) => {
    const status = cookiesLoaded ? '✅ LOADED' : '❌ NOT LOADED';
    await ctx.reply(
        `🍪 *Cookie Status: ${status}*\n\n` +
        (cookiesLoaded ? 
            `Cookies are active! YouTube requests will be authenticated.\n\n` +
            `📅 Cookies expire in ~6 months.` :
            `Cookies not found. You may get 410 errors.\n\n` +
            `To fix: Add YT_COOKIES environment variable with your YouTube cookies.`),
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

// Button: REFRESH
bot.hears('🔄 REFRESH', async (ctx) => {
    scheduledCache = null;
    await ctx.reply(`🔄 Data refreshed!`, { ...mainKeyboard });
});

// Button: TEST VIDEO
bot.hears('📹 TEST VIDEO', async (ctx) => {
    await ctx.reply(
        `📹 *Test Video*\n\n` +
        `Send this link to test the bot:\n\n` +
        `https://youtu.be/dQw4w9WgXcQ\n\n` +
        `This is a public working video (Rick Astley).`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

// Button: HELP
bot.hears('❓ HELP', async (ctx) => {
    await ctx.reply(
        `📖 *HELP*\n\n` +
        `📊 STATUS - Bot status\n` +
        `📅 SCHEDULED - Your scheduled videos\n` +
        `🎯 TARGET LATEST - Target channel latest\n` +
        `📥 SCHEDULE VIDEO - Send a YouTube link\n` +
        `⚠️ ZERO VIEWS - Check zero-view videos\n` +
        `🍪 COOKIE STATUS - Check cookies\n` +
        `🔄 REFRESH - Refresh data\n` +
        `📹 TEST VIDEO - Test with working link\n\n` +
        `💡 *Quick Tip:* Just send any YouTube link to schedule it!`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

// Handle YouTube links
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    
    // Skip button texts
    const buttons = ['📊 STATUS', '📅 SCHEDULED', '🎯 TARGET LATEST', '📥 SCHEDULE VIDEO', '⚠️ ZERO VIEWS', '🍪 COOKIE STATUS', '🔄 REFRESH', '📹 TEST VIDEO', '❓ HELP'];
    if (buttons.includes(text)) return;
    if (text.startsWith('/')) return;
    
    const urlPattern = /(youtu\.be\/|youtube\.com\/watch\?v=|youtube\.com\/shorts\/)/i;
    if (urlPattern.test(text)) {
        let url = text;
        if (url.includes(' ')) url = url.split(' ')[0];
        
        if (activeDownloads.has(ctx.chat.id)) {
            await ctx.reply(`⏳ Please wait, a download is already in progress!`, { ...mainKeyboard });
            return;
        }
        
        activeDownloads.set(ctx.chat.id, true);
        
        const statusMsg = await ctx.reply(
            `🎬 *Processing your video...*\n\n` +
            `🏷️ Watermark: ${WATERMARK_TEXT}\n` +
            `🚦 Rate limit protection: ACTIVE\n` +
            `⏳ This may take a few minutes...`,
            { parse_mode: 'Markdown', ...mainKeyboard }
        );
        
        try {
            const result = await downloadAndSchedule(url, ctx.chat.id, statusMsg.message_id);
            await bot.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
                `✅ *SUCCESS!*\n\n` +
                `📹 ${result.title.substring(0, 50)}\n` +
                
