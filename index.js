const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

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

let currentKey = 0;
let keyUsage = [0, 0, 0];
let keyReset = [Date.now(), Date.now(), Date.now()];
let lastVideoId = null;
let monitorCount = 0;

// Store videos on server
let supplyVideos = [];
let activeVideo = null;
let videoFileCache = new Map();

// Upload queue and limits
let uploadQueue = [];
let isUploading = false;
let dailyUploadCount = 0;
let lastUploadReset = Date.now();
const MAX_DAILY_UPLOADS = 10;
const UPLOAD_COOLDOWN_MS = 300000; // 5 minutes

const MAX_CACHE_SIZE_MB = 500;
const VIEW_THRESHOLD = 10;
const VIEW_CHECK_INTERVAL = 60 * 60 * 1000;

// Cache for API responses
let channelCache = null;
let channelCacheTime = 0;
let lastTargetCheck = 0;
let targetCheckCount = 0;
let viewsCache = new Map();

const TEMP_DIR = '/tmp/youtube_bot';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
const app = express();

app.get('/', (req, res) => res.send('Bot Running'));
app.get('/health', (req, res) => {
    const totalSize = getTotalCacheSize();
    const supplySize = getSupplySize();
    const now = Date.now();
    if (now - lastUploadReset > 86400000) {
        dailyUploadCount = 0;
        lastUploadReset = now;
    }
    res.json({ 
        status: 'ok', 
        supplyCount: supplyVideos.length,
        supplySizeMB: supplySize.toFixed(2),
        activeVideo: activeVideo?.title || 'None',
        cachedVideos: videoFileCache.size,
        totalCacheSizeMB: totalSize.toFixed(2),
        maxCacheSizeMB: MAX_CACHE_SIZE_MB,
        dailyUploads: dailyUploadCount,
        maxDailyUploads: MAX_DAILY_UPLOADS,
        uploadQueueSize: uploadQueue.length,
        monitorCount,
        apiKeyUsage: keyUsage,
        targetCheckCount
    });
});

app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// Setup OAuth
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
let youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

// Get total cache size
function getTotalCacheSize() {
    let totalSize = 0;
    for (const [videoId, data] of videoFileCache) {
        if (data.filePath && fs.existsSync(data.filePath)) {
            const stats = fs.statSync(data.filePath);
            totalSize += stats.size;
        }
    }
    return totalSize / (1024 * 1024);
}

// Get supply size only
function getSupplySize() {
    let totalSize = 0;
    for (const video of supplyVideos) {
        if (video.filePath && fs.existsSync(video.filePath)) {
            const stats = fs.statSync(video.filePath);
            totalSize += stats.size;
        }
    }
    return totalSize / (1024 * 1024);
}

// Check if cache is full
function isCacheFull() {
    const totalSize = getTotalCacheSize();
    return totalSize >= MAX_CACHE_SIZE_MB;
}

// Get available space
function getAvailableSpaceMB() {
    const totalSize = getTotalCacheSize();
    return MAX_CACHE_SIZE_MB - totalSize;
}

// Check daily upload limit
function canUploadToday() {
    const now = Date.now();
    if (now - lastUploadReset > 86400000) {
        dailyUploadCount = 0;
        lastUploadReset = now;
    }
    return dailyUploadCount < MAX_DAILY_UPLOADS;
}

