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
// Monitor active video views - RESUPPLY
async function monitorActiveVideoViews() {
    if (!activeVideo) return;
    
    const timeElapsed = Date.now() - activeVideo.publishTime;
    
    if (timeElapsed >= VIEW_CHECK_INTERVAL && activeVideo.status === 'active') {
        console.log(`\n📊 Checking views: ${activeVideo.title}`);
        
        const viewCount = await getVideoViews(activeVideo.id);
        console.log(`   Views: ${viewCount} (Need ${VIEW_THRESHOLD}+)`);
        
        if (viewCount < VIEW_THRESHOLD) {
            console.log(`⚠️ Low views! Resupplying video...`);
            
            // Make current video private
            await updateVideoPrivacy(activeVideo.id, 'private');
            
            // Get the cached video data
            const cachedVideo = videoFileCache.get(activeVideo.id);
            
            if (cachedVideo && fs.existsSync(cachedVideo.filePath)) {
                // Check if there's space in supply
                const availableSpace = getAvailableSpaceMB();
                if (cachedVideo.fileSize > availableSpace) {
                    await cleanupCache();
                }
                
                // Add back to supply (end of queue)
                const resupplyCount = (activeVideo.resupplyCount || 0) + 1;
                supplyVideos.push({
                    id: activeVideo.id,
                    title: activeVideo.title,
                    hashtags: activeVideo.hashtags || [],
                    description: activeVideo.description || '',
                    filePath: cachedVideo.filePath,
                    fileSize: cachedVideo.fileSize || 0,
                    status: 'scheduled',
                    addedTime: Date.now(),
                    resupplyCount: resupplyCount
                });
                
                // Update cache
                cachedVideo.inSupply = true;
                cachedVideo.lastAccessed = Date.now();
                cachedVideo.resupplyCount = resupplyCount;
                videoFileCache.set(activeVideo.id, cachedVideo);
                
                const supplySize = getSupplySize();
                console.log(`🔄 Video resupplied (Attempt ${resupplyCount})`);
                console.log(`📦 Supply: ${supplyVideos.length} videos (${supplySize.toFixed(2)}MB)`);
            } else {
                console.log(`❌ Video file not found on server, removing from system`);
                videoFileCache.delete(activeVideo.id);
            }
            
            // Clear active video
            activeVideo = null;
            
        } else {
            console.log(`✅ Good views! Video stays public.`);
            activeVideo.status = 'completed';
            
            // Remove from server (successful)
            const cachedVideo = videoFileCache.get(activeVideo.id);
            if (cachedVideo && fs.existsSync(cachedVideo.filePath)) {
                fs.unlinkSync(cachedVideo.filePath);
                videoFileCache.delete(activeVideo.id);
                console.log(`🗑️ Removed from server (successful)`);
                
                const totalSize = getTotalCacheSize();
                console.log(`💾 Cache: ${totalSize.toFixed(2)}MB/${MAX_CACHE_SIZE_MB}MB`);
            }
            
            activeVideo = null;
        }
    }
}

