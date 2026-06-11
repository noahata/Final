const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');

// ============ ENVIRONMENT VARIABLES ============
const BOT_TOKEN = process.env.BOT_TOKEN;

const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const CLIENT_ID = '39782137338-niqk6sud510hbe7cvj6o6jhjdu52kktl';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04t-MSLMiJSi8CgYIARAAGAQSNwF-L9IrbRXm4tDNl2pBvs4BhdLeVkx76PLDtLbEDw4ZbqRVR19d-ZpL0Sy6G1W6UYd_tIQbPgM';
const API_KEY = 'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg';
// =================================================

const PORT = process.env.PORT || 3000;

let lastVideoId = null;
let lastPublishedTime = null;

const app = express();
app.get('/', (req, res) => res.send('Bot Running'));
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is missing!');
    process.exit(1);
}

// Setup OAuth for YOUR channel
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

// For monitoring target channel
const youtube = google.youtube({ version: 'v3', auth: API_KEY });

// ============ KEYBOARD MENU ============
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            ['📊 STATUS', '📦 SUPPLY'],
            ['🔄 REFRESH']
        ],
        resize_keyboard: true
    }
};

// ============ FIXED - Get scheduled shorts ============
async function getScheduledShorts() {
    try {
        const response = await youtubeAuth.search.list({
            part: 'snippet',
            channelId: YOUR_CHANNEL_ID,
            type: 'video',
            maxResults: 50
        });
        
        const scheduled = [];
        for (const item of response.data.items || []) {
            try {
                const videoRes = await youtubeAuth.videos.list({
                    part: 'status, snippet',
                    id: item.id.videoId
                });
                
                if (!videoRes.data.items?.length) continue;
                
                const video = videoRes.data.items[0];
                const status = video.status;
                const publishAt = status.publishAt;
                
                // Check if it's scheduled (privacyStatus = 'private' AND publishAt exists)
                if (status.privacyStatus === 'private' && publishAt) {
                    const scheduledTime = new Date(publishAt);
                    const now = new Date();
                    
                    // Only show future scheduled videos
                    if (scheduledTime > now) {
                        scheduled.push({
                            id: item.id.videoId,
                            title: video.snippet.title,
                            time: scheduledTime
                        });
                    }
                }
            } catch (e) {
                console.error('Error fetching video:', e.message);
            }
        }
        
        scheduled.sort((a, b) => a.time - b.time);
        console.log(`📹 Found ${scheduled.length} scheduled shorts`);
        return scheduled;
    } catch (error) {
        console.error('Error fetching scheduled shorts:', error.message);
        return [];
    }
}

// Get oldest scheduled short
async function getOldestScheduledShort() {
    const shorts = await getScheduledShorts();
    return shorts[0] || null;
}

// Make video public
async function makePublic(videoId, title) {
    try {
        await youtubeAuth.videos.update({
            part: 'status',
            requestBody: {
                id: videoId,
                status: { privacyStatus: 'public', publishAt: null }
            }
        });
        console.log(`✅ Made PUBLIC: ${title}`);
        return true;
    } catch (error) {
        console.error(`Failed: ${error.message}`);
        return false;
    }
}

// Calculate delay to post at exact same time
function calculateDelay(targetTime) {
    const now = new Date();
    const target = new Date(targetTime);
    const delay = target.getTime() - now.getTime();
    return delay > 0 ? delay : 0;
}