// Clean up old videos
async function cleanupCache() {
    const totalSize = getTotalCacheSize();
    if (totalSize < MAX_CACHE_SIZE_MB * 0.9) return;
    
    console.log(`⚠️ Cache ${totalSize.toFixed(2)}MB/${MAX_CACHE_SIZE_MB}MB - Cleaning up...`);
    
    const videos = Array.from(videoFileCache.entries())
        .map(([id, data]) => ({
            id: id,
            ...data,
            lastAccessed: data.lastAccessed || data.addedTime || Date.now()
        }))
        .sort((a, b) => a.lastAccessed - b.lastAccessed);
    
    let freedSpace = 0;
    let removedCount = 0;
    for (const video of videos) {
        if (getTotalCacheSize() < MAX_CACHE_SIZE_MB * 0.8) break;
        
        const isInSupply = supplyVideos.some(v => v.id === video.id);
        const isActive = activeVideo && activeVideo.id === video.id;
        const isInQueue = uploadQueue.some(v => v.videoId === video.id);
        
        if (!isInSupply && !isActive && !isInQueue) {
            if (fs.existsSync(video.filePath)) {
                const stats = fs.statSync(video.filePath);
                freedSpace += stats.size / (1024 * 1024);
                fs.unlinkSync(video.filePath);
                console.log(`🗑️ Removed old video: ${video.title}`);
                removedCount++;
            }
            videoFileCache.delete(video.id);
        }
    }
    
    console.log(`✅ Freed ${freedSpace.toFixed(2)}MB (removed ${removedCount} videos)`);
}

// Process upload queue with cooldown
async function processUploadQueue() {
    if (isUploading || uploadQueue.length === 0) return;
    if (!canUploadToday()) {
        console.log(`⏳ Daily upload limit reached (${MAX_DAILY_UPLOADS}). Waiting for reset...`);
        return;
    }
    
    isUploading = true;
    
    while (uploadQueue.length > 0 && canUploadToday()) {
        const task = uploadQueue[0];
        
        try {
            console.log(`📤 Processing upload: ${task.title}`);
            
            const result = await uploadToYouTube(task.filePath, task.title, task.description, task.hashtags);
            
            dailyUploadCount++;
            
            console.log(`✅ Uploaded: ${task.title} (${dailyUploadCount}/${MAX_DAILY_UPLOADS} today)`);
            console.log(`🆔 New Video ID: ${result.id}`);
            
            await addToSupply(result.id, task.title, task.hashtags, task.description, task.filePath, task.fileSize);
            
            uploadQueue.shift();
            
            if (uploadQueue.length > 0) {
                console.log(`⏳ Waiting ${UPLOAD_COOLDOWN_MS/1000} seconds before next upload...`);
                await new Promise(resolve => setTimeout(resolve, UPLOAD_COOLDOWN_MS));
            }
            
        } catch(error) {
            console.error(`❌ Upload failed for ${task.title}:`, error.message);
            
            if (error.message.includes('exceeded the number of videos')) {
                console.log(`⏳ Daily limit reached. Waiting 1 hour...`);
                await new Promise(resolve => setTimeout(resolve, 3600000));
            } else {
                uploadQueue.push(uploadQueue.shift());
                console.log(`⏳ Retrying later...`);
                await new Promise(resolve => setTimeout(resolve, 60000));
            }
        }
    }
    
    isUploading = false;
    
    if (uploadQueue.length > 0) {
        console.log(`📊 ${uploadQueue.length} videos remaining in upload queue`);
    }
}

// Optimized API key management
function getApiKey() {
    const now = Date.now();
    const ONE_DAY = 86400000;
    
    for(let i = 0; i < API_KEYS.length; i++) {
        if(now - keyReset[i] > ONE_DAY) { 
            keyUsage[i] = 0; 
            keyReset[i] = now; 
            console.log(`🔄 Reset quota for key ${i+1}`);
        }
        
        if(keyUsage[i] < 9000) {
            currentKey = i;
            return API_KEYS[i];
        }
    }
    
    console.error('⚠️ ALL API KEYS EXHAUSTED! Waiting for daily reset...');
    return null;
}

function getYoutube() { 
    const key = getApiKey();
    if (!key) return null;
    keyUsage[currentKey] += 1;
    return google.youtube({ version: 'v3', auth: key });
}

