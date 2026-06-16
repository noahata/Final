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

// Store videos on server - SUPPLY BASED ON CACHE SIZE
let supplyVideos = []; // Array of individual videos
let activeVideo = null;
let videoFileCache = new Map(); // Store file paths for each video

const MAX_CACHE_SIZE_MB = 500; // 500 MB total limit (supply + active + cached)
const VIEW_THRESHOLD = 10;
const VIEW_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

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
    res.json({ 
        status: 'ok', 
        supplyCount: supplyVideos.length,
        supplySizeMB: supplySize.toFixed(2),
        activeVideo: activeVideo?.title || 'None',
        cachedVideos: videoFileCache.size,
        totalCacheSizeMB: totalSize.toFixed(2),
        maxCacheSizeMB: MAX_CACHE_SIZE_MB,
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
    return totalSize / (1024 * 1024); // Return in MB
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

// Clean up old videos to free space
async function cleanupCache() {
    const totalSize = getTotalCacheSize();
    if (totalSize < MAX_CACHE_SIZE_MB * 0.9) return; // Only clean if >90% full
    
    console.log(`⚠️ Cache ${totalSize.toFixed(2)}MB/${MAX_CACHE_SIZE_MB}MB - Cleaning up...`);
    
    // Sort videos by last accessed time (oldest first)
    const videos = Array.from(videoFileCache.entries())
        .map(([id, data]) => ({
            id: id,
            ...data,
            lastAccessed: data.lastAccessed || data.addedTime || Date.now()
        }))
        .sort((a, b) => a.lastAccessed - b.lastAccessed);
    
    // Remove oldest videos until under 80% capacity
    let freedSpace = 0;
    let removedCount = 0;
    for (const video of videos) {
        if (getTotalCacheSize() < MAX_CACHE_SIZE_MB * 0.8) break;
        
        // Check if video is in supply or active
        const isInSupply = supplyVideos.some(v => v.id === video.id);
        const isActive = activeVideo && activeVideo.id === video.id;
        
        if (!isInSupply && !isActive) {
            // Remove from cache
            if (fs.existsSync(video.filePath)) {
                const stats = fs.statSync(video.filePath);
                freedSpace += stats.size / (1024 * 1024);
                fs.unlinkSync(video.filePath);
                console.log(`🗑️ Removed old video: ${video.title} (${(stats.size/1024/1024).toFixed(2)}MB)`);
                removedCount++;
            }
            videoFileCache.delete(video.id);
        }
    }
    
    console.log(`✅ Freed ${freedSpace.toFixed(2)}MB (removed ${removedCount} videos)`);
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
    // Check cache limit before downloading
    const availableSpace = getAvailableSpaceMB();
    if (availableSpace < 10) { // Need at least 10MB free
        await cleanupCache();
    }
    
    // Check again after cleanup
    if (getAvailableSpaceMB() < 10) {
        throw new Error(`Cache full (${MAX_CACHE_SIZE_MB}MB). Please wait for space to free up.`);
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

// Add video to supply (based on cache limit, not fixed count)
async function addToSupply(videoId, title, hashtags, description, filePath, fileSize) {
    // Check if there's enough space
    const availableSpace = getAvailableSpaceMB();
    if (fileSize > availableSpace) {
        await cleanupCache();
        const newAvailable = getAvailableSpaceMB();
        if (fileSize > newAvailable) {
            throw new Error(`Not enough space! Need ${fileSize.toFixed(2)}MB, available ${newAvailable.toFixed(2)}MB`);
        }
    }
    
    // Add to supply (no fixed limit, just cache size)
    supplyVideos.push({
        id: videoId,
        title: title,
        hashtags: hashtags,
        description: description,
        filePath: filePath,
        fileSize: fileSize,
        status: 'scheduled',
        addedTime: Date.now(),
        resupplyCount: 0
    });
    
    // Update cache
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
        reuploadCount: 0
    });
    
    const totalSize = getTotalCacheSize();
    const supplySize = getSupplySize();
    console.log(`📦 Added to supply: ${title} (${(fileSize).toFixed(2)}MB)`);
    console.log(`📊 Supply: ${supplyVideos.length} videos (${supplySize.toFixed(2)}MB)`);
    console.log(`💾 Cache: ${totalSize.toFixed(2)}MB/${MAX_CACHE_SIZE_MB}MB`);
}

// Get next video from supply (FIFO - first in, first out)
function getNextFromSupply() {
    if (supplyVideos.length === 0) return null;
    return supplyVideos.shift(); // Get the oldest video
}

// Get supply stats
function getSupplyStats() {
    const count = supplyVideos.length;
    const size = getSupplySize();
    return { count, size };
                    }
