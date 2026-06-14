const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const ytdl = require('ytdl-core');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// ============ CREDENTIALS ============
const BOT_TOKEN = process.env.BOT_TOKEN;
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
const WATERMARK_BACKGROUND = 'black@0.5';

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
let lastPostInfo = null;

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

// API key rotation
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

// Token refresh
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
        console.error('Error getting uploads playlist:', e.message);
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
        console.error('Error getting your uploads playlist:', e.message);
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
            url: `https://www.youtube.com/watch?v=${latest.snippet.resourceId.videoId}`,
            thumbnail: latest.snippet.thumbnails.default.url
        };
    } catch(e) {
        console.error('Error getting latest post:', e.message);
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
        console.error('Error getting scheduled:', e.message);
        return []; 
    }
}

async function publishVideo(id, title) {
    try {
        console.log(`📤 Publishing: ${title}`);
        await youtubeAuth.videos.update({ part: 'status', requestBody: { id: id, status: { privacyStatus: 'public' } } });
        console.log(`✅ Published: ${title}`);
        scheduledCache = null;
        return true;
    } catch(e) { 
        console.error(`❌ Failed to publish ${title}:`, e.message);
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
        lastPostInfo = latestPost;
        console.log(`\n📹 Latest from ${TARGET_CHANNEL_HANDLE}: ${latestPost.title}`);
        
        if(latestPost.id !== lastVideoId && lastVideoId !== null) {
            console.log(`\n🎬 NEW VIDEO DETECTED!`);
            const scheduled = await getScheduledShorts(true);
            if(scheduled.length > 0) {
                const toPublish = scheduled[0];
                await publishVideo(toPublish.id, toPublish.title);
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

function getTimeAgo(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if(diffMins < 1) return 'Just now';
    if(diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    if(diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
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

async function addWatermarkToVideo(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`🎨 Adding watermark: "${WATERMARK_TEXT}"`);
        
        let positionFilter = '';
        switch(WATERMARK_POSITION) {
            case 'top-left': positionFilter = 'x=10:y=10'; break;
            case 'top-right': positionFilter = 'x=W-tw-10:y=10'; break;
            case 'bottom-left': positionFilter = 'x=10:y=H-th-10'; break;
            case 'bottom-right': positionFilter = 'x=W-tw-10:y=H-th-10'; break;
            default: positionFilter = 'x=W-tw-10:y=H-th-10';
        }
        
        ffmpeg(inputPath)
            .videoFilter(`drawtext=text='${WATERMARK_TEXT}':fontcolor=${WATERMARK_COLOR}:fontsize=${WATERMARK_FONT_SIZE}:box=1:boxcolor=${WATERMARK_BACKGROUND}:boxborderw=5:${positionFilter}`)
            .audioCodec('copy')
            .output(outputPath)
            .on('end', () => {
                console.log(`✅ Watermark added!`);
                resolve(outputPath);
            })
            .on('error', (error) => {
                console.error(`❌ FFmpeg error:`, error.message);
                reject(error);
            })
            .run();
    });
    }
// ============ FEATURE 1: SCHEDULE BY LINK ============

async function downloadVideoFromUrl(url, chatId, messageId, scheduleDays = 7) {
    return new Promise(async (resolve, reject) => {
        const videoId = extractVideoId(url);
        if (!videoId) {
            reject(new Error('Invalid YouTube URL'));
            return;
        }
        
        try {
            const info = await ytdl.getInfo(url);
            const videoTitle = info.videoDetails.title;
            const timestamp = Date.now();
            const tempPath = path.join(TEMP_DIR, `${videoId}_${timestamp}_temp.mp4`);
            const watermarkedPath = path.join(TEMP_DIR, `${videoId}_${timestamp}_watermarked.mp4`);
            
            const format = ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' });
            if (!format) throw new Error('No suitable format found');
            
            const totalSize = parseInt(format.contentLength) || 0;
            const startTime = Date.now();
            let downloaded = 0;
            let lastUpdate = 0;
            
            const writeStream = fs.createWriteStream(tempPath);
            const downloadStream = ytdl(url, { format: format });
            
            downloadStream.on('progress', async (chunkLength, downloadedBytes, totalBytes) => {
                downloaded = downloadedBytes;
                const now = Date.now();
                if (now - lastUpdate > 3000 && totalBytes) {
                    lastUpdate = now;
                    const elapsed = (now - startTime) / 1000;
                    const speed = downloaded / elapsed;
                    const remainingBytes = totalBytes - downloaded;
                    const timeRemaining = speed > 0 ? remainingBytes / speed : 0;
                    const percent = (downloaded / totalBytes) * 100;
                    const barLength = 20;
                    const filled = Math.floor(barLength * percent / 100);
                    const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
                    
                    const progressMsg = 
                        `📥 **Downloading...**\n\n` +
                        `\`\`\`\n${bar} ${percent.toFixed(1)}%\n\`\`\`\n` +
                        `📦 ${formatFileSize(downloaded)} / ${formatFileSize(totalBytes)}\n` +
                        `⚡ ${formatSpeed(speed)} | ⏱️ ${Math.ceil(timeRemaining)}s left`;
                    
                    try {
                        await bot.telegram.editMessageText(chatId, messageId, null, progressMsg, { parse_mode: 'Markdown' });
                    } catch (e) {}
                }
            });
            
            downloadStream.pipe(writeStream);
            
            writeStream.on('finish', async () => {
                console.log(`✅ Download complete: ${videoTitle}`);
                await bot.telegram.editMessageText(chatId, messageId, null, `✅ **Download complete!**\n\n🎨 **Adding watermark...**`, { parse_mode: 'Markdown' });
                
                await addWatermarkToVideo(tempPath, watermarkedPath);
                fs.unlinkSync(tempPath);
                resolve({ filePath: watermarkedPath, title: videoTitle, description: info.videoDetails.description || '' });
            });
            
            writeStream.on('error', reject);
            downloadStream.on('error', reject);
        } catch (error) {
            reject(error);
        }
    });
}

async function uploadAndScheduleVideo(filePath, originalTitle, originalDescription, chatId, messageId, scheduleDays = 7) {
    return new Promise(async (resolve, reject) => {
        const scheduleDate = new Date();
        scheduleDate.setDate(scheduleDate.getDate() + scheduleDays);
        const newTitle = `[SCHEDULED] ${originalTitle.substring(0, 80)}`;
        
        await bot.telegram.editMessageText(chatId, messageId, null,
            `📤 **Uploading to YouTube...**\n📅 Scheduled for: ${scheduleDate.toLocaleString()}`,
            { parse_mode: 'Markdown' }
        );
        
        try {
            const requestBody = {
                snippet: {
                    title: newTitle,
                    description: `📥 Scheduled via Bot\n🏷️ Watermark: ${WATERMARK_TEXT}\n📅 Scheduled: ${scheduleDate.toLocaleString()}\n\n${originalDescription.substring(0, 500)}`,
                    tags: ['scheduled', 'watermark'],
                    categoryId: '22'
                },
                status: {
                    privacyStatus: 'private',
                    publishAt: scheduleDate.toISOString(),
                    selfDeclaredMadeForKids: false
                }
            };
            
            const response = await youtubeAuth.videos.insert({
                part: 'snippet,status',
                requestBody: requestBody,
                media: { body: fs.createReadStream(filePath), mimeType: 'video/mp4' }
            });
            
            console.log(`✅ Upload complete! Video ID: ${response.data.id}`);
            scheduledCache = null;
            resolve({ videoId: response.data.id, scheduleDate: scheduleDate });
        } catch (error) {
            reject(error);
        }
    });
}

async function handleScheduleByLink(ctx, url) {
    if (activeDownloads.has(ctx.chat.id)) {
        await ctx.reply(`⏳ Please wait! A download is in progress.`);
        return;
    }
    
    activeDownloads.set(ctx.chat.id, true);
    const progressMsg = await ctx.reply(`🎬 **Processing your video...**\n\n🏷️ Watermark: ${WATERMARK_TEXT}\n⏳ Starting download...`);
    let downloadedFile = null;
    
    try {
        const downloadResult = await downloadVideoFromUrl(url, ctx.chat.id, progressMsg.message_id, 7);
        downloadedFile = downloadResult.filePath;
        const uploadResult = await uploadAndScheduleVideo(downloadedFile, downloadResult.title, downloadResult.description, ctx.chat.id, progressMsg.message_id, 7);
        
        await bot.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null,
            `✅ **VIDEO SCHEDULED SUCCESSFULLY!**\n\n` +
            `📹 **${downloadResult.title.substring(0, 50)}**\n` +
            `🏷️ Watermark: ${WATERMARK_TEXT}\n` +
            `📅 Scheduled: ${uploadResult.scheduleDate.toLocaleString()}\n\n` +
            `🆔 Video ID: \`${uploadResult.videoId}\``,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error('Error:', error.message);
        await bot.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null,
            `❌ **FAILED:** ${error.message}`,
            { parse_mode: 'Markdown' }
        );
    } finally {
        activeDownloads.delete(ctx.chat.id);
        if (downloadedFile) {
            setTimeout(() => { try { if (fs.existsSync(downloadedFile)) fs.unlinkSync(downloadedFile); } catch(e) {} }, 5000);
        }
    }
}

// ============ FEATURE 2: AUTO ZERO-VIEWS ============

async function getPublicVideosWithDetails() {
    try {
        let allVideos = [], page = null;
        do {
            const res = await youtubeAuth.search.list({ part: 'snippet', channelId: YOUR_CHANNEL_ID, type: 'video', maxResults: 50, pageToken: page });
            const ids = (res.data.items||[]).map(i => i.id.videoId).filter(id=>id);
            if(ids.length) {
                const videoRes = await youtubeAuth.videos.list({ part: 'statistics,snippet,status', id: ids.join(',') });
                for(const video of videoRes.data.items||[]) {
                    if(video?.status?.privacyStatus === 'public') {
                        allVideos.push({
                            id: video.id,
                            title: video.snippet.title,
                            viewCount: parseInt(video.statistics.viewCount) || 0,
                            publishTime: new Date(video.snippet.publishedAt),
                            description: video.snippet.description || ''
                        });
                    }
                }
            }
            page = res.data.nextPageToken;
        } while(page);
        return allVideos;
    } catch(e) { 
        console.error('Error:', e.message);
        return []; 
    }
}

async function downloadZeroViewVideo(videoId, videoTitle, chatId, messageId) {
    return new Promise(async (resolve, reject) => {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const timestamp = Date.now();
        const outputPath = path.join(TEMP_DIR, `${videoId}_${timestamp}_zero.mp4`);
        
        try {
            const info = await ytdl.getInfo(videoUrl);
            const format = ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' });
            if (!format) throw new Error('No suitable format found');
            
            const totalSize = parseInt(format.contentLength) || 0;
            const startTime = Date.now();
            let downloaded = 0;
            let lastUpdate = 0;
            
            const writeStream = fs.createWriteStream(outputPath);
            const downloadStream = ytdl(videoUrl, { format: format });
            
            downloadStream.on('progress', async (chunkLength, downloadedBytes, totalBytes) => {
                downloaded = downloadedBytes;
                const now = Date.now();
                if (now - lastUpdate > 3000 && totalBytes) {
                    lastUpdate = now;
                    const elapsed = (now - startTime) / 1000;
                    const speed = downloaded / elapsed;
                    const remainingBytes = totalBytes - downloaded;
                    const timeRemaining = speed > 0 ? remainingBytes / speed : 0;
                    const percent = (downloaded / totalBytes) * 100;
                    const barLength = 20;
                    const filled = Math.floor(barLength * percent / 100);
                    const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
                    
                    const progressMsg = 
                        `⚠️ **Re-uploading zero-view video...**\n\n` +
                        `\`\`\`\n${bar} ${percent.toFixed(1)}%\n\`\`\`\n` +
                        `📦 ${formatFileSize(downloaded)} / ${formatFileSize(totalBytes)}\n` +
                        `⚡ ${formatSpeed(speed)} | ⏱️ ${Math.ceil(timeRemaining)}s left`;
                    
                    try {
                        await bot.telegram.editMessageText(chatId, messageId, null, progressMsg, { parse_mode: 'Markdown' });
                    } catch (e) {}
                }
            });
            
            downloadStream.pipe(writeStream);
            writeStream.on('finish', () => resolve(outputPath));
            writeStream.on('error', reject);
            downloadStream.on('error', reject);
        } catch (error) {
            reject(error);
        }
    });
}

async function reuploadZeroViewVideo(filePath, originalTitle, originalDescription, chatId, messageId) {
    return new Promise(async (resolve, reject) => {
        const scheduleDate = new Date();
        scheduleDate.setDate(scheduleDate.getDate() + REUPLOAD_DELAY);
        const newTitle = `[REUPLOAD] ${originalTitle.substring(0, 80)}`;
        
        await bot.telegram.editMessageText(chatId, messageId, null,
            `📤 **Re-uploading to YouTube...**\n📅 New schedule: ${scheduleDate.toLocaleString()}`,
            { parse_mode: 'Markdown' }
        );
        
        try {
            const requestBody = {
                snippet: {
                    title: newTitle,
                    description: `⚠️ AUTO-REUPLOADED (0 views after 2 hours)\nNew schedule: ${scheduleDate.toLocaleString()}\n\n${originalDescription.substring(0, 500)}`,
                    tags: ['reupload', 'zero-views'],
                    categoryId: '22'
                },
                status: {
                    privacyStatus: 'private',
                    publishAt: scheduleDate.toISOString(),
                    selfDeclaredMadeForKids: false
                }
            };
            
            const response = await youtubeAuth.videos.insert({
                part: 'snippet,status',
                requestBody: requestBody,
                media: { body: fs.createReadStream(filePath), mimeType: 'video/mp4' }
            });
            
            scheduledCache = null;
            resolve({ videoId: response.data.id, scheduleDate: scheduleDate });
        } catch (error) {
            reject(error);
        }
    });
}

async function deleteOriginalVideo(videoId, title) {
    try {
        console.log(`🗑️ Deleting original: ${title.substring(0, 50)}`);
        await youtubeAuth.videos.delete({ id: videoId });
        console.log(`✅ Deleted`);
        return true;
    } catch (error) {
        console.error(`❌ Delete failed:`, error.message);
        return false;
    }
        }
async function processZeroViewVideo(videoId, videoInfo, chatId = null) {
    if (isZeroViewProcessing) return false;
    isZeroViewProcessing = true;
    let downloadedFile = null;
    let progressMessageId = null;
    const targetChatId = chatId || process.env.ADMIN_CHAT_ID;
    
    try {
        if (targetChatId) {
            const progressMsg = await bot.telegram.sendMessage(targetChatId,
                `⚠️ **Zero-View Video Detected!**\n\n📹 ${videoInfo.title.substring(0, 50)}\n⏰ ${videoInfo.ageHours.toFixed(1)} hours old\n📊 Views: 0\n\n🔄 **Re-uploading...**`,
                { parse_mode: 'Markdown' }
            );
            progressMessageId = progressMsg.message_id;
        }
        
        downloadedFile = await downloadZeroViewVideo(videoId, videoInfo.title, targetChatId, progressMessageId);
        const uploadResult = await reuploadZeroViewVideo(downloadedFile, videoInfo.title, videoInfo.description, targetChatId, progressMessageId);
        await deleteOriginalVideo(videoId, videoInfo.title);
        
        const successMsg = `✅ **Video Re-uploaded!**\n\n📹 ${videoInfo.title.substring(0, 50)}\n📅 New schedule: ${uploadResult.scheduleDate.toLocaleString()}`;
        
        if (targetChatId && progressMessageId) {
            await bot.telegram.editMessageText(targetChatId, progressMessageId, null, successMsg, { parse_mode: 'Markdown' });
        }
        return true;
    } catch (error) {
        console.error(`❌ Failed:`, error.message);
        return false;
    } finally {
        isZeroViewProcessing = false;
        if (downloadedFile) {
            setTimeout(() => { try { if (fs.existsSync(downloadedFile)) fs.unlinkSync(downloadedFile); } catch(e) {} }, 5000);
        }
    }
}

async function checkZeroViewVideos() {
    try {
        console.log(`\n🔍 Checking for zero-view videos...`);
        const videos = await getPublicVideosWithDetails();
        const now = new Date();
        
        for(const video of videos) {
            const ageInMs = now - video.publishTime;
            const ageInHours = ageInMs / (60 * 60 * 1000);
            
            if(video.viewCount === 0 && ageInMs >= ZERO_VIEW_CHECK_DELAY && !zeroViewVideos.has(video.id)) {
                console.log(`⚠️ ZERO VIEW: ${video.title.substring(0, 50)} (${ageInHours.toFixed(1)} hours)`);
                zeroViewVideos.set(video.id, {
                    title: video.title,
                    publishTime: video.publishTime,
                    ageHours: ageInHours,
                    warned: false,
                    checkedAt: now,
                    description: video.description
                });
            }
        }
        
        for(const [videoId, info] of zeroViewVideos.entries()) {
            if(!info.warned) {
                info.warned = true;
                zeroViewVideos.set(videoId, info);
                
                try {
                    await bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID || 'YOUR_CHAT_ID', 
                        `⚠️ *Zero View Detected*\n📹 ${info.title.substring(0, 50)}\n⏰ ${info.ageHours.toFixed(1)} hours old\n🔄 Processing in 5 minutes`,
                        { parse_mode: 'Markdown' });
                } catch(e) {}
            }
        }
        
        for(const [videoId, info] of zeroViewVideos.entries()) {
            if(info.warned) {
                const video = videos.find(v => v.id === videoId);
                if(video && video.viewCount === 0) {
                    const timeSinceCheck = now - info.checkedAt;
                    if(timeSinceCheck >= 5 * 60 * 1000) {
                        console.log(`\n🚨 Processing: ${info.title.substring(0, 50)}`);
                        await processZeroViewVideo(videoId, info);
                        zeroViewVideos.delete(videoId);
                    }
                } else if(video && video.viewCount > 0) {
                    console.log(`✅ Video got views! Removing from tracking`);
                    zeroViewVideos.delete(videoId);
                }
            }
        }
        
        if(zeroViewVideos.size > 0) {
            console.log(`📊 Monitoring: ${zeroViewVideos.size} video(s)`);
        }
    } catch(e) {
        console.error('Check error:', e.message);
    }
}

function cleanupOldTempFiles() {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        let deleted = 0;
        files.forEach(file => {
            const filePath = path.join(TEMP_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > 60 * 60 * 1000) {
                fs.unlinkSync(filePath);
                deleted++;
            }
        });
        if (deleted > 0) console.log(`🗑️ Cleaned ${deleted} old file(s)`);
    } catch (error) {}
}

function startZeroViewMonitoring() {
    console.log(`\n🔍 Auto Zero-Views Monitor Active`);
    setInterval(cleanupOldTempFiles, 60 * 60 * 1000);
    setTimeout(() => checkZeroViewVideos(), 60000);
    setInterval(checkZeroViewVideos, 30 * 60 * 1000);
}

// ============ TELEGRAM BOT ============
const bot = new Telegraf(BOT_TOKEN);

// Menu
const menu = { 
    reply_markup: { 
        keyboard: [
            ['📊 STATUS', '📦 SUPPLY', '📹 LATEST'],
            ['📥 SCHEDULE LINK', '⚠️ ZERO STATUS', '🔄 REFRESH'],
            ['🏷️ WATERMARK', '🔍 CHECK ZERO', '❓ HELP']
        ], 
        resize_keyboard: true 
    } 
};

// Start command
bot.start(async (ctx) => {
    const scheduled = await getScheduledShorts();
    const publicCount = await getPublicCount();
    await ctx.reply(
        `🤖 *YouTube Bot Active*\n\n` +
        `📹 Your videos: ${publicCount}\n` +
        `📅 Scheduled: ${scheduled.length}\n\n` +
        `✨ *Send me any YouTube link* to schedule it with watermark!\n` +
        `🏷️ Watermark: "${WATERMARK_TEXT}"\n\n` +
        `⚠️ Auto zero-view monitoring is ACTIVE`,
        { parse_mode: 'Markdown', ...menu }
    );
});

// Help command
bot.help(async (ctx) => {
    await ctx.reply(
        `📖 *How to use:*\n\n` +
        `1️⃣ Send any YouTube link\n` +
        `2️⃣ Bot downloads the video\n` +
        `3️⃣ Adds watermark: "${WATERMARK_TEXT}"\n` +
        `4️⃣ Uploads to YOUR channel\n` +
        `5️⃣ Schedules for 7 days\n\n` +
        `📊 Use buttons below for status and controls`,
        { parse_mode: 'Markdown', ...menu }
    );
});

// Handle YouTube URLs - THIS IS THE KEY FIX
bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    
    // Button handlers
    if (text === '📊 STATUS') {
        const scheduled = await getScheduledShorts();
        const publicCount = await getPublicCount();
        const latestPost = await getLatestPost();
        let msg = `📊 *STATUS*\n\n📹 Videos: ${publicCount}\n📅 Scheduled: ${scheduled.length}\n⚠️ Zero tracked: ${zeroViewVideos.size}\n💾 Temp: ${fs.readdirSync(TEMP_DIR).length}`;
        if(latestPost) msg += `\n\n📹 Latest target: ${latestPost.title}`;
        await ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
    }
    else if (text === '📥 SCHEDULE LINK') {
        await ctx.reply(`📥 *Send me a YouTube link* and I'll schedule it to your channel with watermark!\n\n🏷️ Watermark: "${WATERMARK_TEXT}"`, { parse_mode: 'Markdown', ...menu });
    }
    else if (text === '🏷️ WATERMARK') {
        await ctx.reply(`🏷️ *Watermark*\n\nText: ${WATERMARK_TEXT}\nPosition: ${WATERMARK_POSITION}\nSize: ${WATERMARK_FONT_SIZE}px`, { parse_mode: 'Markdown', ...menu });
    }
    else if (text === '⚠️ ZERO STATUS') {
        if(zeroViewVideos.size === 0) {
            await ctx.reply(`✅ No zero-view videos detected`, { ...menu });
        } else {
            let msg = `⚠️ *Zero Videos (${zeroViewVideos.size})*\n\n`;
            for(const [id, info] of zeroViewVideos.entries()) {
                const age = (Date.now() - info.publishTime) / (60 * 60 * 1000);
                msg += `📹 ${info.title.substring(0, 30)}\n   ⏰ ${age.toFixed(1)}h\n\n`;
            }
            await ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
        }
    }
    else if (text === '🔍 CHECK ZERO') {
        await ctx.reply('🔍 Checking...');
        await checkZeroViewVideos();
        await ctx.reply(`✅ Checked\n📊 Tracking: ${zeroViewVideos.size}`, { ...menu });
    }
    else if (text === '📦 SUPPLY') {
        const scheduled = await getScheduledShorts();
        if(!scheduled.length) return ctx.reply('📭 No scheduled videos', { ...menu });
        let msg = `📦 *Scheduled (${scheduled.length})*\n\n`;
        scheduled.forEach((s,i) => msg += `${i+1}. ${s.title.substring(0, 30)}\n   ⏰ ${s.time.toLocaleString()}\n\n`);
        await ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
    }
    else if (text === '📹 LATEST') {
        const latestPost = await getLatestPost();
        if(!latestPost) return ctx.reply(`❌ No latest post`, { ...menu });
        await ctx.reply(`📹 *Latest*\n\n${latestPost.title}\n🔗 ${latestPost.url}`, { parse_mode: 'Markdown', ...menu });
    }
    else if (text === '🔄 REFRESH') {
        scheduledCache = null;
        await ctx.reply('🔄 Refreshed!', { ...menu });
    }
    else if (text === '❓ HELP') {
        await ctx.reply(`📖 Send any YouTube link to schedule it!\n\nExample: https://youtu.be/xxxxx`, { ...menu });
    }
    else {
        // CHECK FOR YOUTUBE URL - FIXED
        const youtubePattern = /(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/i;
        if (youtubePattern.test(text)) {
            const urlMatch = text.match(/https?:\/\/(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/))[^\s]+/i);
            if (urlMatch) {
                await handleScheduleByLink(ctx, urlMatch[0]);
                return;
            }
        }
        
        // If not a URL and not a command
        if (!text.startsWith('/')) {
            await ctx.reply(`❓ Send a YouTube link or use /help`, { ...menu });
        }
    }
});

// Error handler
bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx.reply('❌ An error occurred. Please try again.');
});

// Start bot
bot.launch().then(() => {
    console.log('🤖 Telegram bot started!');
}).catch(err => {
    console.error('Failed to start bot:', err);
});

// ============ START ============
console.log(`\n🚀 Starting YouTube Bot!`);
console.log(`✨ Schedule by Link - Send any YouTube URL`);
console.log(`⚠️ Auto Zero-Views - Checks every 30 minutes`);
console.log(`🏷️ Watermark: "${WATERMARK_TEXT}"`);
console.log(`📤 Channel ID: ${YOUR_CHANNEL_ID}\n`);

// Initial checks
setTimeout(async () => {
    const latest = await getLatestPost();
    if(latest) {
        console.log(`📹 Latest target: "${latest.title}"`);
        lastVideoId = latest.id;
    }
    const scheduled = await getScheduledShorts();
    console.log(`📊 Scheduled videos: ${scheduled.length}`);
}, 2000);

// Start monitors
setInterval(monitor, 30000);
monitor();
startZeroViewMonitoring();

// Keep alive
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});