// Monitor target channel - CHECKS EVERY 30 SECONDS
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
            
            // Get next video from supply (FIFO)
            const nextVideo = getNextFromSupply();
            
            if (nextVideo) {
                console.log(`📤 Publishing from supply: ${nextVideo.title}`);
                await updateVideoPrivacy(nextVideo.id, 'public');
                
                // Set as active video for monitoring
                activeVideo = {
                    ...nextVideo,
                    publishTime: Date.now(),
                    status: 'active'
                };
                
                // Update cache
                if (videoFileCache.has(nextVideo.id)) {
                    const cached = videoFileCache.get(nextVideo.id);
                    cached.inSupply = false;
                    cached.lastAccessed = Date.now();
                    videoFileCache.set(nextVideo.id, cached);
                }
                
                const supplySize = getSupplySize();
                console.log(`✅ Now public - will check views in 1 hour`);
                console.log(`📊 Need ${VIEW_THRESHOLD}+ views to stay public`);
                console.log(`📦 Remaining in supply: ${supplyVideos.length} videos (${supplySize.toFixed(2)}MB)`);
            } else {
                console.log(`📭 No videos in supply to publish`);
            }
            
            lastVideoId = latestVideo.id;
        } else if (lastVideoId === null) {
            lastVideoId = latestVideo.id;
            console.log(`📝 Initialized with latest video`);
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
        
        // Get file size
        const stats = fs.statSync(tempFile);
        const fileSizeMB = stats.size / (1024 * 1024);
        
        if (fileSizeMB > MAX_CACHE_SIZE_MB) {
            throw new Error(`Video too large (${fileSizeMB.toFixed(2)}MB). Maximum is ${MAX_CACHE_SIZE_MB}MB.`);
        }
        
        await ctx.telegram.editMessageText(
            ctx.chat.id, messageId, null,
            `📤 Uploading to YouTube (private)...`
        );
        
        const result = await uploadToYouTube(tempFile, title, description, hashtags);
        
        // Keep file on server for future resupply
        const finalPath = path.join(TEMP_DIR, `${result.id}.mp4`);
        fs.renameSync(tempFile, finalPath);
        
        // Add to supply based on cache limit
        await addToSupply(result.id, title, hashtags, description, finalPath, fileSizeMB);
        
        // Clean up cache if needed
        await cleanupCache();
        
        const totalSize = getTotalCacheSize();
        const supplySize = getSupplySize();
        const supplyStats = getSupplyStats();
        
        await ctx.telegram.editMessageText(
            ctx.chat.id, messageId, null,
            `✅ **Added to Supply!**\n\n` +
            `📹 ${title}\n` +
            `📦 Supply: ${supplyStats.count} videos (${supplySize.toFixed(2)}MB)\n` +
            `💾 Cache: ${totalSize.toFixed(2)}MB/${MAX_CACHE_SIZE_MB}MB\n` +
            `📌 Video is private and waiting\n` +
            `🎯 Will publish when ${TARGET_CHANNEL_HANDLE} uploads\n` +
            `📊 Need ${VIEW_THRESHOLD}+ views in 1 hour to stay public\n` +
            `🔄 Will resupply if under ${VIEW_THRESHOLD} views\n` +
            `🏷️ ${hashtags.join(' ') || 'No hashtags'}`,
            { parse_mode: 'Markdown' }
        );
        
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
        keyboard: [['📊 STATUS', '📦 SUPPLY'], ['🔄 REFRESH']], 
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
        return ctx.reply(`❌ Video too large (${fileSizeMB.toFixed(2)}MB). Maximum is ${MAX_CACHE_SIZE_MB}MB.`);
    }
    
    const availableSpace = getAvailableSpaceMB();
    if (fileSizeMB > availableSpace) {
        await cleanupCache();
        const newAvailable = getAvailableSpaceMB();
        if (fileSizeMB > newAvailable) {
            return ctx.reply(`❌ Not enough space! Need ${fileSizeMB.toFixed(2)}MB, available ${newAvailable.toFixed(2)}MB. Please wait.`);
        }
    }
    
    const msg = await ctx.reply(
        `🔄 Processing: ${title}\n📦 ${fileSizeMB.toFixed(2)} MB\n💾 Available: ${getAvailableSpaceMB().toFixed(2)}MB`,
        { parse_mode: 'Markdown' }
    );
    
    await processNewVideo(video.file_id, title, hashtags, description, ctx, msg.message_id, bot);
});

bot.command('start', async (ctx) => {
    const totalSize = getTotalCacheSize();
    const supplySize = getSupplySize();
    ctx.reply(
        `🤖 *YouTube Supply Bot - Cache-Based System*\n\n` +
        `**How it works:**\n` +
        `1. Send video → Stored & uploaded (private)\n` +
        `2. Added to supply (based on ${MAX_CACHE_SIZE_MB}MB cache limit)\n` +
        `3. When target channel uploads → NEXT video goes public (FIFO)\n` +
        `4. After 1 hour:\n` +
        `   • Under ${VIEW_THRESHOLD} views → **Resupply** (end of queue)\n` +
        `   • ${VIEW_THRESHOLD}+ views → Stays public ✅\n\n` +
        `**Storage:** ${totalSize.toFixed(2)}MB / ${MAX_CACHE_SIZE_MB}MB used\n` +
        `📦 Supply: ${supplyVideos.length} videos (${supplySize.toFixed(2)}MB)\n` +
        `🎥 Active: ${activeVideo?.title || 'None'}\n` +
        `🎯 Target: ${TARGET_CHANNEL_HANDLE}`,
        { parse_mode: 'Markdown', ...menu }
    );
});

