const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const ytdl = require('ytdl-core');
const fs = require('fs');
const path = require('path');

// ============ CREDENTIALS ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const TARGET_CHANNEL_HANDLE = '@Tewahdotube-21';
const CLIENT_ID = '635922113777-8c182r05vi5ve32nkqgqc2n5bbldhn18.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04F_QRLOYNyOdCgYIARAAGAQSNwF-L9IrWsT9K73DNxaQfqrmd6fgYUhdeQaFAvSJtB8y3eV6ZA3skvwUfUacaRTr53opx0mrn_k';

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
const ZERO_VIEW_CHECK_DELAY = 2 * 60 * 60 * 1000; // 2 hours
const REUPLOAD_DELAY = 30; // 30 days

// Create temp directory for downloads
const TEMP_DIR = path.join(__dirname, 'temp_downloads');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    console.log(`📁 Created temp directory: ${TEMP_DIR}`);
}

// =========================================

const PORT = process.env.PORT || 3000;
const app = express();
app.get('/', (req, res) => res.send('Bot Running'));
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// Setup OAuth
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
let youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

// Get API key with rotation
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

// Get uploads playlist ID reliably
async function getUploadsPlaylistId(channelId) {
    try {
        const youtube = getYoutube();
        if(!youtube) return null;
        
        const res = await youtube.channels.list({
            part: 'contentDetails',
            id: channelId
        });
        
        if(res.data.items && res.data.items.length > 0) {
            return res.data.items[0].contentDetails.relatedPlaylists.uploads;
        }
        return null;
    } catch(e) {
        console.error('Error getting uploads playlist:', e.message);
        return null;
    }
}

// Get your uploads playlist ID reliably
async function getYourUploadsPlaylistId() {
    try {
        const res = await youtubeAuth.channels.list({
            part: 'contentDetails',
            id: YOUR_CHANNEL_ID
        });
        
        if(res.data.items && res.data.items.length > 0) {
            return res.data.items[0].contentDetails.relatedPlaylists.uploads;
        }
        return null;
    } catch(e) {
        console.error('Error getting your uploads playlist:', e.message);
        return null;
    }
}