// Extract title and hashtags from caption
function extractVideoInfo(caption) {
    let title = '';
    let hashtags = [];
    
    if (!caption) return { title: `Video ${Date.now()}`, hashtags: [] };
    
    const lines = caption.split('\n');
    
    for (let line of lines) {
        line = line.trim();
        if (line && !line.startsWith('http') && !line.includes('@')) {
            const hashtagRegex = /#[\w\u00c0-\u00ff]+/g;
            const foundHashtags = line.match(hashtagRegex);
            if (foundHashtags) {
                hashtags.push(...foundHashtags);
            }
            
            if (!title && !line.startsWith('#')) {
                title = line.replace(hashtagRegex, '').trim();
            }
        }
    }
    
    return {
        title: title || `Video ${Date.now()}`,
        hashtags: hashtags,
        description: caption
    };
}

// Download video from Telegram
async function downloadAndSaveVideo(fileId, botInstance, videoId) {
    const availableSpace = getAvailableSpaceMB();
    if (availableSpace < 10) {
        await cleanupCache();
    }
    
    if (getAvailableSpaceMB() < 10) {
        throw new Error(`Cache full (${MAX_CACHE_SIZE_MB}MB). Please wait.`);
    }
    
    const fileLink = await botInstance.telegram.getFileLink(fileId);
    const tempPath = path.join(TEMP_DIR, `${videoId}.mp4`);
    
    const response = await axios({
        method: 'GET',
        url: fileLink.href,
        responseType: 'stream'
    });
    
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(tempPath));
        writer.on('error', reject);
    });
}

// Upload to YouTube
async function uploadToYouTube(filePath, title, description, hashtags) {
    if (!canUploadToday()) {
        throw new Error(`Daily upload limit reached (${MAX_DAILY_UPLOADS}). Please try tomorrow.`);
    }
    
    let fileStream = null;
    
    try {
        const tags = hashtags.map(tag => tag.replace('#', ''));
        
        const requestBody = {
            snippet: {
                title: title.substring(0, 100),
                description: description.substring(0, 5000),
                tags: tags,
                categoryId: '22'
            },
            status: {
                privacyStatus: 'private',
                selfDeclaredMadeForKids: false
            }
        };
        
        fileStream = fs.createReadStream(filePath);
        
        const response = await youtubeAuth.videos.insert({
            part: 'snippet,status',
            requestBody: requestBody,
            media: { body: fileStream }
        });
        
        if (fileStream) fileStream.close();
        
        return {
            id: response.data.id,
            title: title
        };
        
    } catch(error) {
        if (fileStream) fileStream.close();
        throw error;
    }
}

// Update video privacy
async function updateVideoPrivacy(videoId, privacyStatus) {
    try {
        await youtubeAuth.videos.update({
            part: 'status',
            requestBody: {
                id: videoId,
                status: { privacyStatus: privacyStatus }
            }
        });
        return true;
    } catch(error) {
        console.error(`Failed to update privacy: ${videoId}`, error.message);
        return false;
    }
}

// Get video views with cache
async function getVideoViews(videoId) {
    if (viewsCache.has(videoId)) {
        const cached = viewsCache.get(videoId);
        if (Date.now() - cached.time < 600000) {
            return cached.views;
        }
    }
    
    try {
        const youtube = getYoutube();
        if (!youtube) return 0;
        
        const response = await youtube.videos.list({
            part: 'statistics',
            id: videoId
        });
        
        const views = parseInt(response.data.items?.[0]?.statistics?.viewCount || 0);
        viewsCache.set(videoId, { views: views, time: Date.now() });
        
        return views;
    } catch(error) {
        return 0;
    }
}

// Add video to supply
async function addToSupply(videoId, title, hashtags, description, filePath, fileSize) {
    const availableSpace = getAvailableSpaceMB();
    if (fileSize > availableSpace) {
        await cleanupCache();
        const newAvailable = getAvailableSpaceMB();
        if (fileSize > newAvailable) {
            throw new Error(`Not enough space! Need ${fileSize.toFixed(2)}MB`);
        }
    }
    
    supplyVideos.push({
        id: videoId,
        title: title,
        hashtags: hashtags,
        description: description,
        filePath: filePath,
        fileSize: fileSize,
        status: 'scheduled',
        addedTime: Date.now(),
        resupplyCount: 0,
        videoAttempts: 0
    });
    
    videoFileCache.set(videoId, {
        videoId: videoId,
        title: title,
        hashtags: hashtags,
        description: description,
        filePath: filePath,
        fileSize: fileSize,
        inSupply: true,
        addedTime: Date.now(),
        lastAccessed: Date.now(),
        videoAttempts: 0
    });
    
    const totalSize = getTotalCacheSize();
    const supplySize = getSupplySize();
    console.log(`📦 Added to supply: ${title} (${fileSize.toFixed(2)}MB)`);
    console.log(`📊 Daily uploads: ${dailyUploadCount}/${MAX_DAILY_UPLOADS}`);
}