bot.hears('📊 STATUS', async (ctx) => {
    const totalSize = getTotalCacheSize();
    const supplySize = getSupplySize();
    const supplyStats = getSupplyStats();
    
    let msg = `📊 *STATUS*\n\n` +
        `📦 Supply: ${supplyStats.count} videos (${supplySize.toFixed(2)}MB)\n` +
        `🎥 Active: ${activeVideo?.title || 'None'}\n` +
        `💾 Cache: ${totalSize.toFixed(2)}MB/${MAX_CACHE_SIZE_MB}MB\n` +
        `📹 Cached Videos: ${videoFileCache.size}\n` +
        `🔄 Checks: ${monitorCount}\n` +
        `📊 API Key ${currentKey+1} usage: ~${keyUsage[currentKey]} units\n` +
        `🎯 Target: ${TARGET_CHANNEL_HANDLE}\n` +
        `📊 Threshold: ${VIEW_THRESHOLD} views in 1 hour\n\n`;
    
    if (activeVideo) {
        const timeActive = Math.floor((Date.now() - activeVideo.publishTime) / 60000);
        const timeLeft = 60 - timeActive;
        msg += `*Active Video:*\n` +
               `📹 ${activeVideo.title}\n` +
               `⏰ Active for: ${timeActive} minutes\n` +
               `⏳ Check in: ${timeLeft} minutes\n` +
               `🔄 Will resupply if under ${VIEW_THRESHOLD} views\n\n`;
    }
    
    if (supplyVideos.length > 0) {
        msg += `*Queue (FIFO - First In, First Out):*\n`;
        supplyVideos.forEach((video, i) => {
            const position = i + 1;
            msg += `${position}. ${video.title.substring(0, 40)}\n`;
            if (video.resupplyCount) {
                msg += `   🔄 Resupplied: ${video.resupplyCount}x\n`;
            }
            if (video.fileSize) {
                msg += `   📦 ${video.fileSize.toFixed(2)}MB\n`;
            }
        });
    }
    
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📦 SUPPLY', async (ctx) => {
    if (supplyVideos.length === 0) {
        ctx.reply('📭 Supply is empty\n\nSend videos to add to supply!', menu);
    } else {
        const totalSize = getTotalCacheSize();
        const supplySize = getSupplySize();
        let msg = `📦 *SUPPLY QUEUE (${supplyVideos.length} videos)*\n` +
                  `💾 ${supplySize.toFixed(2)}MB / ${MAX_CACHE_SIZE_MB}MB used\n\n`;
        
        supplyVideos.forEach((video, i) => {
            const position = i + 1;
            msg += `${position}. ${video.title.substring(0, 40)}\n`;
            if (video.resupplyCount) {
                msg += `   🔄 Resupplied: ${video.resupplyCount}x\n`;
            }
            if (video.fileSize) {
                msg += `   📦 ${video.fileSize.toFixed(2)}MB\n`;
            }
            msg += `   📌 Waiting for target channel upload\n\n`;
        });
        ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
    }
});

bot.hears('🔄 REFRESH', async (ctx) => {
    await cleanupCache();
    const totalSize = getTotalCacheSize();
    const supplySize = getSupplySize();
    ctx.reply(`✅ Refreshed\n📦 Supply: ${supplyVideos.length} videos (${supplySize.toFixed(2)}MB)\n💾 Cache: ${totalSize.toFixed(2)}MB/${MAX_CACHE_SIZE_MB}MB\n🎥 Active: ${activeVideo?.title || 'None'}`, menu);
});

// Start monitoring
setInterval(refreshToken, 45 * 60 * 1000);
setInterval(monitorTargetChannel, 30000); // Check target every 30 seconds
setInterval(monitorActiveVideoViews, 60000); // Check views every minute
setInterval(cleanupCache, 300000); // Clean up cache every 5 minutes

bot.launch();
console.log('🚀 YouTube Supply Bot Started!');
console.log(`💾 Max cache: ${MAX_CACHE_SIZE_MB}MB (supply + active + cached)`);
console.log(`🎯 Target: ${TARGET_CHANNEL_HANDLE}`);
console.log(`📊 View threshold: ${VIEW_THRESHOLD} views in 1 hour`);
console.log(`⏱️ Target channel checked every 30 seconds`);
console.log(`🔄 Videos with < ${VIEW_THRESHOLD} views will RESUPPLY (go to end of queue)`);
console.log(`📌 Queue system: FIFO (First In, First Out)`);
console.log(`📦 Supply limit based on cache size (${MAX_CACHE_SIZE_MB}MB total)`);
