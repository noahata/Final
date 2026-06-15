const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const randomUseragent = require('random-useragent');

puppeteer.use(StealthPlugin());

const BOT_TOKEN = process.env.BOT_TOKEN;

const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const TARGET_CHANNEL_HANDLE = '@Tewahdotube-21';
const CLIENT_ID = '635922113777-8c182r05vi5ve32nkqgqc2n5bbldhn18.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04F_QRLOYNyOdCgYIARAAGAQSNwF-L9IrWsT9K73DNxaQfqrmd6fgYUhdeQaFAvSJtB8y3eV6ZA3skvwUfUacaRTr53opx0mrn_k';

const API_KEYS = [
    'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg',
    'AIzaSyAXzQXd0AONNgSI8E6D5_BeweMqyz4iGTg',
    'AIzaSyDjLVpU8M9VFBAuj-_pvSyDW1BbUfCjyIY'
];

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN environment variable is required!');
    process.exit(1);
}

let currentKey = 0, keyUsage = [0,0,0];
let keyReset = [Date.now(), Date.now(), Date.now()];
let lastVideoId = null;
let isProcessing = false;
let scheduledCache = null;
let lastCache = 0;
let monitorCount = 0;
let lastPostInfo = null;
let consecutiveErrors = 0;
let publishedVideos = new Map();
let browser = null;
let ytdownPage = null;

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('Bot Running'));
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        lastVideoId, 
        monitorCount,
        scheduledCount: scheduledCache?.length || 0,
        consecutiveErrors,
        monitoredVideos: publishedVideos.size
    });
});
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
let youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

class YouTubeDownloaderBot {
    constructor() {
        this.isScrolling = false;
        this.scrollAttempts = 0;
        this.maxScrollAttempts = 30;
        this.noNewContentCount = 0;
    }

    async initBrowser() {
        if (browser && browser.isConnected()) return browser;
        
        console.log('🚀 Initializing browser...');
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1920,1080'
            ]
        });
        
        ytdownPage = await browser.newPage();
        const userAgent = randomUseragent.getRandom();
        await ytdownPage.setUserAgent(userAgent);
        await ytdownPage.setViewport({ width: 1920, height: 1080 });
        await ytdownPage.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.google.com/'
        });
        return browser;
    }

    async humanDelay(min = 500, max = 1500) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
    }

    async smartScroll() {
        if (this.isScrolling) return;
        this.isScrolling = true;
        this.scrollAttempts = 0;
        this.noNewContentCount = 0;
        
        console.log('📜 Starting smart infinite scroll...');
        
        try {
            let lastHeight = await ytdownPage.evaluate('document.body.scrollHeight');
            let lastContentCount = await ytdownPage.evaluate(() => document.querySelectorAll('a, div').length);
            
            while (this.scrollAttempts < this.maxScrollAttempts && this.noNewContentCount < 3) {
                const scrollAmount = Math.floor(Math.random() * 400) + 300;
                await ytdownPage.evaluate((amount) => window.scrollBy({ top: amount, behavior: 'smooth' }), scrollAmount);
                await this.humanDelay(800, 1500);
                
                const newHeight = await ytdownPage.evaluate('document.body.scrollHeight');
                const newContentCount = await ytdownPage.evaluate(() => document.querySelectorAll('a, div').length);
                
                if (newHeight > lastHeight || newContentCount > lastContentCount) {
                    console.log(`✅ Scroll ${this.scrollAttempts + 1}: +${newHeight - lastHeight}px`);
                    lastHeight = newHeight;
                    lastContentCount = newContentCount;
                    this.noNewContentCount = 0;
                } else {
                    this.noNewContentCount++;
                    console.log(`⚠️ No new content (${this.noNewContentCount}/3)`);
                    if (this.noNewContentCount === 1) {
                        await ytdownPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                    } else if (this.noNewContentCount === 2) {
                        await ytdownPage.evaluate(() => window.scrollBy(0, -200));
                        await this.humanDelay(500, 800);
                        await ytdownPage.evaluate(() => window.scrollBy(0, 500));
                    }
                }
                this.scrollAttempts++;
                if (this.scrollAttempts % 5 === 0) await this.humanDelay(2000, 4000);
            }
            console.log(`📊 Scroll complete: ${this.scrollAttempts} attempts`);
        } finally {
            this.isScrolling = false;
        }
    }

    async downloadFromYTDown(youtubeUrl) {
        try {
            await this.initBrowser();
            console.log(`🎬 Downloading: ${youtubeUrl}`);
            
            await ytdownPage.goto('https://ytdown.to', { waitUntil: 'networkidle2', timeout: 30000 });
            await this.humanDelay(2000, 3000);
            
            const inputField = await ytdownPage.waitForSelector('input[type="text"], input[placeholder*="Paste"]', { timeout: 10000 });
            await inputField.click();
            await this.humanDelay(300, 600);
            
            for (const char of youtubeUrl) {
                await ytdownPage.keyboard.type(char);
                await this.humanDelay(30, 80);
            }
            await this.humanDelay(500, 1000);
            
            const downloadBtn = await ytdownPage.$('button:contains("Download"), input[type="submit"]');
            if (downloadBtn) await downloadBtn.click();
            
            await this.humanDelay(3000, 5000);
            await this.smartScroll();
            
            const downloadLink = await ytdownPage.waitForSelector('a[href*="download"]', { timeout: 10000 }).catch(() => null);
            if (downloadLink) {
                const href = await downloadLink.getProperty('href');
                return await href.jsonValue();
            }
            return null;
        } catch (error) {
            console.error('❌ Error:', error.message);
            return null;
        }
    }

    async closeBrowser() {
        if (browser) { await browser.close(); browser = null; ytdownPage = null; }
    }
}

