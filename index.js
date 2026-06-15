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
