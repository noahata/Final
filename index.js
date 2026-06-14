const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const ytdl = require('ytdl-core');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// Set ffmpeg path
if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
}

// ============ CHECK BOT TOKEN ============
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('❌ ERROR: BOT_TOKEN environment variable is not set!');
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
const WATERMARK_TEXT = '⚙︎ Noah_Technical ⧉';
const WATERMARK_POSITION = 'bottom-right';
const WATERMARK_FONT_SIZE = 24;
const WATERMARK_COLOR = 'white';

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

// ============ ZERO VIEW TRACKING ============
let zeroViewVideos = new Map();
let isZeroViewProcessing = false;
const ZERO_VIEW_CHECK_DELAY = 2 * 60 * 60 * 1000;
const REUPLOAD_DELAY = 30;

// Create temp directory
const TEMP_DIR = path.join(__dirname, 'temp_downloads');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    console.log(`📁 Created temp directory: ${TEMP_DIR}`);
}

let activeDownloads = new Map();

// =========================================
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
        console.error('Error:', e.message);
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
        console.error('Error:', e.message);
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
            publishedAt: latest.snippet.publishedAt,
            url: `https://www.youtube.com/watch?v=${latest.snippet.resourceId.videoId}`
        };
    } catch(e) {
        console.error('Error:', e.message);
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
        console.error('Error:', e.message);
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
    const patterns = [
        /(?:youtube\.com\/watch\?v=)([^&]+)/,
        /(?:youtu\.be\/)([^?]+)/,
        /(?:youtube\.com\/shorts\/)([^?]+)/
    ];
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

async function addWatermark(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`🎨 Adding watermark...`);
        
        ffmpeg(inputPath)
            .videoFilter(`drawtext=text='${WATERMARK_TEXT}':fontcolor=${WATERMARK_COLOR}:fontsize=${WATERMARK_FONT_SIZE}:box=1:boxcolor=black@0.5:boxborderw=5:x=W-tw-10:y=H-th-10`)
            .audioCodec('copy')
            .output(outputPath)
            .on('end', () => {
                console.log(`✅ Watermark added`);
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error('FFmpeg error:', err.message);
                fs.copyFileSync(inputPath, outputPath);
                resolve(outputPath);
            })
            .run();
    });
}

// ============ DOWNLOAD AND SCHEDULE FUNCTION ============