const downloader = new YouTubeDownloaderBot();

function getApiKey() {
    const now = Date.now();
    const ONE_DAY = 86400000;
    for(let i = 0; i < API_KEYS.length; i++) {
        if(now - keyReset[i] > ONE_DAY) { keyUsage[i] = 0; keyReset[i] = now; }
        if(keyUsage[i] < 50) { currentKey = i; keyUsage[i]++; return API_KEYS[i]; }
    }
    return null;
}

function getYoutube() { 
    const key = getApiKey();
    return key ? google.youtube({ version: 'v3', auth: key }) : null;
}

async function refreshToken() {
    try {
        await oauth2Client.refreshAccessToken();
        youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
        console.log('✅ Token refreshed');
        consecutiveErrors = 0;
    } catch(e) { console.error('❌ Token refresh failed:', e.message); consecutiveErrors++; }
}
setInterval(refreshToken, 45 * 60 * 1000);

async function getUploadsPlaylistId(channelId, retryCount = 0) {
    try {
        const youtube = getYoutube();
        if(!youtube && retryCount < 3) {
            await new Promise(r => setTimeout(r, 5000));
            return getUploadsPlaylistId(channelId, retryCount + 1);
        }
        const res = await youtube.channels.list({ part: 'contentDetails', id: channelId });
        if(res.data.items?.length) return res.data.items[0].contentDetails.relatedPlaylists.uploads;
        return null;
    } catch(e) { return null; }
}

async function getYourUploadsPlaylistId() {
    try {
        const res = await youtubeAuth.channels.list({ part: 'contentDetails', id: YOUR_CHANNEL_ID });
        return res.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
    } catch(e) { return null; }
}

async function getLatestPost(retryCount = 0) {
    try {
        const youtube = getYoutube();
        if(!youtube && retryCount < 3) {
            await new Promise(r => setTimeout(r, 5000));
            return getLatestPost(retryCount + 1);
        }
        const uploadsPlaylistId = await getUploadsPlaylistId(TARGET_CHANNEL_ID);
        if(!uploadsPlaylistId) return null;
        const res = await youtube.playlistItems.list({ part: 'snippet', playlistId: uploadsPlaylistId, maxResults: 1 });
        if(!res.data.items?.length) return null;
        const latest = res.data.items[0];
        return {
            id: latest.snippet.resourceId.videoId,
            title: latest.snippet.title,
            publishedAt: latest.snippet.publishedAt,
            url: `https://www.youtube.com/watch?v=${latest.snippet.resourceId.videoId}`
        };
    } catch(e) { return null; }
}

async function getScheduledShorts(force = false) {
    const now = Date.now();
    if(!force && scheduledCache && (now - lastCache) < 60000) return scheduledCache;
    try {
        const uploadsPlaylistId = await getYourUploadsPlaylistId();
        if(!uploadsPlaylistId) return [];
        const res = await youtubeAuth.playlistItems.list({ part: 'snippet', playlistId: uploadsPlaylistId, maxResults: 50 });
        const scheduled = [];
        for(let i = 0; i < (res.data.items || []).length; i += 10) {
            const batch = res.data.items.slice(i, i + 10);
            const videoIds = batch.map(item => item.snippet.resourceId.videoId);
            const videoRes = await youtubeAuth.videos.list({ part: 'status,snippet', id: videoIds.join(',') });
            for(const video of videoRes.data.items || []) {
                const status = video?.status;
                if(status?.privacyStatus === 'private' && status?.publishAt && new Date(status.publishAt) > new Date()) {
                    scheduled.push({ id: video.id, title: video.snippet.title, time: new Date(status.publishAt) });
                }
            }
        }
        scheduled.sort((a,b) => a.time - b.time);
        scheduledCache = scheduled;
        lastCache = now;
        return scheduled;
    } catch(e) { return []; }
                  }
