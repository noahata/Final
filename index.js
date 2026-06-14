const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

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
const ZERO_VIEW_CHECK_DELAY = 2 * 60 * 60 * 1000;
const REUPLOAD_DELAY = 30;

// Create temp directory for Render
const TEMP_DIR = process.env.RENDER ? '/tmp/youtube_downloads' : path.join(__dirname, 'temp_downloads');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    console.log(`📁 Created temp directory: ${TEMP_DIR}`);
}

// =========================================
const PORT = process.env.PORT || 3000;
const app = express();
app.get('/', (req, res) => res.send('Bot Running - ytDown.to Scraper 720p'));
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
            url: `https://www.youtube.com/watch?v=${latest.snippet.resourceId.videoId}`,
            thumbnail: latest.snippet.thumbnails.default.url
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
        console.log(`✅ Published: ${title}`);
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
        
        lastPostInfo = latestPost;
        console.log(`\n📹 Latest: ${latestPost.title}`);
        
        if(latestPost.id !== lastVideoId && lastVideoId !== null) {
            console.log(`\n🎬 NEW VIDEO DETECTED!`);
            const scheduled = await getScheduledShorts(true);
            if(scheduled.length > 0) {
                await publishVideo(scheduled[0].id, scheduled[0].title);
            }
            lastVideoId = latestPost.id;
        } else if(lastVideoId === null) {
            lastVideoId = latestPost.id;
        }
    } catch(e) { 
        console.error('Error:', e.message);
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
    const diffMins = Math.floor((now - date) / 60000);
    if(diffMins < 1) return 'Just now';
    if(diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    const diffHours = Math.floor(diffMins / 60);
    if(diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

// ============ YTDOWN.TO SCRAPER (WORKS!) ============

async function downloadViaYtDownScraper(videoUrl, videoId, videoTitle) {
    console.log(`🌐 Scraping ytDown.to for: ${videoUrl}`);
    
    const sanitizedTitle = videoTitle.replace(/[^\w\s]/gi, '').substring(0, 50);
    const filePath = path.join(TEMP_DIR, `${videoId}_${Date.now()}_${sanitizedTitle}.mp4`);
    
    try {
        // Step 1: Get the main page
        const mainPage = await axios.get('https://app.ytdown.to/en34/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        
        const $ = cheerio.load(mainPage.data);
        
        // Step 2: Find the form action URL
        const formAction = $('#downloadForm').attr('action') || '/en34/';
        const fullActionUrl = formAction.startsWith('http') ? formAction : `https://app.ytdown.to${formAction}`;
        
        // Step 3: Submit the video URL
        const formData = new URLSearchParams();
        formData.append('url', videoUrl);
        
        const submitResponse = await axios.post(fullActionUrl, formData, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://app.ytdown.to/en34/'
            }
        });
        
        // Step 4: Parse the response to get download links
        const $$ = cheerio.load(submitResponse.data);
        
        // Try to find 720p download link
        let downloadLink = null;
        
        // Look for 720p quality button/link
        $$('a.btn, button.btn, .download-link, .quality-btn').each((i, el) => {
            const text = $$(el).text().toLowerCase();
            const href = $$(el).attr('href');
            if ((text.includes('720') || text.includes('hd') || text.includes('mp4')) && href) {
                downloadLink = href;
            }
        });
        
        // If not found, get any download link
        if (!downloadLink) {
            $$('a[href*="download"], a[href*="get-video"]').each((i, el) => {
                const href = $$(el).attr('href');
                if (href && !downloadLink) {
                    downloadLink = href;
                }
            });
        }
        
        if (!downloadLink) {
            // Try to find in script tags
            const scripts = $$('script').toString();
            const urlMatch = scripts.match(/https?:\/\/[^\s"']+\.mp4/);
            if (urlMatch) {
                downloadLink = urlMatch[0];
            }
        }
        
        if (!downloadLink) {
            throw new Error('Could not find download link in ytDown.to response');
        }
        
        // Make sure URL is absolute
        if (downloadLink.startsWith('/')) {
            downloadLink = `https://app.ytdown.to${downloadLink}`;
        }
        
        console.log(`✅ Found download link: ${downloadLink.substring(0, 80)}...`);
        
        // Step 5: Download the video
        const fileResponse = await axios({
            method: 'get',
            url: downloadLink,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://app.ytdown.to/'
            },
            timeout: 120000
        });
        
        const writer = fs.createWriteStream(filePath);
        fileResponse.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        const sizeMB = fs.statSync(filePath).size / (1024 * 1024);
        console.log(`✅ Downloaded via ytDown.to: ${sizeMB.toFixed(2)} MB`);
        return filePath;
        
    } catch (error) {
        console.error(`❌ ytDown.to scraper failed:`, error.message);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        throw error;
    }
}
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
                    part: 'statistics,snippet,status', 
                    id: ids.join(',') 
                });
                
                for(const video of videoRes.data.items||[]) {
                    if(video?.status?.privacyStatus === 'public') {
                        allVideos.push({
                            id: video.id,
                            title: video.snippet.title,
                            viewCount: parseInt(video.statistics.viewCount) || 0,
                            publishTime: new Date(video.snippet.publishedAt),
                            description: video.snippet.description || '',
                            url: `https://www.youtube.com/watch?v=${video.id}`
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

async function uploadVideoFromDisk(filePath, originalTitle, originalDescription = '') {
    return new Promise(async (resolve, reject) => {
        console.log(`📤 Uploading: ${path.basename(filePath)}`);
        
        const scheduleDate = new Date();
        scheduleDate.setDate(scheduleDate.getDate() + REUPLOAD_DELAY);
        const newTitle = `[REUPLOAD] ${originalTitle.substring(0, 70)}`;
        
        try {
            const requestBody = {
                snippet: {
                    title: newTitle,
                    description: `⚠️ AUTO-REUPLOADED ⚠️\n\nOriginal: ${new Date().toLocaleString()}\nReason: 0 views after 2 hours\nDownloaded via: ytDown.to\nScheduled: ${scheduleDate.toLocaleString()}\n\n${originalDescription.substring(0, 500)}`,
                    tags: ['reupload', 'ytdown'],
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
            
            console.log(`✅ Uploaded! New ID: ${response.data.id}`);
            scheduledCache = null;
            resolve({ videoId: response.data.id, scheduleDate: scheduleDate });
        } catch (error) {
            reject(error);
        }
    });
}

async function deleteOriginalVideo(videoId, title) {
    try {
        console.log(`🗑️ Deleting original: "${title.substring(0, 50)}"`);
        await youtubeAuth.videos.delete({ id: videoId });
        console.log(`✅ Deleted`);
        return true;
    } catch (error) {
        console.error(`❌ Delete failed:`, error.message);
        return false;
    }
}

function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Cleaned: ${path.basename(filePath)}`);
        }
    } catch (error) {}
}

async function processZeroViewVideo(videoId, videoInfo) {
    if (isZeroViewProcessing) return false;
    isZeroViewProcessing = true;
    let downloadedFile = null;
    
    try {
        console.log(`\n🔄 PROCESSING ZERO-VIEW VIDEO`);
        console.log(`📹 "${videoInfo.title.substring(0, 60)}"`);
        
        downloadedFile = await downloadViaYtDownScraper(videoInfo.url, videoId, videoInfo.title);
        
        const uploadResult = await uploadVideoFromDisk(downloadedFile, videoInfo.title, videoInfo.description);
        await deleteOriginalVideo(videoId, videoInfo.title);
        
        const successMsg = `✅ *Video Processed*\n\n📹 ${videoInfo.title.substring(0, 50)}\n📅 Scheduled: ${uploadResult.scheduleDate.toLocaleString()}\n📥 Source: ytDown.to`;
        try { await bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID || 'YOUR_CHAT_ID', successMsg, { parse_mode: 'Markdown' }); } catch(e) {}
        
        return true;
    } catch (error) {
        console.error(`❌ Failed:`, error.message);
        const errorMsg = `❌ *Processing Failed*\n\n📹 ${videoInfo.title.substring(0, 50)}\n❌ ${error.message}`;
        try { await bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID || 'YOUR_CHAT_ID', errorMsg, { parse_mode: 'Markdown' }); } catch(e) {}
        return false;
    } finally {
        isZeroViewProcessing = false;
        if (downloadedFile) cleanupTempFile(downloadedFile);
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
                console.log(`⚠️ ZERO VIEW: "${video.title.substring(0, 50)}" (${ageInHours.toFixed(1)} hours)`);
                zeroViewVideos.set(video.id, {
                    title: video.title, ageHours: ageInHours, warned: false,
                    checkedAt: now, description: video.description, url: video.url
                });
            }
        }
        
        for(const [videoId, info] of zeroViewVideos.entries()) {
            if(!info.warned) {
                console.log(`⚠️⚠️ ZERO VIEW WARNING: "${info.title.substring(0, 50)}"`);
                info.warned = true;
                zeroViewVideos.set(videoId, info);
                try {
                    await bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID || 'YOUR_CHAT_ID', 
                        `⚠️ Zero View Detected\n📹 ${info.title.substring(0, 50)}\n🔄 Processing in 5 min`, 
                        { parse_mode: 'Markdown' });
                } catch(e) {}
            }
        }
        
        for(const [videoId, info] of zeroViewVideos.entries()) {
            if(info.warned) {
                const video = videos.find(v => v.id === videoId);
                if(video && video.viewCount === 0) {
                    if(Date.now() - info.checkedAt >= 5 * 60 * 1000) {
                        await processZeroViewVideo(videoId, info);
                        zeroViewVideos.delete(videoId);
                    }
                } else if(video && video.viewCount > 0) {
                    zeroViewVideos.delete(videoId);
                }
            }
        }
    } catch(e) {
        console.error('Error:', e.message);
    }
}

function startZeroViewMonitoring() {
    console.log(`\n🔍 Zero-View Monitor Active`);
    console.log(`   Downloader: ytDown.to (scraper mode)`);
    console.log(`   Quality: Standard (from ytDown.to)`);
    console.log(`   Action: Scrape → Download → Re-upload → Delete`);
    console.log(`   Schedule: ${REUPLOAD_DELAY} days later\n`);
    
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
    
    let msg = `🤖 *YouTube Bot - ytDown.to*\n\n📹 Videos: ${publicCount}\n📅 Scheduled: ${scheduled.length}\n🎯 Target: ${TARGET_CHANNEL_HANDLE}\n📥 Downloader: ytDown.to (scraper)\n\n`;
    if(latestPost) msg += `📹 Latest: ${latestPost.title}\n⏰ ${getTimeAgo(latestPost.publishedAt)}\n\n`;
    if(scheduled.length > 0) msg += `📋 Next: ${scheduled[0].title}\n⏰ ${scheduled[0].time.toLocaleString()}`;
    else msg += `📭 No scheduled shorts`;
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu, disable_web_page_preview: true });
});

bot.hears('📊 STATUS', async (ctx) => {
    const scheduled = await getScheduledShorts();
    const publicCount = await getPublicCount();
    const latestPost = await getLatestPost();
    let msg = `📊 *STATUS*\n\n📹 Public: ${publicCount}\n📅 Scheduled: ${scheduled.length}\n🎯 Target: ${TARGET_CHANNEL_HANDLE}\n⚠️ Zero-view: ${zeroViewVideos.size}\n📥 Downloader: ytDown.to (scraper)\n\n`;
    if(latestPost) msg += `Latest: ${latestPost.title}\n⏰ ${getTimeAgo(latestPost.publishedAt)}`;
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📹 LATEST POST', async (ctx) => {
    const latestPost = await getLatestPost();
    if(!latestPost) return ctx.reply('❌ Cannot fetch', { ...menu });
    ctx.reply(`*Latest from ${TARGET_CHANNEL_HANDLE}*\n\n${latestPost.title}\n⏰ ${getTimeAgo(latestPost.publishedAt)}\n\n🔗 ${latestPost.url}`, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📦 SUPPLY', async (ctx) => {
    const scheduled = await getScheduledShorts();
    if(!scheduled.length) return ctx.reply('📭 No scheduled shorts', { ...menu });
    let msg = `📦 *SUPPLY (${scheduled.length})*\n\n`;
    scheduled.forEach((s,i) => msg += `${i+1}. ${s.title}\n   ⏰ ${s.time.toLocaleString()}\n\n`);
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('🔄 REFRESH', async (ctx) => {
    scheduledCache = null;
    ctx.reply('🔄 Refreshing...');
    const scheduled = await getScheduledShorts(true);
    ctx.reply(`✅ Refreshed\n📅 Scheduled: ${scheduled.length}`, { ...menu });
});

bot.hears('📊 ZERO VIEWS', async (ctx) => {
    if(zeroViewVideos.size === 0) return ctx.reply('✅ No zero-view videos', { ...menu });
    let msg = `⚠️ *Zero-Views* (${zeroViewVideos.size})\n\n`;
    let i = 1;
    for(const [id, info] of zeroViewVideos.entries()) {
        const age = (Date.now() - info.publishTime) / (60 * 60 * 1000);
        msg += `${i}. ${info.title.substring(0, 35)}\n   ⏰ ${age.toFixed(1)}h | ${info.warned ? '⏳' : '🔍'}\n\n`;
        i++;
    }
    msg += `💡 Download: ytDown.to scraper → Upload → Delete`;
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('🔍 CHECK ZERO', async (ctx) => {
    if(isZeroViewProcessing) return ctx.reply('⏳ Busy', { ...menu });
    ctx.reply('🔍 Checking zero-view videos...');
    await checkZeroViewVideos();
    ctx.reply(`✅ Done\n📊 Tracking: ${zeroViewVideos.size}`, { ...menu });
});

bot.launch();
console.log('🤖 Telegram bot started');

// ============ START ============
console.log(`\n🚀 Starting YouTube Bot - ytDown.to Scraper`);
console.log(`📥 Downloader: ytDown.to (web scraper mode)`);
console.log(`💾 Temp: ${TEMP_DIR}\n`);

setTimeout(async () => {
    const latest = await getLatestPost();
    if(latest) lastVideoId = latest.id;
    const scheduled = await getScheduledShorts();
    console.log(`📊 ${scheduled.length} scheduled videos`);
}, 2000);

setInterval(monitor, 30000);
monitor();
startZeroViewMonitoring();