// Get next video from supply
function getNextFromSupply() {
    if (supplyVideos.length === 0) return null;
    return supplyVideos.shift();
}

function getSupplyStats() {
    const count = supplyVideos.length;
    const size = getSupplySize();
    return { count, size };
        }
// Re-upload video INSTANTLY when target channel uploads
async function reuploadVideoForTarget(videoData) {
    console.log(`🔄 Re-uploading for target upload: ${videoData.title}`);
    
    try {
        const cachedVideo = videoFileCache.get(videoData.id);
        
        if (!cachedVideo || !fs.existsSync(cachedVideo.filePath)) {
            console.log(`❌ Video file not found: ${videoData.title}`);
            return null;
        }
        
        if (!canUploadToday()) {
            console.log(`⏳ Daily limit reached, adding to queue for later...`);
            uploadQueue.push({
                videoId: `reup_${Date.now()}`,
                filePath: cachedVideo.filePath,
                title: `${videoData.title} (Re-up ${(videoData.videoAttempts || 0) + 1})`,
                hashtags: videoData.hashtags || [],
                description: videoData.description || '',
                fileSize: cachedVideo.fileSize || 0,
                isReupload: true,
                originalId: videoData.id,
                videoAttempts: (videoData.videoAttempts || 0) + 1
            });
            return null;
        }
        
        const newAttempt = (videoData.videoAttempts || 0) + 1;
        const newTitle = `${videoData.title} (${newAttempt})`;
        
        const result = await uploadToYouTube(
            cachedVideo.filePath,
            newTitle,
            videoData.description || '',
            videoData.hashtags || []
        );
        
        dailyUploadCount++;
        
        console.log(`✅ Re-uploaded as new video: ${newTitle}`);
        console.log(`🆔 New Video ID: ${result.id}`);
        console.log(`📊 Daily uploads: ${dailyUploadCount}/${MAX_DAILY_UPLOADS}`);
        
        await addToSupply(
            result.id,
            newTitle,
            videoData.hashtags || [],
            videoData.description || '',
            cachedVideo.filePath,
            cachedVideo.fileSize || 0
        );
        
        const newCached = videoFileCache.get(result.id);
        if (newCached) {
            newCached.videoAttempts = newAttempt;
            videoFileCache.set(result.id, newCached);
        }
        
        if (videoData.id !== result.id) {
            videoFileCache.delete(videoData.id);
        }
        
        return result;
        
    } catch(error) {
        console.error(`❌ Re-upload failed:`, error.message);
        
        if (error.message.includes('exceeded the number of videos')) {
            const cachedVideo = videoFileCache.get(videoData.id);
            if (cachedVideo) {
                uploadQueue.push({
                    videoId: `reup_${Date.now()}`,
                    filePath: cachedVideo.filePath,
                    title: `${videoData.title} (Re-up ${(videoData.videoAttempts || 0) + 1})`,
                    hashtags: videoData.hashtags || [],
                    description: videoData.description || '',
                    fileSize: cachedVideo.fileSize || 0,
                    isReupload: true,
                    originalId: videoData.id,
                    videoAttempts: (videoData.videoAttempts || 0) + 1
                });
            }
        }
        return null;
    }
}