// Monitor target channel
async function monitorTarget() {
    try {
        const res = await youtube.playlistItems.list({
            part: 'snippet',
            playlistId: `UU${TARGET_CHANNEL_ID.substring(2)}`,
            maxResults: 1
        });
        
        const latest = res.data.items?.[0];
        if (!latest) return;
        
        const videoId = latest.snippet.resourceId.videoId;
        const publishedAt = latest.snippet.publishedAt;
        const videoTitle = latest.snippet.title;
        const uploadTime = new Date(publishedAt).getTime();
        const now = Date.now();
        
        // Ignore videos older than 1 minute
        if (now - uploadTime > 60 * 1000) return;
        
        // First run: just remember the last video, do NOT publish
        if (!lastVideoId) {
            lastVideoId = videoId;
            console.log(`📌 Initialized. Last video: ${videoId}`);
            return;
        }
        
        if (videoId !== lastVideoId) {
            lastVideoId = videoId;
            console.log(`\n🎬 NEW SHORT DETECTED!`);
            console.log(`📹 Title: ${videoTitle}`);
            console.log(`⏰ Target posted at: ${publishedAt}`);
            
            const scheduled = await getOldestScheduledShort();
            if (!scheduled) {
                console.log('❌ No scheduled shorts found');
                return;
            }
            
            const delay = calculateDelay(publishedAt);
            
            if (delay > 0) {
                console.log(`⏰ Waiting ${Math.round(delay / 1000)} seconds to post at exact time...`);
                console.log(`📤 Will publish: ${scheduled.title}`);
                
                setTimeout(async () => {
                    await makePublic(scheduled.id, scheduled.title);
                    console.log(`✅ Published at exact time!`);
                    lastPublishedTime = new Date();
                }, delay);
            } else {
                console.log(`⚠️ Time already passed, publishing now...`);
                await makePublic(scheduled.id, scheduled.title);
            }
        }
    } catch (error) {
        console.error('Monitor error:', error.message);
    }
}

// ============ BOT COMMANDS ============
const bot = new Telegraf(BOT_TOKEN);

bot.command('start', async (ctx) => {
    const shorts = await getScheduledShorts();
    await ctx.reply(
        `🤖 *YouTube Timing Bot*\n\n` +
        `📹 Scheduled shorts: ${shorts.length}\n` +
        `🎯 Monitoring: @Tewahdotube-21\n` +
        `📤 Your channel: ${YOUR_CHANNEL_ID}\n` +
        `🟢 Status: Active\n` +
        `🔓 Unlimited copies\n` +
        `⏰ Posts at EXACT same time!\n\n` +
        `👇 Tap any button`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

bot.hears('📊 STATUS', async (ctx) => {
    const shorts = await getScheduledShorts();
    await ctx.reply(
        `📊 *STATUS*\n\n` +
        `📹 Scheduled shorts: ${shorts.length}\n` +
        `🎯 Target: @Tewahdotube-21\n` +
        `🟢 Monitoring: ✅ Active\n` +
        `🔓 Unlimited copies\n` +
        `⏰ Exact time matching: ON`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

bot.hears('📦 SUPPLY', async (ctx) => {
    const shorts = await getScheduledShorts();
    if (shorts.length === 0) {
        await ctx.reply(
            `📭 *No scheduled shorts found*\n\n` +
            `1. Upload a Short to YouTube\n` +
            `2. Choose "Schedule" (NOT Public)\n` +
            `3. Pick a future date/time\n` +
            `4. Click "Schedule"\n\n` +
            `Then tap REFRESH button.`,
            { parse_mode: 'Markdown', ...mainKeyboard }
        );
    } else {
        let msg = `📦 *YOUR SUPPLY (${shorts.length})*\n\n`;
        shorts.forEach((s, i) => {
            msg += `${i+1}. ${s.title}\n   ⏰ ${s.time.toLocaleString()}\n\n`;
        });
        await ctx.reply(msg, { parse_mode: 'Markdown', ...mainKeyboard });
    }
});

bot.hears('🔄 REFRESH', async (ctx) => {
    await ctx.reply(`🔄 Refreshing...`);
    const shorts = await getScheduledShorts();
    await ctx.reply(
        `✅ *Updated*\n\n📹 Scheduled shorts: ${shorts.length}\n🔓 Unlimited copies`,
        { parse_mode: 'Markdown', ...mainKeyboard }
    );
});

bot.catch((err, ctx) => {
    console.error(`Bot error:`, err);
});

bot.launch();
console.log('🤖 Bot started');

// ============ START MONITORING ============
console.log('🚀 Starting YouTube Timing Bot...');
console.log(`📤 Your Channel: ${YOUR_CHANNEL_ID}`);
console.log(`🎯 Target: @Tewahdotube-21`);
console.log(`🔓 Unlimited copies`);
console.log(`⏰ Posts at EXACT same time as target!`);
console.log(`🔍 Monitoring every 30 seconds...`);

monitorTarget();
setInterval(monitorTarget, 30000);
