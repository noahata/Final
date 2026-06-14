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