// Monitor active video views
async function monitorActiveVideoViews() {
    if (!activeVideo) return;
    
    const timeElapsed = Date.now() - activeVideo.publishTime;
    
    if (timeElapsed >= VIEW_CHECK_INTERVAL && activeVideo.status === 'active') {
        console.log(`\n📊 Checking views: ${activeVideo.title}`);
        
        const viewCount = await getVideoViews(activeVideo.id);
        console.log(`   Views: ${viewCount} (Need ${VIEW_THRESHOLD}+)`);
        
        if (viewCount < VIEW_THRESHOLD) {
            console.log(`⚠️ Low views! Will re-upload when target channel uploads next time`);
            
            const cachedVideo = videoFileCache.get(activeVideo.id);
            
            if (cachedVideo && fs.existsSync(cachedVideo.filePath)) {
                supplyVideos.push({
                    id: activeVideo.id,
                    title: activeVideo.title,
                    hashtags: activeVideo.hashtags || [],
                    description: activeVideo.description || '',
                    filePath: cachedVideo.filePath,
                    fileSize: cachedVideo.fileSize || 0,
                    status: 'waiting_reupload',
                    addedTime: Date.now(),
                    resupplyCount: (activeVideo.resupplyCount || 0) + 1,
                    videoAttempts: (activeVideo.videoAttempts || 0) + 1
                });
                
                cachedVideo.inSupply = true;
                cachedVideo.lastAccessed = Date.now();
                cachedVideo.videoAttempts = (activeVideo.videoAttempts || 0) + 1;
                videoFileCache.set(activeVideo.id, cachedVideo);
                
                console.log(`🔄 Video marked for re-upload on next target channel upload`);
                console.log(`📦 Attempt ${cachedVideo.videoAttempts} waiting in supply`);
            }
            
            activeVideo = null;
            
        } else {
            console.log(`✅ Good views! Video stays public.`);
            activeVideo.status = 'completed';
            
            const cachedVideo = videoFileCache.get(activeVideo.id);
            if (cachedVideo && fs.existsSync(cachedVideo.filePath)) {
                fs.unlinkSync(cachedVideo.filePath);
                videoFileCache.delete(activeVideo.id);
                console.log(`🗑️ Removed from server (successful)`);
            }
            
            activeVideo = null;
        }
    }
}

// Monitor target channel
async function monitorTargetChannel() {
    const now = Date.now();
    if (now - lastTargetCheck < 30000) return;
    lastTargetCheck = now;
    targetCheckCount++;
    
    try {
        if (!channelCache || (now - channelCacheTime > 3600000)) {
            const youtube = getYoutube();
            if (!youtube) return;
            
            const res = await youtube.channels.list({
                part: 'contentDetails',
                id: TARGET_CHANNEL_ID
            });
            
            channelCache = res.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
            channelCacheTime = now;
        }
        
        if (!channelCache) return;
        
        const youtube = getYoutube();
        if (!youtube) return;
        
        const res = await youtube.playlistItems.list({
            part: 'snippet',
            playlistId: channelCache,
            maxResults: 1
        });
        
        if (!res.data.items?.length) return;
        
        const latestVideo = {
            id: res.data.items[0].snippet.resourceId.videoId,
            title: res.data.items[0].snippet.title
        };
        
        if (latestVideo.id !== lastVideoId && lastVideoId !== null) {
            console.log(`\n🎬 Target channel uploaded: ${latestVideo.title}`);
            
            const reuploadCandidates = supplyVideos.filter(v => v.status === 'waiting_reupload');
            
            if (reuploadCandidates.length > 0) {
                const videoToReupload = reuploadCandidates[0];
                console.log(`🔄 Found video waiting for re-upload: ${videoToReupload.title}`);
                
                const index = supplyVideos.indexOf(videoToReupload);
                if (index > -1) {
                    supplyVideos.splice(index, 1);
                }
                
                const newVideo = await reuploadVideoForTarget(videoToReupload);
                
                if (newVideo) {
                    console.log(`✅ Re-uploaded successfully: ${newVideo.title}`);
                    console.log(`🆔 New Video ID: ${newVideo.id}`);
                    
                    await updateVideoPrivacy(newVideo.id, 'public');
                    
                    activeVideo = {
                        ...newVideo,
                        publishTime: Date.now(),
                        status: 'active'
                    };
                    
                    console.log(`📤 Now public - will check views in 1 hour`);
                }
            } else {
                const nextVideo = getNextFromSupply();
                
                if (nextVideo) {
                    console.log(`📤 Publishing from supply: ${nextVideo.title}`);
                    await updateVideoPrivacy(nextVideo.id, 'public');
                    
                    activeVideo = {
                        ...nextVideo,
                        publishTime: Date.now(),
                        status: 'active'
                    };
                    
                    if (videoFileCache.has(nextVideo.id)) {
                        const cached = videoFileCache.get(nextVideo.id);
                        cached.inSupply = false;
                        cached.lastAccessed = Date.now();
                        videoFileCache.set(nextVideo.id, cached);
                    }
                    
                    console.log(`✅ Now public - will check views in 1 hour`);
                } else {
                    console.log(`📭 No videos in supply to publish`);
                }
            }
            
            lastVideoId = latestVideo.id;
        } else if (lastVideoId === null) {
            lastVideoId = latestVideo.id;
            console.log(`📝 Initialized`);
        }
        
    } catch(error) {
        console.error('Monitor error:', error.message);
    }
}