async function publishVideo(id, title, retryCount = 0) {
    try {
        console.log(`📤 Publishing: ${title}`);
        await youtubeAuth.videos.update({ part: 'status', requestBody: { id: id, status: { privacyStatus: 'public' } } });
        console.log(`✅ Published: ${title}`);
        publishedVideos.set(id, { publishTime: Date.now(), title: title, status: 'checking' });
        scheduledCache = null;
        consecutiveErrors = 0;
        return true;
    } catch(e) {
        if(retryCount < 3) {
            await new Promise(r => setTimeout(r, 10000));
            return publishVideo(id, title, retryCount + 1);
        }
        return false;
    }
}

async function makePrivateAndReschedule(videoId, title) {
    try {
        const newPublishDate = new Date();
        newPublishDate.setDate(newPublishDate.getDate() + 3);
        await youtubeAuth.videos.update({
            part: 'status',
            requestBody: { id: videoId, status: { privacyStatus: 'private', publishAt: newPublishDate.toISOString() } }
        });
        console.log(`✅ "${title}" rescheduled for ${newPublishDate.toLocaleString()}`);
        scheduledCache = null;
        return true;
    } catch(e) { return false; }
}

async function checkVideoViews() {
    const now = Date.now();
    const videosToCheck = [];
    for (const [videoId, data] of publishedVideos.entries()) {
        if ((now - data.publishTime) / (1000 * 60 * 60) >= 2 && data.status === 'checking') {
            videosToCheck.push({ videoId, ...data });
        }
    }
    if (videosToCheck.length === 0) return;
    for (const video of videosToCheck) {
        try {
            const response = await youtubeAuth.videos.list({ part: 'statistics', id: video.videoId });
            const viewCount = parseInt(response.data.items?.[0]?.statistics?.viewCount || 0);
            console.log(`📊 "${video.title}" has ${viewCount} view(s)`);
            if (viewCount < 2) {
                await makePrivateAndReschedule(video.videoId, video.title);
                publishedVideos.set(video.videoId, { ...video, status: 'rescheduled' });
            } else {
                publishedVideos.set(video.videoId, { ...video, status: 'success', viewCount });
            }
        } catch(e) {}
    }
}

async function monitor() {
    if(isProcessing) return;
    if(consecutiveErrors > 10) {
        await new Promise(r => setTimeout(r, 300000));
        consecutiveErrors = 0;
    }
    isProcessing = true;
    monitorCount++;
    try {
        await checkVideoViews();
        const latestPost = await getLatestPost();
        if(!latestPost) return;
        if(latestPost.id !== lastVideoId && lastVideoId !== null) {
            const scheduled = await getScheduledShorts(true);
            if(scheduled.length > 0) await publishVideo(scheduled[0].id, scheduled[0].title);
            lastVideoId = latestPost.id;
        } else if(lastVideoId === null) {
            lastVideoId = latestPost.id;
        }
    } catch(e) { consecutiveErrors++;
    } finally { isProcessing = false; }
}

let publicCountCache = { count: 0, timestamp: 0 };
async function getPublicCount() {
    const now = Date.now();
    if(now - publicCountCache.timestamp < 300000) return publicCountCache.count;
    try {
        let count = 0, page = null;
        do {
            const res = await youtubeAuth.search.list({ part: 'snippet', channelId: YOUR_CHANNEL_ID, type: 'video', maxResults: 50, pageToken: page });
            const ids = (res.data.items || []).map(i => i.id.videoId).filter(id => id);
            if(ids.length) {
                const videos = await youtubeAuth.videos.list({ part: 'status', id: ids.join(',') });
                count += (videos.data.items || []).filter(v => v?.status?.privacyStatus === 'public').length;
            }
            page = res.data.nextPageToken;
        } while(page);
        publicCountCache = { count, timestamp: now };
        return count;
    } catch(e) { return publicCountCache.count; }
}

