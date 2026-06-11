const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');

// ============ TELEGRAM BOT TOKEN ============
const BOT_TOKEN = process.env.BOT_TOKEN;

// ============ YOUTUBE CREDENTIALS ============
const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const CLIENT_ID = '635922113777-8c182r05vi5ve32nkqgqc2n5bbldhn18.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04F_QRLOYNyOdCgYIARAAGAQSNwF-L9IrWsT9K73DNxaQfqrmd6fgYUhdeQaFAvSJtB8y3eV6ZA3skvwUfUacaRTr53opx0mrn_k';
const API_KEY = 'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg';
// =========================================

const PORT = process.env.PORT || 3000;
const app = express();
app.get('/', (req, res) => res.send('Bot Running'));
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// Setup OAuth for YouTube
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
const youtube = google.youtube({ version: 'v3', auth: API_KEY });

let lastVideoId = null;

// ============ GET VIDEO STATS ============
async function getVideoStats() {
    try {
        const searchRes = await youtubeAuth.search.list({
            part: 'snippet',
            channelId: YOUR_CHANNEL_ID,
            type: 'video',
            maxResults: 50
        });
        
        let publicCount = 0;
        let privateCount = 0;
        let scheduledCount = 0;
        const scheduled = [];
        
        for (const item of searchRes.data.items || []) {
            const videoRes = await youtubeAuth.videos.list({ part: 'status', id: item.id.videoId });
            const status = videoRes.data.items[0]?.status;
            
            if (status?.privacyStatus === 'public') {
                publicCount++;
            } else if (status?.privacyStatus === 'private') {
                if (status?.publishAt && new Date(status.publishAt) > new Date()) {
                    scheduledCount++;
                    scheduled.push({
                        id: item.id.videoId,
                        title: item.snippet.title,
                        time: new Date(status.publishAt)
                    });
                } else {
                    privateCount++;
                }
            }
        }
        
        scheduled.sort((a, b) => a.time - b.time);
        
        return { publicCount, privateCount, scheduledCount, scheduled, total: searchRes.data.items?.length || 0 };
    } catch (error) {
        console.error('Error getting video stats:', error.message);
        return { publicCount: 0, privateCount: 0, scheduledCount: 0, scheduled: [], total: 0 };
    }
}

// ============ MONITOR TARGET CHANNEL ============
async function monitor() {
    try {
        const res = await youtube.playlistItems.list({
            part: 'snippet',
            playlistId: `UU${TARGET_CHANNEL_ID.substring(2)}`,
            maxResults: 1
        });
        
        const latest = res.data.items?.[0];
        if (!latest) return;
        
        const videoId = latest.snippet.resourceId.videoId;
        
        if (videoId !== lastVideoId && lastVideoId !== null) {
            console.log(`\n🎬 NEW SHORT DETECTED!`);
            console.log(`📹 Title: ${latest.snippet.title}`);
            console.log(`⏰ Time: ${latest.snippet.publishedAt}`);
            
            const stats = await getVideoStats();
            
            if (stats.scheduled.length > 0) {
                const toPublish = stats.scheduled[0];
                console.log(`📤 Publishing: ${toPublish.title}`);
                
                await youtubeAuth.videos.update({
                    part: 'status',
                    requestBody: {
                        id: toPublish.id,
                        status: { privacyStatus: 'public', publishAt: null }
                    }
                });
                console.log(`✅ Published successfully!`);
                console.log(`📊 Remaining scheduled: ${stats.scheduledCount - 1}`);
            } else {
                console.log(`❌ No scheduled shorts to publish`);
            }
        }
        lastVideoId = videoId;
    } catch (error) {
        console.error('Monitor error:', error.message);
    }
}

// ============ TELEGRAM BOT ============
const bot = new Telegraf(BOT_TOKEN);

// Keyboard buttons
const mainMenu = {
    reply_markup: {
        keyboard: [
            ['📊 STATUS', '📦 SUPPLY'],
            ['🔄 REFRESH']
        ],
        resize_keyboard: true
    }
};

// /start command
bot.command('start', async (ctx) => {
    const stats = await getVideoStats();
    await ctx.reply(
        `🤖 *YouTube Timing Bot*\n\n` +
        `📹 Public videos: ${stats.publicCount}\n` +
        `🔒 Private videos: ${stats.privateCount}\n` +
        `📅 Scheduled shorts: ${stats.scheduledCount}\n` +
        `🎯 Monitoring: @Tewahdotube-21\n` +
        `🟢 Status: Active\n\n` +
        `${stats.scheduled.length > 0 ? `📋 *Next scheduled:*\n${stats.scheduled[0].title}\n⏰ ${stats.scheduled[0].time.toLocaleString()}` : '📭 *No scheduled shorts*\n\nUpload a Short and choose "Schedule" instead of "Public"'}`,
        { parse_mode: 'Markdown', ...mainMenu }
    );
});

// STATUS button
bot.hears('📊 STATUS', async (ctx) => {
    const stats = await getVideoStats();
    await ctx.reply(
        `📊 *STATUS*\n\n` +
        `📹 Public: ${stats.publicCount}\n` +
        `🔒 Private: ${stats.privateCount}\n` +
        `📅 Scheduled: ${stats.scheduledCount}\n` +
        `🎯 Target: @Tewahdotube-21\n` +
        `🟢 Monitoring: Active`,
        { parse_mode: 'Markdown', ...mainMenu }
    );
});

// SUPPLY button
bot.hears('📦 SUPPLY', async (ctx) => {
    const stats = await getVideoStats();
    if (stats.scheduled.length === 0) {
        await ctx.reply(
            `📭 *No scheduled shorts*\n\n` +
            `Upload a Short to YouTube and choose "Schedule" instead of "Public".\n\n` +
            `Then tap REFRESH.`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    } else {
        let msg = `📦 *YOUR SUPPLY (${stats.scheduled.length})*\n\n`;
        stats.scheduled.forEach((s, i) => {
            msg += `${i+1}. ${s.title}\n   ⏰ ${s.time.toLocaleString()}\n\n`;
        });
        await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
    }
});

// REFRESH button
bot.hears('🔄 REFRESH', async (ctx) => {
    await ctx.reply(`🔄 Refreshing...`);
    const stats = await getVideoStats();
    await ctx.reply(
        `✅ *Updated*\n\n` +
        `📹 Public: ${stats.publicCount}\n` +
        `📅 Scheduled: ${stats.scheduledCount}`,
        { parse_mode: 'Markdown', ...mainMenu }
    );
});

// Handle errors
bot.catch((err, ctx) => {
    console.error('Bot error:', err);
});

bot.launch();
console.log('🤖 Telegram bot started');

// ============ START MONITORING ============
console.log('🚀 Starting YouTube Timing Bot...');
console.log(`📤 Your Channel ID: ${YOUR_CHANNEL_ID}`);
console.log(`🎯 Target: @Tewahdotube-21`);
console.log(`🔍 Monitoring every 30 seconds...`);

// Show stats on startup
setTimeout(async () => {
    const stats = await getVideoStats();
    console.log(`📊 Initial stats - Public: ${stats.publicCount}, Scheduled: ${stats.scheduledCount}`);
}, 3000);

// Monitor every 30 seconds
setInterval(monitor, 30000);
monitor();

// Show stats every 5 minutes
setInterval(async () => {
    const stats = await getVideoStats();
    console.log(`📊 Stats update - Public: ${stats.publicCount}, Scheduled: ${stats.scheduledCount}`);
}, 300000);