// Process new video
async function processNewVideo(videoFileId, title, hashtags, description, ctx, messageId, botInstance) {
    const tempVideoId = `temp_${Date.now()}`;
    let tempFile = null;
    
    try {
        await ctx.telegram.editMessageText(
            ctx.chat.id, messageId, null,
            `📥 Downloading: ${title}`
        );
        
        tempFile = await downloadAndSaveVideo(videoFileId, botInstance, tempVideoId);
        
        const stats = fs.statSync(tempFile);
        const fileSizeMB = stats.size / (1024 * 1024);
        
        if (fileSizeMB > MAX_CACHE_SIZE_MB) {
            throw new Error(`Video too large (${fileSizeMB.toFixed(2)}MB).`);
        }
        
        const remainingUploads = MAX_DAILY_UPLOADS - dailyUploadCount;
        
        await ctx.telegram.editMessageText(
            ctx.chat.id, messageId, null,
            `📤 Uploading to YouTube...\n` +
            `📊 Daily uploads remaining: ${remainingUploads}`
        );
        
        if (canUploadToday()) {
            const result = await uploadToYouTube(tempFile, title, description, hashtags);
            dailyUploadCount++;
            
            const finalPath = path.join(TEMP_DIR, `${result.id}.mp4`);
            fs.renameSync(tempFile, finalPath);
            
            await addToSupply(result.id, title, hashtags, description, finalPath, fileSizeMB);
            
            const totalSize = getTotalCacheSize();
            const supplySize = getSupplySize();
            
            await ctx.telegram.editMessageText(
                ctx.chat.id, messageId, null,
                `✅ **Added to Supply!**\n\n` +
                `📹 ${title}\n` +
                `📦 Supply: ${supplyVideos.length} videos (${supplySize.toFixed(2)}MB)\n` +
                `💾 Cache: ${totalSize.toFixed(2)}MB/${MAX_CACHE_SIZE_MB}MB\n` +
                `📊 Daily: ${dailyUploadCount}/${MAX_DAILY_UPLOADS}\n` +
                `🎯 Will publish when ${TARGET_CHANNEL_HANDLE} uploads\n` +
                `🔄 Will re-upload as NEW video if under ${VIEW_THRESHOLD} views`,
                { parse_mode: 'Markdown' }
            );
        } else {
            uploadQueue.push({
                videoId: tempVideoId,
                filePath: tempFile,
                title: title,
                hashtags: hashtags,
                description: description,
                fileSize: fileSizeMB,
                addedTime: Date.now(),
                isReupload: false
            });
            
            await ctx.telegram.editMessageText(
                ctx.chat.id, messageId, null,
                `⏳ **Added to Upload Queue!**\n\n` +
                `📹 ${title}\n` +
                `📊 Position: ${uploadQueue.length}\n` +
                `📈 Daily limit reached: ${dailyUploadCount}/${MAX_DAILY_UPLOADS}\n` +
                `⏰ Will upload when limit resets`,
                { parse_mode: 'Markdown' }
            );
        }
        
    } catch(error) {
        await ctx.telegram.editMessageText(
            ctx.chat.id, messageId, null,
            `❌ Failed: ${title}\nError: ${error.message}`
        );
        if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
}

async function refreshToken() {
    try {
        await oauth2Client.refreshAccessToken();
        youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
        console.log('✅ Token refreshed');
    } catch(e) {
        console.error('❌ Token refresh failed:', e.message);
    }
}

// ============ TELEGRAM BOT ============
const bot = new Telegraf(BOT_TOKEN);

const menu = { 
    reply_markup: { 
        keyboard: [['📊 STATUS', '📦 SUPPLY'], ['🔄 REFRESH', '📥 QUEUE']], 
        resize_keyboard: true 
    } 
};

// Handle video messages
bot.on('video', async (ctx) => {
    const video = ctx.message.video;
    const caption = ctx.message.caption || '';
    const { title, hashtags, description } = extractVideoInfo(caption);
    
    const fileSizeMB = video.file_size / (1024 * 1024);
    
    if (fileSizeMB > MAX_CACHE_SIZE_MB) {
        return ctx.reply(`❌ Video too large. Maximum ${MAX_CACHE_SIZE_MB}MB.`);
    }
    
    const availableSpace = getAvailableSpaceMB();
    if (fileSizeMB > availableSpace) {
        await cleanupCache();
        const newAvailable = getAvailableSpaceMB();
        if (fileSizeMB > newAvailable) {
            return ctx.reply(`❌ Not enough space! Need ${fileSizeMB.toFixed(2)}MB, available ${newAvailable.toFixed(2)}MB.`);
        }
    }
    
    const msg = await ctx.reply(
        `🔄 Processing: ${title}\n📦 ${fileSizeMB.toFixed(2)} MB\n📊 Daily uploads: ${dailyUploadCount}/${MAX_DAILY_UPLOADS}`,
        { parse_mode: 'Markdown' }
    );
    
    await processNewVideo(video.file_id, title, hashtags, description, ctx, msg.message_id, bot);
});

bot.command('start', async (ctx) => {
    const totalSize = getTotalCacheSize();
    const supplySize = getSupplySize();
    const remainingUploads = MAX_DAILY_UPLOADS - dailyUploadCount;
    ctx.reply(
        `🤖 *YouTube Supply Bot - Instant Re-upload*\n\n` +
        `**How it works:**\n` +
        `1. Send video → Uploaded as NEW private video\n` +
        `2. Added to supply queue\n` +
        `3. When target uploads → Your video goes PUBLIC\n` +
        `4. After 1 hour:\n` +
        `   • Under ${VIEW_THRESHOLD} views → **WAITS for next target upload**\n` +
        `   • Then RE-UPLOADED as NEW video instantly\n` +
        `   • ${VIEW_THRESHOLD}+ views → Stays public ✅\n\n` +
        `**Key Feature:** Re-upload happens INSTANTLY when target channel uploads!\n\n` +
        `📈 Daily: ${dailyUploadCount}/${MAX_DAILY_UPLOADS}\n` +
        `💾 Cache: ${totalSize.toFixed(2)}MB/${MAX_CACHE_SIZE_MB}MB\n` +
        `📦 Supply: ${supplyVideos.length} videos`,
        { parse_mode: 'Markdown', ...menu }
    );
});

bot.hears('📊 STATUS', async (ctx) => {
    const totalSize = getTotalCacheSize();
    const supplySize = getSupplySize();
    const supplyStats = getSupplyStats();
    const remainingUploads = MAX_DAILY_UPLOADS - dailyUploadCount;
    
    const waitingReupload = supplyVideos.filter(v => v.status === 'waiting_reupload').length;
    
    let msg = `📊 *STATUS*\n\n` +
        `📈 Daily Uploads: ${dailyUploadCount}/${MAX_DAILY_UPLOADS} (${remainingUploads} left)\n` +
        `📥 Upload Queue: ${uploadQueue.length} videos\n` +
        `📦 Supply: ${supplyStats.count} videos (${supplySize.toFixed(2)}MB)\n` +
        `🔄 Waiting for re-upload: ${waitingReupload} videos\n` +
        `🎥 Active: ${activeVideo?.title || 'None'}\n` +
        `💾 Cache: ${totalSize.toFixed(2)}MB/${MAX_CACHE_SIZE_MB}MB\n` +
        `🎯 Target: ${TARGET_CHANNEL_HANDLE}\n\n`;
    
    if (activeVideo) {
        const timeActive = Math.floor((Date.now() - activeVideo.publishTime) / 60000);
        const timeLeft = 60 - timeActive;
        msg += `*Active Video:*\n` +
               `📹 ${activeVideo.title}\n` +
               `⏰ Check in: ${timeLeft} minutes\n` +
               `🔄 Will re-upload on next target upload if under ${VIEW_THRESHOLD} views\n`;
    }
    
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📦 SUPPLY', async (ctx) => {
    if (supplyVideos.length === 0) {
        ctx.reply('📭 Supply is empty', menu);
    } else {
        const supplySize = getSupplySize();
        let msg = `📦 *SUPPLY (${supplyVideos.length} videos)*\n💾 ${supplySize.toFixed(2)}MB\n\n`;
        
        supplyVideos.forEach((video, i) => {
            msg += `${i+1}. ${video.title.substring(0, 40)}\n`;
            if (video.videoAttempts) {
                msg += `   🔄 Attempt: ${video.videoAttempts}\n`;
            }
            if (video.status === 'waiting_reupload') {
                msg += `   ⏳ Waiting for target upload\n`;
            }
            msg += `   📦 ${video.fileSize.toFixed(2)}MB\n`;
        });
        ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
    }
});

bot.hears('📥 QUEUE', async (ctx) => {
    if (uploadQueue.length === 0) {
        ctx.reply('📭 Upload queue is empty', menu);
    } else {
        let msg = `📥 *UPLOAD QUEUE (${uploadQueue.length})*\n\n`;
        uploadQueue.forEach((task, i) => {
            msg += `${i+1}. ${task.title.substring(0, 40)}\n`;
            if (task.isReupload) {
                msg += `   🔄 Re-upload waiting\n`;
            }
            msg += `   📦 ${task.fileSize.toFixed(2)}MB\n`;
        });
        ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
    }
});

bot.hears('🔄 REFRESH', async (ctx) => {
    await cleanupCache();
    await processUploadQueue();
    const totalSize = getTotalCacheSize();
    const supplySize = getSupplySize();
    ctx.reply(`✅ Refreshed\n📈 Daily: ${dailyUploadCount}/${MAX_DAILY_UPLOADS}\n📦 Supply: ${supplyVideos.length} videos\n💾 Cache: ${totalSize.toFixed(2)}MB/${MAX_CACHE_SIZE_MB}MB`, menu);
});

// Start monitoring
setInterval(refreshToken, 45 * 60 * 1000);
setInterval(monitorTargetChannel, 30000);
setInterval(monitorActiveVideoViews, 60000);
setInterval(cleanupCache, 300000);
setInterval(processUploadQueue, 60000);

bot.launch();
console.log('🚀 YouTube Supply Bot Started!');
console.log(`🔄 Videos with < ${VIEW_THRESHOLD} views will be RE-UPLOADED when target channel uploads`);
console.log(`⏱️ Re-upload happens INSTANTLY on target channel upload`);
console.log(`📈 Daily upload limit: ${MAX_DAILY_UPLOADS} videos`);
console.log(`💾 Cache limit: ${MAX_CACHE_SIZE_MB}MB`);
