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

let currentKey = 0, keyUsage = [0,0,0];
let keyReset = [Date.now(), Date.now(), Date.now()];
let lastVideoId = null;
let isProcessing = false;
let scheduledCache = null;
let lastCache = 0;
let monitorCount = 0;
let consecutiveErrors = 0;

let downloadQueue = [];
let isDownloading = false;

const TEMP_DIR = '/tmp/youtube_bot';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
const app = express();

app.get('/', (req, res) => res.send('Bot Running'));
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        queueSize: downloadQueue.length,
        monitorCount
    });
});

app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// Setup OAuth
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
let youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

function getApiKey() {
    const now = Date.now();
    const ONE_DAY = 86400000;
    
    for(let i = 0; i < API_KEYS.length; i++) {
        if(now - keyReset[i] > ONE_DAY) { 
            keyUsage[i] = 0; 
            keyReset[i] = now; 
        }
        
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
async function downloadFromTelegram(fileId, bot, tempPath) {
    const fileLink = await bot.telegram.getFileLink(fileId);
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

// Upload to YouTube and auto-delete
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
                privacyStatus: 'public',
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
        fs.unlinkSync(filePath);
        
        return response.data;
        
    } catch(error) {
        if (fileStream) fileStream.close();
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        throw error;
    }
                }
// Process queue
async function processDownloadQueue(bot) {
    if (isDownloading || downloadQueue.length === 0) return;
    
    isDownloading = true;
    
    while (downloadQueue.length > 0) {
        const task = downloadQueue.shift();
        const { videoFileId, title, hashtags, description, ctx, messageId } = task;
        
        const tempFile = path.join(TEMP_DIR, `${Date.now()}.mp4`);
        
        try {
            await ctx.telegram.editMessageText(
                ctx.chat.id, messageId, null,
                `📥 Downloading: ${title}`
            );
            
            await downloadFromTelegram(videoFileId, bot, tempFile);
            
            await ctx.telegram.editMessageText(
                ctx.chat.id, messageId, null,
                `📤 Uploading to YouTube: ${title}`
            );
            
            const result = await uploadToYouTube(tempFile, title, description, hashtags);
            
            await ctx.telegram.editMessageText(
                ctx.chat.id, messageId, null,
                `✅ **Uploaded!**\n\n` +
                `📹 ${title}\n` +
                `🔗 https://www.youtube.com/watch?v=${result.id}\n` +
                `🏷️ ${hashtags.join(' ') || 'No hashtags'}`,
                { parse_mode: 'Markdown' }
            );
            
        } catch(error) {
            await ctx.telegram.editMessageText(
                ctx.chat.id, messageId, null,
                `❌ Failed: ${title}\nError: ${error.message}`
            );
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        }
    }
    
    isDownloading = false;
}

// Get uploads playlist
async function getUploadsPlaylistId(channelId) {
    const youtube = getYoutube();
    if(!youtube) return null;
    const res = await youtube.channels.list({
        part: 'contentDetails',
        id: channelId
    });
    return res.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
}

async function getYourUploadsPlaylistId() {
    const res = await youtubeAuth.channels.list({
        part: 'contentDetails',
        id: YOUR_CHANNEL_ID
    });
    return res.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
}

async function getLatestPost() {
    const youtube = getYoutube();
    if(!youtube) return null;
    const playlistId = await getUploadsPlaylistId(TARGET_CHANNEL_ID);
    if(!playlistId) return null;
    const res = await youtube.playlistItems.list({
        part: 'snippet',
        playlistId: playlistId,
        maxResults: 1
    });
    if(!res.data.items?.length) return null;
    const latest = res.data.items[0];
    return {
        id: latest.snippet.resourceId.videoId,
        title: latest.snippet.title,
        url: `https://www.youtube.com/watch?v=${latest.snippet.resourceId.videoId}`
    };
}

async function getScheduledShorts(force = false) {
    const now = Date.now();
    if(!force && scheduledCache && (now - lastCache) < 60000) return scheduledCache;
    try {
        const playlistId = await getYourUploadsPlaylistId();
        if(!playlistId) return [];
        const res = await youtubeAuth.playlistItems.list({ 
            part: 'snippet', 
            playlistId: playlistId, 
            maxResults: 50 
        });
        const scheduled = [];
        for(let i = 0; i < (res.data.items || []).length; i += 10) {
            const batch = res.data.items.slice(i, i + 10);
            const videoIds = batch.map(item => item.snippet.resourceId.videoId);
            const videoRes = await youtubeAuth.videos.list({ 
                part: 'status,snippet', 
                id: videoIds.join(',') 
            });
            for(const video of videoRes.data.items || []) {
                if(video?.status?.privacyStatus === 'private' && video?.status?.publishAt) {
                    const publishTime = new Date(video.status.publishAt);
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
    } catch(e) { return []; }
}

async function monitor() {
    if(isProcessing) return;
    isProcessing = true;
    monitorCount++;
    
    try {
        const latestPost = await getLatestPost();
        if(!latestPost) return;
        
        if(latestPost.id !== lastVideoId && lastVideoId !== null) {
            console.log(`🎬 New video detected!`);
            const scheduled = await getScheduledShorts(true);
            if(scheduled.length > 0) {
                await youtubeAuth.videos.update({ 
                    part: 'status', 
                    requestBody: { 
                        id: scheduled[0].id, 
                        status: { privacyStatus: 'public' } 
                    } 
                });
                scheduledCache = null;
            }
            lastVideoId = latestPost.id;
        } else if(lastVideoId === null) {
            lastVideoId = latestPost.id;
        }
    } catch(e) {}
    finally { isProcessing = false; }
}

async function refreshToken() {
    try {
        await oauth2Client.refreshAccessToken();
        youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
    } catch(e) {}
}

// ============ TELEGRAM BOT ============
const bot = new Telegraf(BOT_TOKEN);

const menu = { 
    reply_markup: { 
        keyboard: [['📊 STATUS', '📥 QUEUE'], ['🔄 REFRESH', '📹 LATEST']], 
        resize_keyboard: true 
    } 
};

// Handle video messages (including forwarded)
bot.on('video', async (ctx) => {
    const video = ctx.message.video;
    const caption = ctx.message.caption || '';
    const { title, hashtags, description } = extractVideoInfo(caption);
    
    const msg = await ctx.reply(
        `🔄 Processing: ${title}\n📦 ${(video.file_size/1024/1024).toFixed(2)} MB\n🏷️ ${hashtags.join(' ') || 'No hashtags'}`,
        { parse_mode: 'Markdown' }
    );
    
    downloadQueue.push({
        videoFileId: video.file_id,
        title, hashtags, description,
        ctx, messageId: msg.message_id
    });
    
    processDownloadQueue(bot);
});

bot.command('start', async (ctx) => {
    ctx.reply(
        `🤖 *YouTube Uploader Bot*\n\n` +
        `Send or forward any video with title and hashtags in caption.\n\n` +
        `Example caption:\n` +
        `Every Fifa World Cup Football Evolution\n` +
        `#fifa #football #worldcup\n\n` +
        `The video will be downloaded, uploaded to YouTube, then deleted from server.`,
        { parse_mode: 'Markdown', ...menu }
    );
});

bot.hears('📊 STATUS', async (ctx) => {
    ctx.reply(
        `📊 *Status*\n\n` +
        `📥 Queue: ${downloadQueue.length}\n` +
        `🔄 Checks: ${monitorCount}`,
        { parse_mode: 'Markdown', ...menu }
    );
});

bot.hears('📥 QUEUE', async (ctx) => {
    if (downloadQueue.length === 0) {
        ctx.reply('📭 Queue empty', menu);
    } else {
        let msg = `📥 *Queue (${downloadQueue.length})*\n\n`;
        downloadQueue.forEach((t, i) => {
            msg += `${i+1}. ${t.title.substring(0, 40)}\n`;
        });
        ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
    }
});

bot.hears('🔄 REFRESH', async (ctx) => {
    scheduledCache = null;
    ctx.reply('✅ Refreshed', menu);
});

bot.hears('📹 LATEST', async (ctx) => {
    const latest = await getLatestPost();
    if (latest) {
        ctx.reply(`📹 Latest from target\n${latest.title}\n${latest.url}`, menu);
    } else {
        ctx.reply('❌ Cannot fetch', menu);
    }
});

// Start everything
setInterval(refreshToken, 45 * 60 * 1000);
setInterval(() => processDownloadQueue(bot), 5000);
setInterval(monitor, 30000);

bot.launch();
console.log('🚀 Bot started! Send videos with captions!');
