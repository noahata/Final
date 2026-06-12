const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');

// ============ CREDENTIALS ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
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
let lastVideoId = null, isProcessing = false, scheduledCache = null, lastCache = 0;
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

function getYoutube() { return google.youtube({ version: 'v3', auth: getApiKey() }); }

// Token refresh
async function refreshToken() {
    try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
        console.log('✅ Token refreshed');
    } catch(e) { console.error('❌ Token refresh failed:', e.message); }
}
setInterval(refreshToken, 45 * 60 * 1000);

// Get scheduled shorts
async function getScheduledShorts(force=false) {
    const now = Date.now();
    if(!force && scheduledCache && (now - lastCache) < 60000) return scheduledCache;
    
    try {
        const playlistId = `UU${YOUR_CHANNEL_ID.substring(2)}`;
        const res = await youtubeAuth.playlistItems.list({ part: 'snippet', playlistId, maxResults: 50 });
        const scheduled = [];
        
        for(let i=0; i<(res.data.items||[]).length; i+=10) {
            const batch = res.data.items.slice(i, i+10);
            const videoIds = batch.map(item => item.snippet.resourceId.videoId);
            const videoRes = await youtubeAuth.videos.list({ part: 'status,snippet', id: videoIds.join(',') });
            
            for(const video of videoRes.data.items||[]) {
                const status = video?.status;
                if(status?.privacyStatus === 'private' && status?.publishAt) {
                    const publishTime = new Date(status.publishAt);
                    if(publishTime > new Date()) scheduled.push({ id: video.id, title: video.snippet.title, time: publishTime });
                }
            }
        }
        scheduled.sort((a,b) => a.time - b.time);
        scheduledCache = scheduled;
        lastCache = now;
        return scheduled;
    } catch(e) { return []; }
}

// Publish video
async function publishVideo(id, title) {
    try {
        await youtubeAuth.videos.update({ part: 'status', requestBody: { id, status: { privacyStatus: 'public', publishAt: null } } });
        console.log(`✅ Published: ${title}`);
        scheduledCache = null;
        return true;
    } catch(e) { return false; }
}

// Monitor target channel
async function monitor() {
    if(isProcessing) return;
    isProcessing = true;
    
    try {
        const youtube = getYoutube();
        if(!youtube) return;
        
        const playlistId = `UU${TARGET_CHANNEL_ID.substring(2)}`;
        const res = await youtube.playlistItems.list({ part: 'snippet', playlistId, maxResults: 1 });
        const latest = res.data.items?.[0];
        if(!latest) return;
        
        const videoId = latest.snippet.resourceId.videoId;
        if(videoId !== lastVideoId && lastVideoId !== null) {
            console.log(`\n🎬 NEW VIDEO: ${latest.snippet.title}`);
            const scheduled = await getScheduledShorts(true);
            
            if(scheduled.length > 0) {
                const toPublish = scheduled[0];
                console.log(`📤 Publishing: ${toPublish.title}`);
                await publishVideo(toPublish.id, toPublish.title);
            } else console.log(`❌ No scheduled videos`);
        }
        lastVideoId = videoId;
    } catch(e) { console.error('Monitor error:', e.message); }
    finally { isProcessing = false; }
}

// Get public video count
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

// ============ TELEGRAM BOT (MINIMAL) ============
const bot = new Telegraf(BOT_TOKEN);
const menu = { reply_markup: { keyboard: [['📊 STATUS', '📦 SUPPLY'], ['🔄 REFRESH']], resize_keyboard: true } };

bot.command('start', async (ctx) => {
    const scheduled = await getScheduledShorts();
    const publicCount = await getPublicCount();
    let msg = `🤖 *YT Bot*\n📹 Public: ${publicCount}\n📅 Scheduled: ${scheduled.length}\n🎯 Monitoring\n`;
    msg += scheduled.length ? `📋 Next: ${scheduled[0].title}\n⏰ ${scheduled[0].time.toLocaleString()}` : '📭 No scheduled shorts';
    ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📊 STATUS', async (ctx) => {
    const scheduled = await getScheduledShorts();
    const publicCount = await getPublicCount();
    ctx.reply(`📊 *STATUS*\n📹 Public: ${publicCount}\n📅 Scheduled: ${scheduled.length}\n🎯 Active`, { parse_mode: 'Markdown', ...menu });
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
    ctx.reply('✅ Refreshed');
});

bot.launch();
console.log('🤖 Bot started');

// ============ START ============
console.log(`🚀 Started\n📤 Your: ${YOUR_CHANNEL_ID}\n🎯 Target: ${TARGET_CHANNEL_ID}\n🔑 Keys: ${API_KEYS.length}`);

// Initial check
setTimeout(async () => {
    const stats = await getScheduledShorts();
    console.log(`📊 Initial: ${stats.length} scheduled videos`);
}, 2000);

// Monitor every 30 seconds
setInterval(monitor, 30000);
monitor();

// Stats every 5 min
setInterval(async () => {
    const stats = await getScheduledShorts();
    console.log(`📊 [${new Date().toLocaleTimeString()}] Scheduled: ${stats.length}`);
}, 300000);
