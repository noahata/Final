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