async function downloadAndSchedule(url, chatId, messageId) {
    return new Promise(async (resolve, reject) => {
        const videoId = extractVideoId(url);
        if (!videoId) {
            reject(new Error('❌ Invalid YouTube URL. Please send a valid YouTube link.'));
            return;
        }
        
        try {
            // Step 1: Get video info
            await bot.telegram.editMessageText(chatId, messageId, null, `🔍 Getting video information...`, { parse_mode: 'Markdown' });
            
            const info = await ytdl.getInfo(url);
            const videoTitle = info.videoDetails.title;
            const timestamp = Date.now();
            const tempPath = path.join(TEMP_DIR, `${videoId}_${timestamp}_temp.mp4`);
            const watermarkedPath = path.join(TEMP_DIR, `${videoId}_${timestamp}_wm.mp4`);
            
            const format = ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' });
            if (!format) throw new Error('No video format found');
            
            const totalSize = parseInt(format.contentLength) || 0;
            const startTime = Date.now();
            let lastUpdate = 0;
            
            // Step 2: Download
            const writeStream = fs.createWriteStream(tempPath);
            const downloadStream = ytdl(url, { format: format });
            
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
                    
                    try {
                        await bot.telegram.editMessageText(chatId, messageId, null,
                            `📥 **Downloading...**\n\n` +
                            `\`${bar}\` ${percent.toFixed(1)}%\n\n` +
                            `📦 ${formatFileSize(downloaded)} / ${formatFileSize(total)}\n` +
                            `⚡ ${formatSpeed(speed)} | ⏱️ ${Math.ceil(remaining)}s`,
                            { parse_mode: 'Markdown' }
                        );
                    } catch (e) {}
                }
            });
            
            downloadStream.pipe(writeStream);
            
            writeStream.on('finish', async () => {
                try {
                    // Step 3: Add watermark
                    await bot.telegram.editMessageText(chatId, messageId, null, `✅ **Download complete!**\n\n🎨 **Adding watermark:** "${WATERMARK_TEXT}"`, { parse_mode: 'Markdown' });
                    await addWatermark(tempPath, watermarkedPath);
                    fs.unlinkSync(tempPath);
                    
                    // Step 4: Upload to YouTube
                    const scheduleDate = new Date();
                    scheduleDate.setDate(scheduleDate.getDate() + 7);
                    
                    await bot.telegram.editMessageText(chatId, messageId, null, `📤 **Uploading to YouTube...**\n📅 Scheduled for: ${scheduleDate.toLocaleString()}`, { parse_mode: 'Markdown' });
                    
                    const response = await youtubeAuth.videos.insert({
                        part: 'snippet,status',
                        requestBody: {
                            snippet: {
                                title: `[SCHEDULED] ${videoTitle.substring(0, 80)}`,
                                description: `📥 Scheduled via Bot\n🏷️ Watermark: ${WATERMARK_TEXT}\n📅 ${scheduleDate.toLocaleString()}\n\nOriginal: ${url}`,
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
                } catch (err) {
                    reject(err);
                }
            });
            
            writeStream.on('error', reject);
            downloadStream.on('error', reject);
        } catch (error) {
            reject(error);
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
        const msg = await bot.telegram.sendMessage(chatId, `⚠️ **Zero-view video detected!**\n\n📹 ${title.substring(0, 50)}\n🔄 Re-uploading...`, { parse_mode: 'Markdown' });
        
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const timestamp = Date.now();
        const tempPath = path.join(TEMP_DIR, `${videoId}_${timestamp}.mp4`);
        
        await new Promise((resolve, reject) => {
            const stream = ytdl(url, { quality: 'lowest' });
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
                    description: `⚠️ Auto-reuploaded (0 views after 2 hours)\n📅 ${scheduleDate.toLocaleString()}`,
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
            `✅ **Video re-uploaded!**\n\n📹 ${title.substring(0, 50)}\n📅 New schedule: ${scheduleDate.toLocaleString()}\n🆔 \`${response.data.id}\``,
            { parse_mode: 'Markdown' }
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

// ============ TELEGRAM BOT ============
const bot = new Telegraf(BOT_TOKEN);

// Simple menu
const menu = {
    reply_markup: {
        keyboard: [
            ['📊 Status', '📦 Schedule', '📹 Latest'],
            ['📥 Send Link', '⚠️ Zero Views', '🔄 Refresh'],
            ['❓ Help', '🔧 Test Bot']
        ],
        resize_keyboard: true
    }
};

// Start command
bot.start(async (ctx) => {
    const scheduled = await getScheduledShorts();
    const count = await getPublicCount();
    await ctx.reply(
        `🤖 *YouTube Bot Active* ✅\n\n` +
        `📹 Your videos: ${count}\n` +
        `📅 Scheduled: ${scheduled.length}\n` +
        `🏷️ Watermark: "${WATERMARK_TEXT}"\n\n` +
        `✨ *Send me a YouTube link* to schedule it!\n\n` +
        `🔧 Use /test to check if bot is working`,
        { parse_mode: 'Markdown', ...menu }
    );
});

// Test command - tells you what's working
bot.command('test', async (ctx) => {
    let statusMsg = `🔧 *Bot Diagnostic Test*\n\n`;
    
    // Test 1: Bot is responding
    statusMsg += `✅ Bot is responding\n`;
    
    // Test 2: Check YouTube API
    try {
        const test = await youtubeAuth.channels.list({ part: 'id', id: YOUR_CHANNEL_ID });
        if (test.data.items && test.data.items.length > 0) {
            statusMsg += `✅ YouTube API connected\n`;
        } else {
            statusMsg += `❌ YouTube API: Channel not found\n`;
        }
    } catch (e) {
        statusMsg += `❌ YouTube API error: ${e.message.substring(0, 50)}\n`;
    }
    
    // Test 3: Check temp directory
    if (fs.existsSync(TEMP_DIR)) {
        statusMsg += `✅ Temp directory: ${TEMP_DIR}\n`;
    } else {
        statusMsg += `❌ Temp directory missing\n`;
    }
    
    // Test 4: Check FFmpeg
    try {
        ffmpeg.getAvailableCodecs((err) => {
            if (err) {
                statusMsg += `⚠️ FFmpeg: Will use fallback\n`;
            } else {
                statusMsg += `✅ FFmpeg available\n`;
            }
        });
    } catch (e) {
        statusMsg += `⚠️ FFmpeg: Using fallback\n`;
    }
    
    statusMsg += `\n📌 Send a YouTube link to test download!`;
    await ctx.reply(statusMsg, { parse_mode: 'Markdown', ...menu });
});

// Help command
bot.help(async (ctx) => {
    await ctx.reply(
        `📖 *How to use*\n\n` +
        `1️⃣ Send any YouTube link\n` +
        `2️⃣ Bot downloads the video\n` +
        `3️⃣ Adds watermark: "${WATERMARK_TEXT}"\n` +
        `4️⃣ Schedules to your channel (7 days)\n\n` +
        `⚠️ Zero-view videos auto re-upload after 2 hours\n\n` +
        `🔧 Use /test to check if bot is working`,
        { parse_mode: 'Markdown', ...menu }
    );
});

// Button handlers
bot.hears('🔧 Test Bot', async (ctx) => {
    await ctx.reply(`🔧 Running diagnostic...`);
    await bot.telegram.sendMessage(ctx.chat.id, `/test`);
});

bot.hears('❓ Help', async (ctx) => {
    await ctx.reply(
        `📖 *Commands*\n\n` +
        `/start - Start the bot\n` +
        `/test - Test if bot is working\n` +
        `/help - Show this help\n\n` +
        `📥 Send any YouTube link to schedule it!`,
        { parse_mode: 'Markdown', ...menu }
    );
});

bot.hears('📊 Status', async (ctx) => {
    const scheduled = await getScheduledShorts();
    const count = await getPublicCount();
    await ctx.reply(`📊 *Status*\n\n📹 Videos: ${count}\n📅 Scheduled: ${scheduled.length}\n⚠️ Zero tracked: ${zeroViewVideos.size}`, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📦 Schedule', async (ctx) => {
    const scheduled = await getScheduledShorts();
    if (scheduled.length === 0) {
        await ctx.reply(`📭 No scheduled videos. Send a YouTube link to schedule one!`, { ...menu });
    } else {
        let msg = `📦 *Scheduled (${scheduled.length})*\n\n`;
        scheduled.forEach((s, i) => {
            msg += `${i+1}. ${s.title.substring(0, 40)}\n   ⏰ ${s.time.toLocaleString()}\n\n`;
        });
        await ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
    }
});

bot.hears('📹 Latest', async (ctx) => {
    const latest = await getLatestPost();
    if (latest) {
        await ctx.reply(`📹 *Latest from target*\n\n${latest.title}\n🔗 ${latest.url}`, { parse_mode: 'Markdown', ...menu });
    } else {
        await ctx.reply(`❌ Could not fetch latest post. Check channel ID.`, { ...menu });
    }
});

bot.hears('📥 Send Link', async (ctx) => {
    await ctx.reply(`📥 *Send me a YouTube link*\n\nExample: https://youtu.be/xxxxx\n\n🏷️ Watermark: "${WATERMARK_TEXT}"\n\n⚠️ Make sure the video is not private or age-restricted!`, { parse_mode: 'Markdown', ...menu });
});

bot.hears('⚠️ Zero Views', async (ctx) => {
    if (zeroViewVideos.size === 0) {
        await ctx.reply(`✅ No zero-view videos detected. All your videos have views!`, { ...menu });
    } else {
        let msg = `⚠️ *Zero-view videos (${zeroViewVideos.size})*\n\n`;
        for (const [id, info] of zeroViewVideos) {
            const age = Math.floor((Date.now() - info.age) / (60 * 60 * 1000));
            msg += `📹 ${info.title.substring(0, 40)}\n   ⏰ ${age} hours old - Will re-upload soon\n\n`;
        }
        await ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
    }
});

bot.hears('🔄 Refresh', async (ctx) => {
    scheduledCache = null;
    await ctx.reply(`✅ Refreshed!`, { ...menu });
});

// Handle YouTube links
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    
    // Skip commands and buttons
    const buttons = ['📊 Status', '📦 Schedule', '📹 Latest', '📥 Send Link', '⚠️ Zero Views', '🔄 Refresh', '❓ Help', '🔧 Test Bot'];
    if (buttons.includes(text)) return;
    if (text.startsWith('/')) return;
    
    // Check for YouTube URL
    const urlPattern = /(youtu\.be\/|youtube\.com\/watch\?v=|youtube\.com\/shorts\/)/i;
    if (urlPattern.test(text)) {
        const match = text.match(/https?:\/\/[^\s]+/i);
        if (match) {
            const url = match[0];
            
            if (activeDownloads.has(ctx.chat.id)) {
                await ctx.reply(`⏳ Please wait, a download is already in progress! Let it finish first.`);
                return;
            }
            
            activeDownloads.set(ctx.chat.id, true);
            const statusMsg = await ctx.reply(`🎬 **Processing your video...**\n🏷️ Watermark: "${WATERMARK_TEXT}"\n\n⏳ This may take a few minutes...`, { parse_mode: 'Markdown' });
            
            try {
                const result = await downloadAndSchedule(url, ctx.chat.id, statusMsg.message_id);
                await bot.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
                    `✅ **VIDEO SCHEDULED SUCCESSFULLY!**\n\n` +
                    `📹 **Title:** ${result.title.substring(0, 50)}\n` +
                    `📅 **Scheduled for:** ${result.scheduleDate.toLocaleString()}\n` +
                    `🆔 **Video ID:** \`${result.videoId}\`\n\n` +
                    `✨ The video is now in your YouTube Studio!`,
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                console.error('Error:', error.message);
                await bot.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
                    `❌ **FAILED:** ${error.message}\n\n` +
                    `💡 Possible issues:\n` +
                    `• Video is private or deleted\n` +
                    `• Video is age-restricted (18+)\n` +
                    `• Invalid YouTube URL\n` +
                    `• Video is too long\n\n` +
                    `Try another video!`,
                    { parse_mode: 'Markdown' }
                );
            } finally {
                activeDownloads.delete(ctx.chat.id);
            }
            return;
        }
    }
});

// Error handler
bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx.reply(`❌ **Error:** ${err.message}\n\nPlease try again or use /test to diagnose.`, { parse_mode: 'Markdown' }).catch(() => {});
});

// Start bot
console.log('🚀 Launching bot...');
bot.launch().then(() => {
    console.log('✅ Telegram bot started successfully!');
    console.log('🎯 Bot is ready! Send a YouTube link to test.');
    console.log(`🏷️ Watermark: "${WATERMARK_TEXT}"`);
}).catch(err => {
    console.error('❌ Failed to start bot:', err.message);
});

// ============ INITIALIZE ============
console.log(`\n🚀 YouTube Bot Initialized!`);
console.log(`✨ Send any YouTube link to schedule with watermark`);
console.log(`⚠️ Auto zero-view monitoring active`);
console.log(`🏷️ Watermark: "${WATERMARK_TEXT}"`);
console.log(`📤 Channel: ${YOUR_CHANNEL_ID}\n`);

// Initial setup
setTimeout(async () => {
    const latest = await getLatestPost();
    if (latest) {
        console.log(`📹 Latest target: ${latest.title}`);
        lastVideoId = latest.id;
    }
    const scheduled = await getScheduledShorts();
    console.log(`📊 Scheduled videos: ${scheduled.length}`);
}, 2000);

// Start monitoring
setInterval(monitor, 30000);
monitor();
startZeroMonitoring();

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err.message);
});

console.log('✅ Setup complete! Bot is waiting for messages...');