// Get latest post from target channel
async function getLatestPost() {
    try {
        const youtube = getYoutube();
        if(!youtube) return null;
        
        const uploadsPlaylistId = await getUploadsPlaylistId(TARGET_CHANNEL_ID);
        if(!uploadsPlaylistId) return null;
        
        const res = await youtube.playlistItems.list({
            part: 'snippet',
            playlistId: uploadsPlaylistId,
            maxResults: 1
        });
        
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

// Get scheduled shorts using reliable playlist ID
async function getScheduledShorts(force=false) {
    const now = Date.now();
    if(!force && scheduledCache && (now - lastCache) < 60000) return scheduledCache;
    
    try {
        const uploadsPlaylistId = await getYourUploadsPlaylistId();
        if(!uploadsPlaylistId) {
            console.error('❌ Could not get your uploads playlist ID');
            return [];
        }
        
        const res = await youtubeAuth.playlistItems.list({ 
            part: 'snippet', 
            playlistId: uploadsPlaylistId, 
            maxResults: 50 
        });
        
        const scheduled = [];
        
        for(let i=0; i<(res.data.items||[]).length; i+=10) {
            const batch = res.data.items.slice(i, i+10);
            const videoIds = batch.map(item => item.snippet.resourceId.videoId);
            const videoRes = await youtubeAuth.videos.list({ 
                part: 'status,snippet', 
                id: videoIds.join(',') 
            });
            
            for(const video of videoRes.data.items||[]) {
                const status = video?.status;
                if(status?.privacyStatus === 'private' && status?.publishAt) {
                    const publishTime = new Date(status.publishAt);
                    if(publishTime > new Date()) {
                        scheduled.push({ 
                            id: video.id, 
                            title: video.snippet.title, 
                            time: publishTime 
                        });
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

// Publish video
async function publishVideo(id, title) {
    try {
        console.log(`📤 Publishing: ${title}`);
        await youtubeAuth.videos.update({ 
            part: 'status', 
            requestBody: { 
                id: id, 
                status: { 
                    privacyStatus: 'public'
                } 
            } 
        });
        console.log(`✅ Published: ${title}`);
        scheduledCache = null;
        return true;
    } catch(e) { 
        console.error(`❌ Failed to publish ${title}:`, e.message);
        return false;
    }
}

// Monitor target channel
async function monitor() {
    if(isProcessing) return;
    isProcessing = true;
    monitorCount++;
    
    try {
        const latestPost = await getLatestPost();
        
        if(!latestPost) {
            console.log('❌ Could not fetch latest post');
            return;
        }
        
        lastPostInfo = latestPost;
        
        console.log(`\n📹 Latest from ${TARGET_CHANNEL_HANDLE}:`);
        console.log(`   ID: ${latestPost.id}`);
        console.log(`   Title: ${latestPost.title}`);
        console.log(`   Time: ${latestPost.publishedAt}`);
        console.log(`   Last known ID: ${lastVideoId || 'none'}`);
        
        if(latestPost.id !== lastVideoId && lastVideoId !== null) {
            console.log(`\n🎬🎬🎬 NEW VIDEO DETECTED! 🎬🎬🎬`);
            console.log(`📹 Target video: "${latestPost.title}"`);
            
            const scheduled = await getScheduledShorts(true);
            
            if(scheduled.length > 0) {
                const toPublish = scheduled[0];
                console.log(`📤 Publishing your video: "${toPublish.title}"`);
                console.log(`📅 Originally scheduled for: ${toPublish.time.toLocaleString()}`);
                
                await publishVideo(toPublish.id, toPublish.title);
                console.log(`✅ Publishing complete!`);
            } else {
                console.log(`❌ No scheduled videos to publish`);
            }
            
            lastVideoId = latestPost.id;
            console.log(`💾 Updated last known video ID to: ${lastVideoId}`);
            
        } else if(lastVideoId === null) {
            console.log(`📝 First run - storing initial video ID: ${latestPost.id}`);
            lastVideoId = latestPost.id;
        } else {
            console.log(`✓ No new videos since last check (Last: ${lastVideoId})`);
        }
        
    } catch(e) { 
        console.error('Monitor error:', e.message);
    } finally { 
        isProcessing = false;
    }
}

// Get public video count
async function getPublicCount() {
    try {
        let count = 0, page = null;
        do {
            const res = await youtubeAuth.search.list({ 
                part: 'snippet', 
                channelId: YOUR_CHANNEL_ID, 
                type: 'video', 
                maxResults: 50, 
                pageToken: page 
            });
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

// Format time difference
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
// ============ ZERO VIEW MONITORING FUNCTIONS ============

// Get all public videos with details
async function getPublicVideosWithDetails() {
    try {
        let allVideos = [];
        let page = null;
        
        do {
            const res = await youtubeAuth.search.list({ 
                part: 'snippet', 
                channelId: YOUR_CHANNEL_ID, 
                type: 'video', 
                maxResults: 50, 
                pageToken: page 
            });
            
            const ids = (res.data.items||[]).map(i => i.id.videoId).filter(id=>id);
            if(ids.length) {
                const videoRes = await youtubeAuth.videos.list({ 
                    part: 'statistics,snippet,status,contentDetails', 
                    id: ids.join(',') 
                });
                
                for(const video of videoRes.data.items||[]) {
                    if(video?.status?.privacyStatus === 'public') {
                        allVideos.push({
                            id: video.id,
                            title: video.snippet.title,
                            viewCount: parseInt(video.statistics.viewCount) || 0,
                            publishedAt: video.snippet.publishedAt,
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
        console.error('Error getting videos:', e.message);
        return []; 
    }
}

// Download video to disk
async function downloadVideoToDisk(videoId, videoTitle) {
    return new Promise(async (resolve, reject) => {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const sanitizedTitle = videoTitle.replace(/[^\w\s]/gi, '').substring(0, 50);
        const timestamp = Date.now();
        const outputPath = path.join(TEMP_DIR, `${videoId}_${timestamp}_${sanitizedTitle}.mp4`);
        
        console.log(`📥 Downloading: "${videoTitle.substring(0, 50)}"`);
        console.log(`🔗 URL: ${videoUrl}`);
        console.log(`💾 Saving to: ${outputPath}`);
        
        try {
            const info = await ytdl.getInfo(videoUrl);
            const format = ytdl.chooseFormat(info.formats, { 
                quality: 'lowest',
                filter: 'audioandvideo' 
            });
            
            if (!format) {
                throw new Error('No suitable format found');
            }
            
            console.log(`📊 Quality: ${format.qualityLabel || 'standard'}`);
            if (format.contentLength) {
                console.log(`📦 Size: ${(parseInt(format.contentLength) / (1024 * 1024)).toFixed(2)} MB`);
            }
            
            // Download with progress tracking
            const writeStream = fs.createWriteStream(outputPath);
            const downloadStream = ytdl(videoUrl, { format: format });
            
            let lastPercent = 0;
            downloadStream.on('progress', (chunkLength, downloaded, total) => {
                if (total) {
                    const percent = (downloaded / total) * 100;
                    if (percent - lastPercent >= 10) {
                        lastPercent = percent;
                        console.log(`📥 Download: ${percent.toFixed(1)}%`);
                    }
                }
            });
            
            downloadStream.pipe(writeStream);
            
            writeStream.on('finish', () => {
                const stats = fs.statSync(outputPath);
                console.log(`✅ Download complete! Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
                resolve(outputPath);
            });
            
            writeStream.on('error', (error) => {
                console.error(`❌ Write error:`, error.message);
                reject(error);
            });
            
            downloadStream.on('error', (error) => {
                console.error(`❌ Download error:`, error.message);
                reject(error);
            });
            
        } catch (error) {
            console.error(`❌ Failed to download:`, error.message);
            reject(error);
        }
    });
}

// Upload video from disk
async function uploadVideoFromDisk(filePath, originalTitle, originalDescription = '') {
    return new Promise(async (resolve, reject) => {
        console.log(`📤 Uploading: ${path.basename(filePath)}`);
        
        const scheduleDate = new Date();
        scheduleDate.setDate(scheduleDate.getDate() + REUPLOAD_DELAY);
        
        const newTitle = `[REUPLOAD] ${originalTitle.substring(0, 80)}`;
        
        try {
            const fileSize = fs.statSync(filePath).size;
            console.log(`📊 Upload size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);
            
            const requestBody = {
                snippet: {
                    title: newTitle,
                    description: `⚠️ AUTO-REUPLOADED VIDEO ⚠️\n\n` +
                                `Original upload: ${new Date().toLocaleString()}\n` +
                                `Reason: 0 views after 2 hours\n` +
                                `This video was downloaded and re-uploaded\n` +
                                `Scheduled for: ${scheduleDate.toLocaleString()}\n\n` +
                                `Original description:\n${originalDescription.substring(0, 500)}`,
                    tags: ['reupload', 'auto-reupload', 'youtube-bot'],
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
                media: {
                    body: fs.createReadStream(filePath),
                    mimeType: 'video/mp4'
                }
            });
            
            console.log(`✅ Upload complete!`);
            console.log(`🆔 New Video ID: ${response.data.id}`);
            console.log(`📅 Scheduled for: ${scheduleDate.toLocaleString()}`);
            
            scheduledCache = null;
            
            resolve({
                videoId: response.data.id,
                title: newTitle,
                scheduleDate: scheduleDate
            });
            
        } catch (error) {
            console.error(`❌ Upload failed:`, error.message);
            reject(error);
        }
    });
}

// Delete original video
async function deleteOriginalVideo(videoId, title) {
    try {
        console.log(`🗑️ Deleting original: "${title.substring(0, 50)}"`);
        await youtubeAuth.videos.delete({ id: videoId });
        console.log(`✅ Original deleted`);
        return true;
    } catch (error) {
        console.error(`❌ Delete failed:`, error.message);
        return false;
    }
}

// Clean up temp file
function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Cleaned up: ${path.basename(filePath)}`);
        }
    } catch (error) {
        console.error(`Cleanup failed:`, error.message);
    }
}

// Clean old temp files (older than 1 hour)
function cleanupOldTempFiles() {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        let deleted = 0;
        
        files.forEach(file => {
            const filePath = path.join(TEMP_DIR, file);
            const stats = fs.statSync(filePath);
            // Delete files older than 1 hour
            if (now - stats.mtimeMs > 60 * 60 * 1000) {
                fs.unlinkSync(filePath);
                deleted++;
            }
        });
        
        if (deleted > 0) {
            console.log(`🗑️ Cleaned up ${deleted} old temp file(s)`);
        }
    } catch (error) {
        console.error(`Cleanup error:`, error.message);
    }
}

// Process zero-view video
async function processZeroViewVideo(videoId, videoInfo) {
    if (isZeroViewProcessing) {
        console.log(`⏳ Already processing, skipping...`);
        return false;
    }
    
    isZeroViewProcessing = true;
    let downloadedFile = null;
    
    try {
        console.log(`\n🔄 PROCESSING ZERO-VIEW VIDEO`);
        console.log(`📹 ID: ${videoId}`);
        console.log(`📌 Title: ${videoInfo.title.substring(0, 60)}`);
        
        // Step 1: Download video
        console.log(`\n📥 STEP 1/3: Downloading video...`);
        downloadedFile = await downloadVideoToDisk(videoId, videoInfo.title);
        
        // Step 2: Upload video
        console.log(`\n📤 STEP 2/3: Uploading to YouTube...`);
        const uploadResult = await uploadVideoFromDisk(downloadedFile, videoInfo.title, videoInfo.description);
        
        // Step 3: Delete original
        console.log(`\n🗑️ STEP 3/3: Deleting original video...`);
        await deleteOriginalVideo(videoId, videoInfo.title);
        
        // Send success notification
        const successMsg = `✅ *Zero-View Video Processed*\n\n` +
            `📹 *Video:* ${videoInfo.title.substring(0, 50)}\n` +
            `🆔 *New ID:* ${uploadResult.videoId}\n` +
            `📅 *Scheduled:* ${uploadResult.scheduleDate.toLocaleString()}\n` +
            `⚠️ *Reason:* 0 views after ${videoInfo.ageHours.toFixed(1)} hours`;
        
        try {
            await bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID || 'YOUR_CHAT_ID', successMsg, { parse_mode: 'Markdown' });
        } catch(teleError) {}
        
        console.log(`\n✅ Processing complete!`);
        return true;
        
    } catch (error) {
        console.error(`\n❌ Processing failed:`, error.message);
        
        const errorMsg = `❌ *Zero-View Processing Failed*\n\n` +
            `📹 ${videoInfo.title.substring(0, 50)}\n` +
            `❌ Error: ${error.message}`;
        
        try {
            await bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID || 'YOUR_CHAT_ID', errorMsg, { parse_mode: 'Markdown' });
        } catch(teleError) {}
        
        return false;
        
    } finally {
        isZeroViewProcessing = false;
        if (downloadedFile) {
            cleanupTempFile(downloadedFile);
        }
    }
}

// Check for zero-view videos
async function checkZeroViewVideos() {
    try {
        console.log(`\n🔍 Checking for zero-view videos...`);
        const videos = await getPublicVideosWithDetails();
        const now = new Date();
        
        for(const video of videos) {
            const ageInMs = now - video.publishTime;
            const ageInHours = ageInMs / (60 * 60 * 1000);
            
            if(video.viewCount === 0 && ageInMs >= ZERO_VIEW_CHECK_DELAY && !zeroViewVideos.has(video.id)) {
                console.log(`⚠️ ZERO VIEW: "${video.title.substring(0, 50)}" (${ageInHours.toFixed(1)} hours old)`);
                
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
                console.log(`⚠️⚠️⚠️ ZERO VIEW WARNING ⚠️⚠️⚠️`);
                console.log(`📹 "${info.title.substring(0, 50)}"`);
                console.log(`🔄 Will download and re-upload in 5 minutes...`);
                
                info.warned = true;
                zeroViewVideos.set(videoId, info);
                
                try {
                    await bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID || 'YOUR_CHAT_ID', 
                        `⚠️ *Zero View Detected*\n\n` +
                        `📹 *${info.title.substring(0, 50)}*\n` +
                        `⏰ ${info.ageHours.toFixed(1)} hours old\n` +
                        `🔄 Downloading & re-uploading in 5 minutes`, 
                        { parse_mode: 'Markdown' });
                } catch(teleError) {}
            }
        }
        
        for(const [videoId, info] of zeroViewVideos.entries()) {
            if(info.warned) {
                const video = videos.find(v => v.id === videoId);
                if(video && video.viewCount === 0) {
                    const timeSinceCheck = now - info.checkedAt;
                    
                    if(timeSinceCheck >= 5 * 60 * 1000) {
                        console.log(`\n🚨 Processing: "${info.title.substring(0, 50)}"`);
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
            console.log(`\n📊 Monitoring: ${zeroViewVideos.size} video(s)`);
        } else {
            console.log(`✅ No zero-view videos tracked`);
        }
        
    } catch(e) {
        console.error('Check error:', e.message);
    }
}

// Start zero-view monitoring
function startZeroViewMonitoring() {
    console.log(`\n🔍 Zero-View Monitor Active (Download to Disk Mode)`);
    console.log(`   Detection: 2 hours of 0 views`);
    console.log(`   Action: Download → Re-upload → Delete original`);
    console.log(`   Schedule: ${REUPLOAD_DELAY} days later`);
    console.log(`   Temp directory: ${TEMP_DIR}`);
    console.log(`   Auto-cleanup: Files older than 1 hour deleted\n`);
    
    // Clean old temp files every hour
    setInterval(cleanupOldTempFiles, 60 * 60 * 1000);
    
    setTimeout(() => checkZeroViewVideos(), 60000);
    setInterval(checkZeroViewVideos, 30 * 60 * 1000);
}

// ============ TELEGRAM BOT ============
const bot = new Telegraf(BOT_TOKEN);
const menu = { 
    reply_markup: { 
        keyboard: [['📊 STATUS', '📦 SUPPLY', '📹 LATEST POST'], 
                   ['📊 ZERO VIEWS', '🔍 CHECK ZERO', '🔄 REFRESH']], 
        resize_keyboard: true 
    } 
};

bot.command('start', async (ctx) => {
    const scheduled = await getScheduledShorts();
    const publicCount = await getPublicCount();
    const latestPost = await getLatestPost();
    
    let msg = `🤖 *YouTube Timing Bot*\n\n` +
        `📹 Your videos: ${publicCount}\n` +
        `📅 Scheduled: ${scheduled.length}\n` +
        `🎯 Monitoring: ${TARGET_CHANNEL_HANDLE}\n` +
        `🟢 Status: Active\n` +
        `⚠️ Zero-view: Active (download & re-upload)\n\n`;
    
    if(latestPost) {
        msg += `*📹 Latest post from ${TARGET_CHANNEL_HANDLE}:*\n` +
               `📌 *${latestPost.title}*\n` +
               `⏰ ${getTimeAgo(latestPost.publishedAt)}\n` +
               `🔗 [Watch on YouTube](${latestPost.url})\n\n`;
    }
    
    if(scheduled.length > 0) {
        msg += `📋 *Your next scheduled:*\n${scheduled[0].title}\n⏰ ${scheduled[0].time.toLocaleString()}`;
    } else {
        msg += `📭 *No scheduled shorts*`;
    }
    
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu, disable_web_page_preview: true });
});

bot.hears('📊 STATUS', async (ctx) => {
    const scheduled = await getScheduledShorts();
    const publicCount = await getPublicCount();
    const latestPost = await getLatestPost();
    
    let msg = `📊 *STATUS*\n\n` +
        `📹 Your public videos: ${publicCount}\n` +
        `📅 Scheduled shorts: ${scheduled.length}\n` +
        `🎯 Target: ${TARGET_CHANNEL_HANDLE}\n` +
        `🔄 Checks: ${monitorCount}\n` +
        `💾 Last known video: ${lastVideoId ? lastVideoId.substring(0,15)+'...' : 'none'}\n` +
        `⚠️ Zero-view tracked: ${zeroViewVideos.size}\n` +
        `🔄 Processor: ${isZeroViewProcessing ? 'BUSY' : 'IDLE'}\n` +
        `💾 Temp files: ${fs.readdirSync(TEMP_DIR).length}\n\n`;
    
    if(latestPost) {
        msg += `*Latest target post:*\n` +
               `📌 ${latestPost.title}\n` +
               `⏰ ${getTimeAgo(latestPost.publishedAt)}`;
    }
    
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📹 LATEST POST', async (ctx) => {
    const latestPost = await getLatestPost();
    
    if(!latestPost) {
        return ctx.reply(`❌ Could not fetch latest post from ${TARGET_CHANNEL_HANDLE}`, { ...menu });
    }
    
    let msg = `*📹 Latest post from ${TARGET_CHANNEL_HANDLE}*\n\n` +
              `*Title:* ${latestPost.title}\n` +
              `*Published:* ${getTimeAgo(latestPost.publishedAt)}\n` +
              `*Time:* ${new Date(latestPost.publishedAt).toLocaleString()}\n\n` +
              `🔗 ${latestPost.url}`;
    
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu, disable_web_page_preview: false });
});

bot.hears('📦 SUPPLY', async (ctx) => {
    const scheduled = await getScheduledShorts();
    if(!scheduled.length) return ctx.reply('📭 No scheduled shorts\n\nUpload a Short and choose "Schedule"', { ...menu });
    let msg = `📦 *YOUR SUPPLY (${scheduled.length})*\n\n`;
    scheduled.forEach((s,i) => msg += `${i+1}. ${s.title}\n   ⏰ ${s.time.toLocaleString()}\n\n`);
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('🔄 REFRESH', async (ctx) => {
    scheduledCache = null;
    ctx.reply('🔄 Refreshing data...');
    const scheduled = await getScheduledShorts(true);
    const latestPost = await getLatestPost();
    let msg = `✅ Refreshed\n📅 Scheduled: ${scheduled.length}\n`;
    if(latestPost) {
        msg += `\n📹 Latest from ${TARGET_CHANNEL_HANDLE}:\n${latestPost.title}\n⏰ ${getTimeAgo(latestPost.publishedAt)}`;
    }
    ctx.reply(msg, { ...menu });
});

bot.hears('📊 ZERO VIEWS', async (ctx) => {
    if(zeroViewVideos.size === 0) {
        return ctx.reply('✅ No zero-view videos being tracked', { ...menu });
    }
    
    let msg = `⚠️ *Zero-View Videos (${zeroViewVideos.size})*\n\n`;
    let index = 1;
    for(const [id, info] of zeroViewVideos.entries()) {
        const ageHours = (Date.now() - info.publishTime) / (60 * 60 * 1000);
        msg += `${index}. ${info.title.substring(0, 35)}\n`;
        msg += `   ⏰ ${ageHours.toFixed(1)} hours old\n`;
        msg += `   Status: ${info.warned ? '⏳ Downloading/Uploading' : '🔍 Watching'}\n\n`;
        index++;
    }
    msg += `💡 Videos will be: Downloaded → Re-uploaded → Scheduled for ${REUPLOAD_DELAY} days → Original deleted`;
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('🔍 CHECK ZERO', async (ctx) => {
    if(isZeroViewProcessing) return ctx.reply('⏳ Processing a video, try again in a moment', { ...menu });
    ctx.reply('🔍 Checking for zero-view videos...');
    await checkZeroViewVideos();
    ctx.reply(`✅ Check complete\n📊 Tracking: ${zeroViewVideos.size} video(s)`, { ...menu });
});

bot.launch();
console.log('🤖 Telegram bot started');

// ============ START ============
console.log(`\n🚀 Starting YouTube Timing Bot...`);
console.log(`📤 Your Channel ID: ${YOUR_CHANNEL_ID}`);
console.log(`🎯 Target: ${TARGET_CHANNEL_HANDLE} (${TARGET_CHANNEL_ID})`);
console.log(`🔑 Loaded ${API_KEYS.length} API keys\n`);

// Initial check
setTimeout(async () => {
    const latest = await getLatestPost();
    if(latest) {
        console.log(`📹 Latest from target: "${latest.title}"`);
        console.log(`🆔 Video ID: ${latest.id}`);
        lastVideoId = latest.id;
        console.log(`💾 Stored as last known video ID`);
    } else {
        console.log(`❌ Cannot access target channel`);
    }
    
    const scheduled = await getScheduledSh
