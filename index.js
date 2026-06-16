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

const MAX_SUPPLY = 3;
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
    res.json({ 
        status: 'ok', 
        supplyCount: supplyVideos.length,
        activeVideo: activeVideo?.title || 'None',
        cachedVideos: videoFileCache.size,
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

// Add video to supply
async function addToSupply(videoId, title, hashtags, description, filePath) {
    supplyVideos.push({
        id: videoId,
        title: title,
        hashtags: hashtags,
        description: description,
        filePath: filePath,
        status: 'scheduled',
        addedTime: Date.now()
    });
    
    videoFileCache.set(videoId, {
        videoId: videoId,
        title: title,
        hashtags: hashtags,
        description: description,
        filePath: filePath,
        reuploadCount: 0
    });
    
    console.log(`📦 Added to supply: ${title} (${supplyVideos.length}/${MAX_SUPPLY})`);
}

// Get next video from supply
function getNextFromSupply() {
    if (supplyVideos.length === 0) return null;
    return supplyVideos.shift();
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
            console.log(`⚠️ Low views! Recycling...`);
            
            await updateVideoPrivacy(activeVideo.id, 'private');
            
            const cachedVideo = videoFileCache.get(activeVideo.id);
            
            if (cachedVideo) {
                const newVideo = await uploadToYouTube(
                    cachedVideo.filePath,
                    cachedVideo.title,
                    cachedVideo.description,
                    cachedVideo.hashtags
                );
                
                if (newVideo) {
                    videoFileCache.set(newVideo.id, {
                        ...cachedVideo,
                        videoId: newVideo.id,
                        reuploadCount: (cachedVideo.reuploadCount || 0) + 1
                    });
                    videoFileCache.delete(activeVideo.id);
                    
                    supplyVideos.push({
                        id: newVideo.id,
                        title: newVideo.title,
                        hashtags: cachedVideo.hashtags,
                        description: cachedVideo.description,
                        filePath: cachedVideo.filePath,
                        status: 'scheduled',
                        reuploadCount: (cachedVideo.reuploadCount || 0) + 1
                    });
                    
                    console.log(`🔄 Recycled (Attempt ${cachedVideo.reuploadCount + 1})`);
                }
            }
            
            const nextVideo = getNextFromSupply();
            
            if (nextVideo) {
                await updateVideoPrivacy(nextVideo.id, 'public');
                
                activeVideo = {
                    ...nextVideo,
                    publishTime: Date.now(),
                    status: 'active'
                };
                
                console.log(`📤 Now showing: ${activeVideo.title}`);
            } else {
                activeVideo = null;
                console.log(`📭 No videos in supply`);
            }
        } else {
            console.log(`✅ Good views! Video stays public.`);
            activeVideo.status = 'completed';
            
            const cachedVideo = videoFileCache.get(activeVideo.id);
            if (cachedVideo && fs.existsSync(cachedVideo.filePath)) {
                fs.unlinkSync(cachedVideo.filePath);
                videoFileCache.delete(activeVideo.id);
                console.log(`🗑️ Removed from server`);
            }
            
            activeVideo = null;
        }
    }
}