function getTimeAgo(dateString) {
    const date = new Date(dateString);
    const diffMins = Math.floor((Date.now() - date) / 60000);
    if(diffMins < 1) return 'Just now';
    if(diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    const diffHours = Math.floor(diffMins / 60);
    if(diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

const bot = new Telegraf(BOT_TOKEN);
const menu = { 
    reply_markup: { 
        keyboard: [['📊 STATUS', '📦 SUPPLY'], ['🔄 REFRESH', '📹 LATEST POST'], ['📈 VIEW STATUS', '📥 DOWNLOAD VIDEO']], 
        resize_keyboard: true 
    } 
};

bot.catch((err, ctx) => ctx.reply('⚠️ Error occurred'));

bot.command('start', async (ctx) => {
    const scheduled = await getScheduledShorts();
    const publicCount = await getPublicCount();
    const latestPost = await getLatestPost();
    let msg = `🤖 *YouTube Timing Bot*\n\n📹 Videos: ${publicCount}\n📅 Scheduled: ${scheduled.length}\n🎯 Target: ${TARGET_CHANNEL_HANDLE}\n🟢 Active\n📊 Monitoring: ${publishedVideos.size}\n\n`;
    if(latestPost) msg += `*Latest:* ${latestPost.title}\n⏰ ${getTimeAgo(latestPost.publishedAt)}\n\n`;
    if(scheduled.length > 0) msg += `📋 *Next:* ${scheduled[0].title}\n⏰ ${scheduled[0].time.toLocaleString()}`;
    else msg += `📭 No scheduled shorts`;
    await ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📊 STATUS', async (ctx) => {
    const scheduled = await getScheduledShorts();
    const publicCount = await getPublicCount();
    const latestPost = await getLatestPost();
    let msg = `📊 *STATUS*\n\n📹 Public: ${publicCount}\n📅 Scheduled: ${scheduled.length}\n🎯 Target: ${TARGET_CHANNEL_HANDLE}\n🔄 Checks: ${monitorCount}\n📊 Monitoring: ${publishedVideos.size}\n⚠️ Errors: ${consecutiveErrors}\n`;
    if(latestPost) msg += `\n*Latest:* ${latestPost.title}\n⏰ ${getTimeAgo(latestPost.publishedAt)}`;
    await ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📈 VIEW STATUS', async (ctx) => {
    if (publishedVideos.size === 0) return ctx.reply('📭 No videos monitored', menu);
    let msg = `📈 *VIEW STATUS*\n\n`;
    for (const [id, data] of publishedVideos.entries()) {
        const hoursAgo = ((Date.now() - data.publishTime) / (1000 * 60 * 60)).toFixed(1);
        const emoji = data.status === 'checking' ? '⏳' : data.status === 'success' ? '✅' : '🔄';
        msg += `${emoji} *${data.title.substring(0, 30)}*\n   ⏰ ${hoursAgo}h | ${data.status}\n`;
        if (data.viewCount) msg += `   👁️ ${data.viewCount} views\n`;
        msg += `\n`;
    }
    await ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📥 DOWNLOAD VIDEO', async (ctx) => {
    await ctx.reply('📹 Send YouTube URL:');
    bot.once('text', async (ctx) => {
        const url = ctx.message.text;
        if (url && (url.includes('youtube.com') || url.includes('youtu.be'))) {
            await ctx.reply('⏳ Downloading with smart scroll...');
            const result = await downloader.downloadFromYTDown(url);
            if (result) await ctx.reply(`✅ [Download Video](${result})`, { parse_mode: 'Markdown' });
            else await ctx.reply('❌ Failed');
        } else await ctx.reply('❌ Invalid URL');
    });
});

bot.hears('📹 LATEST POST', async (ctx) => {
    const latestPost = await getLatestPost();
    if(!latestPost) return ctx.reply('❌ No post', menu);
    await ctx.reply(`*Latest:* ${latestPost.title}\n⏰ ${getTimeAgo(latestPost.publishedAt)}\n🔗 ${latestPost.url}`, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📦 SUPPLY', async (ctx) => {
    const scheduled = await getScheduledShorts();
    if(!scheduled.length) return ctx.reply('📭 No scheduled shorts', menu);
    let msg = `📦 *SUPPLY (${scheduled.length})*\n\n`;
    scheduled.slice(0, 10).forEach((s,i) => msg += `${i+1}. ${s.title.substring(0, 40)}\n   ⏰ ${s.time.toLocaleString()}\n\n`);
    await ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('🔄 REFRESH', async (ctx) => {
    scheduledCache = null;
    await ctx.reply('🔄 Refreshing...');
    const scheduled = await getScheduledShorts(true);
    await ctx.reply(`✅ Refreshed\n📅 Scheduled: ${scheduled.length}`, menu);
});

process.on('SIGINT', async () => {
    await downloader.closeBrowser();
    bot.stop('SIGINT');
    process.exit();
});

bot.launch();
console.log('🤖 Bot started');

setTimeout(async () => {
    const latest = await getLatestPost();
    if(latest) { lastVideoId = latest.id; console.log(`📹 Initial ID: ${latest.id}`); }
}, 2000);

setInterval(monitor, 30000);
monitor();
