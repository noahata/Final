const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');

// ============ TELEGRAM BOT TOKEN ============
const BOT_TOKEN = process.env.BOT_TOKEN;

// ============ YOUR CREDENTIALS ============
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

// Setup OAuth
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
const youtube = google.youtube({ version: 'v3', auth: API_KEY });

let lastVideoId = null;

// ============ DEBUG: TEST ACCESS ============
async function testAccess() {
    console.log('\n🔍 === TESTING ACCESS ===');
    try {
        const test = await youtubeAuth.channels.list({
            part: 'id',
            mine: true
        });
        console.log('✅ Token works! Connected to channel:', test.data.items[0]?.id);
    } catch (error) {
        console.error('❌ Token error:', error.message);
    }
}

// ============ GET SCHEDULED SHORTS (WORKING VERSION) ============
async function getScheduledShorts() {
    try {
        // Get all playlist items from your channel
        const res = await youtubeAuth.playlistItems.list({
            part: 'snippet',
            playlistId: `UU${YOUR_CHANNEL_ID.substring(2)}`,
            maxResults: 50
        });
        
        const scheduled = [];
        
        for (const item of res.data.items || []) {
            const videoRes = await youtubeAuth.videos.list({
                part: 'status',
                id: item.snippet.resourceId.videoId
            });
            
            const status = videoRes.data.items[0]?.status;
            
            // Scheduled: privacyStatus = 'private' AND publishAt exists
            if (status?.privacyStatus === 'private' && status?.publishAt) {
                const publishTime = new Date(status.publishAt);
                if (publishTime > new Date()) {
                    scheduled.push({
                        id: item.snippet.resourceId.videoId,
                        title: item.snippet.title,
                        time: publishTime
                    });
                }
            }
        }
        
        console.log(`📹 Found ${scheduled.length} scheduled videos`);
        return scheduled;
    } catch (error) {
        console.error('Error getting scheduled:', error.message);
        return [];
    }
}

// ============ GET VIDEO STATS ============
async function getVideoStats() {
    const scheduled = await getScheduledShorts();
    
    // Get public videos count
    let publicCount = 0;
    try {
        const searchRes = await youtubeAuth.search.list({
            part: 'snippet',
            channelId: YOUR_CHANNEL_ID,
            type: 'video',
            maxResults: 50
        });
        
        for (const item of searchRes.data.items || []) {
            const videoRes = await youtubeAuth.videos.list({ part: 'status', id: item.id.videoId });
            const status = videoRes.data.items[0]?.status;
            if (status?.privacyStatus === 'public') {
                publicCount++;
            }
        }
    } catch (error) {
        console.error('Error getting public count:', error.message);
    }
    
    return { 
        publicCount, 
        scheduledCount: scheduled.length, 
        scheduled 
    };
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
            
            const scheduled = await getScheduledShorts();
            
            if (scheduled.length > 0) {
                const toPublish = scheduled[0];
                console.log(`📤 Publishing: ${toPublish.title}`);
                
                await youtubeAuth.videos.update({
                    part: 'status',
                    requestBody: {
                        id: toPublish.id,
                        status: { privacyStatus: 'public', publishAt: null }
                    }
                });
                console.log(`✅ Published successfully!`);
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

const mainMenu = {
    reply_markup: {
        keyboard: [['📊 STATUS', '📦 SUPPLY'], ['🔄 REFRESH']],
        resize_keyboard: true
    }
};

bot.command('start', async (ctx) => {
    const stats = await getVideoStats();
    await ctx.reply(
        `🤖 *YouTube Timing Bot*\n\n` +
        `📹 Public videos: ${stats.publicCount}\n` +
        `📅 Scheduled shorts: ${stats.scheduledCount}\n` +
        `🎯 Monitoring: @Tewahdotube-21\n` +
        `🟢 Status: Active\n\n` +
        `${stats.scheduled.length > 0 ? `📋 *Next scheduled:*\n${stats.scheduled[0].title}\n⏰ ${stats.scheduled[0].time.toLocaleString()}` : '📭 *No scheduled shorts*\n\nUpload a Short and choose "Schedule" instead of "Public"'}`,
        { parse_mode: 'Markdown', ...mainMenu }
    );
});

bot.hears('📊 STATUS', async (ctx) => {
    const stats = await getVideoStats();
    await ctx.reply(
        `📊 *STATUS*\n\n📹 Public: ${stats.publicCount}\n📅 Scheduled: ${stats.scheduledCount}\n🎯 Target: @Tewahdotube-21\n🟢 Active`,
        { parse_mode: 'Markdown', ...mainMenu }
    );
});

bot.hears('📦 SUPPLY', async (ctx) => {
    const stats = await getVideoStats();
    if (stats.scheduled.length === 0) {
        await ctx.reply(`📭 *No scheduled shorts*\n\nUpload a Short and choose "Schedule".`, { parse_mode: 'Markdown', ...mainMenu });
    } else {
        let msg = `📦 *YOUR SUPPLY (${stats.scheduled.length})*\n\n`;
        stats.scheduled.forEach((s, i) => {
            msg += `${i+1}. ${s.title}\n   ⏰ ${s.time.toLocaleString()}\n\n`;
        });
        await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
    }
});

bot.hears('🔄 REFRESH', async (ctx) => {
    await ctx.reply(`🔄 Refreshing...`);
    const stats = await getVideoStats();
    await ctx.reply(`✅ Updated\n📹 Public: ${stats.publicCount}\n📅 Scheduled: ${stats.scheduledCount}`, { parse_mode: 'Markdown', ...mainMenu });
});

bot.catch((err, ctx) => console.error('Bot error:', err));
bot.launch();
console.log('🤖 Telegram bot started');

// ============ START ============
console.log('🚀 Starting YouTube Timing Bot...');
console.log(`📤 Your Channel ID: ${YOUR_CHANNEL_ID}`);
console.log(`🎯 Target: @Tewahdotube-21`);

// Run tests
setTimeout(async () => {
    await testAccess();
    const stats = await getVideoStats();
    console.log(`📊 Initial stats - Public: ${stats.publicCount}, Scheduled: ${stats.scheduledCount}`);
    if (stats.scheduled.length > 0) {
        console.log(`📋 Next scheduled: ${stats.scheduled[0].title} at ${stats.scheduled[0].time.toLocaleString()}`);
    }
}, 2000);

// Monitor every 30 seconds
setInterval(monitor, 30000);
monitor();

// Show stats every 5 minutes
setInterval(async () => {
    const stats = await getVideoStats();
    console.log(`📊 Stats - Public: ${stats.publicCount}, Scheduled: ${stats.scheduledCount}`);
}, 300000);