// Monitor target channel
async function monitorTargetChannel() {
    const now = Date.now();
    if (now - lastTargetCheck < 120000) return;
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
            console.log(`\n🎬 Target uploaded: ${latestVideo.title}`);
            
            const nextVideo = getNextFromSupply();
            
            if (nextVideo) {
                console.log(`📤 Publishing: ${nextVideo.title}`);
                await updateVideoPrivacy(nextVideo.id, 'public');
                
                activeVideo = {
                    ...nextVideo,
                    publishTime: Date.now(),
                    status: 'active'
                };
                
                console.log(`✅ Now public - will check in 1 hour`);
            } else {
                console.log(`📭 No videos in supply`);
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

// Process new video - FIXED LINE 345
async function processNewVideo(videoFileId, title, hashtags, description, ctx, messageId, botInstance) {
    const tempVideoId = `temp_${Date.now()}`;
    let tempFile = null;
    
    try {
        await ctx.telegram.editMessageText(
            ctx.chat.id, messageId, null,
            `📥 Downloading: ${title}`
        );
        
        // FIXED: Changed from ctx.bot to botInstance
        tempFile = await downloadAndSaveVideo(videoFileId, botInstance, tempVideoId);
        
        await ctx.telegram.editMessageText(
            ctx.chat.id, messageId, null,
            `📤 Uploading to YouTube...`
        );
        
        const result = await uploadToYouTube(tempFile, title, description, hashtags);
        
        const finalPath = path.join(TEMP_DIR, `${result.id}.mp4`);
        fs.renameSync(tempFile, finalPath);
        
        await addToSupply(result.id, title, hashtags, description, finalPath);
        
        while (supplyVideos.length > MAX_SUPPLY) {
            const excess = supplyVideos.pop();
            console.log(`🗑️ Removing excess: ${excess.title}`);
            await updateVideoPrivacy(excess.id, 'private');
            if (videoFileCache.has(excess.id)) {
                const cached = videoFileCache.get(excess.id);
                if (fs.existsSync(cached.filePath)) fs.unlinkSync(cached.filePath);
                videoFileCache.delete(excess.id);
            }
        }
        
        await ctx.telegram.editMessageText(
            ctx.chat.id, messageId, null,
            `✅ **Added to Supply!**\n\n` +
            `📹 ${title}\n` +
            `📦 Supply: ${supplyVideos.length}/${MAX_SUPPLY}\n` +
            `🔄 Will recycle if under ${VIEW_THRESHOLD} views\n` +
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

// Handle video messages - Pass bot instance
bot.on('video', async (ctx) => {
    const video = ctx.message.video;
    const caption = ctx.message.caption || '';
    const { title, hashtags, description } = extractVideoInfo(caption);
    
    const msg = await ctx.reply(
        `🔄 Processing: ${title}\n📦 ${(video.file_size/1024/1024).toFixed(2)} MB`,
        { parse_mode: 'Markdown' }
    );
    
    // Pass the bot instance
    await processNewVideo(video.file_id, title, hashtags, description, ctx, msg.message_id, bot);
});

bot.command('start', async (ctx) => {
    ctx.reply(
        `🤖 *YouTube Supply Bot*\n\n` +
        `**How it works:**\n` +
        `1. Send video → Stored & uploaded (private)\n` +
        `2. Added to supply (max ${MAX_SUPPLY})\n` +
        `3. When target uploads → Your video goes public\n` +
        `4. After 1 hour:\n` +
        `   • Under ${VIEW_THRESHOLD} views → Recycled\n` +
        `   • ${VIEW_THRESHOLD}+ views → Stays public\n\n` +
        `📊 **Status:**\n` +
        `📦 Supply: ${supplyVideos.length}/${MAX_SUPPLY}\n` +
        `🎥 Active: ${activeVideo?.title || 'None'}\n` +
        `🎯 Target: ${TARGET_CHANNEL_HANDLE}`,
        { parse_mode: 'Markdown', ...menu }
    );
});

bot.hears('📊 STATUS', async (ctx) => {
    let msg = `📊 *STATUS*\n\n` +
        `📦 Supply: ${supplyVideos.length}/${MAX_SUPPLY}\n` +
        `🎥 Active: ${activeVideo?.title || 'None'}\n` +
        `💾 Cached: ${videoFileCache.size} videos\n` +
        `🔄 Checks: ${monitorCount}\n` +
        `📊 API Key ${currentKey+1} usage: ~${keyUsage[currentKey]} units\n` +
        `🎯 Target: ${TARGET_CHANNEL_HANDLE}\n\n`;
    
    if (activeVideo) {
        const timeActive = Math.floor((Date.now() - activeVideo.publishTime) / 60000);
        const timeLeft = 60 - timeActive;
        msg += `*Active:* ${activeVideo.title}\n⏰ Check in: ${timeLeft} minutes`;
    }
    
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📦 SUPPLY', async (ctx) => {
    if (supplyVideos.length === 0) {
        ctx.reply('📭 Supply empty', menu);
    } else {
        let msg = `📦 *SUPPLY (${supplyVideos.length}/${MAX_SUPPLY})*\n\n`;
        supplyVideos.forEach((video, i) => {
            msg += `${i+1}. ${video.title.substring(0, 40)}\n`;
            if (video.reuploadCount) msg += `   🔄 Re-uploaded: ${video.reuploadCount}x\n`;
        });
        ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
    }
});

bot.hears('🔄 REFRESH', async (ctx) => {
    ctx.reply(`✅ Refreshed\n📦 Supply: ${supplyVideos.length}/${MAX_SUPPLY}`, menu);
});

// Start monitoring
setInterval(refreshToken, 45 * 60 * 1000);
setInterval(monitorTargetChannel, 30000);
setInterval(monitorActiveVideoViews, 60000);

bot.launch();
console.log('🚀 YouTube Supply Bot Started!');
console.log(`📦 Max supply: ${MAX_SUPPLY} videos`);
console.log(`🎯 Target: ${TARGET_CHANNEL_HANDLE}`);
console.log(`📊 View threshold: ${VIEW_THRESHOLD} views in 1 hour`);
