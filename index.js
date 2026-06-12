const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const CLIENT_ID = '635922113777-8c182r05vi5ve32nkqgqc2n5bbldhn18.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04F_QRLOYNyOdCgYIARAAGAQSNwF-L9IrWsT9K73DNxaQfqrmd6fgYUhdeQaFAvSJtB8y3eV6ZA3skvwUfUacaRTr53opx0mrn_k';
const API_KEY = 'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg';

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

let adminChatId = null;
let lastVideoId = null;
let isProcessing = false;
let totalPublished = 0;
let botStartTime = new Date();

app.get('/', (req, res) => res.send('Bot Running'));
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res);
  res.sendStatus(200);
});

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

let youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
const youtubePublic = google.youtube({ version: 'v3', auth: API_KEY });

async function sendLog(msg) {
  if (adminChatId) {
    try { await bot.telegram.sendMessage(adminChatId, msg, { parse_mode: 'Markdown' }); } 
    catch(e) { console.error('Log failed:', e.message); }
  }
}

async function refreshToken() {
  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
    console.log('✅ Token refreshed');
    await sendLog('✅ **Token refreshed**');
    return true;
  } catch (error) {
    console.error('Token refresh failed:', error.message);
    await sendLog(`❌ **Token refresh failed**\n${error.message}`);
    return false;
  }
}

setInterval(async () => { await refreshToken(); }, 45 * 60 * 1000);

function getPlaylistId(channelId) {
  return channelId?.startsWith('UC') ? `UU${channelId.substring(2)}` : null;
}

async function retryOp(operation, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try { return await operation(); } 
    catch(error) {
      if (i === maxRetries - 1) throw error;
      if (error.message.includes('invalid_grant') || error.message.includes('expired')) await refreshToken();
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

async function getScheduled() {
  return await retryOp(async () => {
    const playlistId = getPlaylistId(YOUR_CHANNEL_ID);
    if (!playlistId) return [];
    
    const res = await youtubeAuth.playlistItems.list({ part: 'snippet', playlistId, maxResults: 50 });
    const scheduled = [];
    
    for (const item of res.data.items || []) {
      const videoId = item.snippet.resourceId.videoId;
      const videoRes = await youtubeAuth.videos.list({ part: 'status,snippet', id: videoId });
      const status = videoRes.data.items?.[0]?.status;
      
      if (status?.privacyStatus === 'private' && status?.publishAt) {
        const publishTime = new Date(status.publishAt);
        if (publishTime > new Date()) {
          scheduled.push({
            id: videoId,
            title: videoRes.data.items[0].snippet.title,
            time: publishTime,
            url: `https://youtu.be/${videoId}`
          });
        }
      }
    }
    scheduled.sort((a, b) => a.time - b.time);
    return scheduled;
  });
}

async function getPublicCount() {
  return await retryOp(async () => {
    let publicCount = 0, nextPageToken = null;
    do {
      const searchRes = await youtubeAuth.search.list({ part: 'snippet', channelId: YOUR_CHANNEL_ID, type: 'video', maxResults: 50, pageToken: nextPageToken });
      for (const item of searchRes.data.items || []) {
        const videoRes = await youtubeAuth.videos.list({ part: 'status', id: item.id.videoId });
        if (videoRes.data.items?.[0]?.status?.privacyStatus === 'public') publicCount++;
      }
      nextPageToken = searchRes.data.nextPageToken;
    } while (nextPageToken);
    return publicCount;
  });
}

async function publishVideo(videoId, title) {
  return await retryOp(async () => {
    await youtubeAuth.videos.update({ part: 'status', requestBody: { id: videoId, status: { privacyStatus: 'public', publishAt: null } } });
    totalPublished++;
    return true;
  });
}

async function monitor() {
  if (isProcessing) return;
  isProcessing = true;
  
  try {
    const playlistId = getPlaylistId(TARGET_CHANNEL_ID);
    if (!playlistId) return;
    
    const res = await youtubePublic.playlistItems.list({ part: 'snippet', playlistId, maxResults: 1 });
    const latest = res.data.items?.[0];
    if (!latest) return;
    
    const videoId = latest.snippet.resourceId.videoId;
    const videoTitle = latest.snippet.title;
    
    if (videoId !== lastVideoId && lastVideoId !== null) {
      console.log(`\n🎬 NEW: ${videoTitle}`);
      await sendLog(`🎬 **New video detected!**\n📹 ${videoTitle}\n🔗 [Watch](https://youtu.be/${videoId})`);
      
      const scheduled = await getScheduled();
      
      if (scheduled.length > 0) {
        const toPub = scheduled[0];
        await sendLog(`📤 **Publishing:** ${toPub.title}\n📅 Original: ${toPub.time.toLocaleString()}`);
        await publishVideo(toPub.id, toPub.title);
        await sendLog(`✅ **Published!**\n📹 ${toPub.title}\n📊 Remaining: ${scheduled.length - 1}\n📈 Total: ${totalPublished}`);
      } else {
        await sendLog(`⚠️ **No scheduled videos**\n💡 Upload a Short and choose "Schedule"`);
      }
    }
    lastVideoId = videoId;
  } catch (error) {
    console.error('Monitor error:', error.message);
  } finally {
    isProcessing = false;
  }
}

const bot = new Telegraf(BOT_TOKEN);
const menu = { reply_markup: { keyboard: [['📊 STATUS', '📦 SUPPLY'], ['📈 STATS', '🔄 REFRESH']], resize_keyboard: true } };

bot.command('start', async (ctx) => {
  adminChatId = ctx.chat.id;
  const scheduled = await getScheduled();
  const publicCount = await getPublicCount();
  const uptime = Math.floor((new Date() - botStartTime) / 60000);
  
  let msg = `🤖 *YouTube Timing Bot*\n━━━━━━━━━━━━━━\n📹 Public: ${publicCount}\n📅 Scheduled: ${scheduled.length}\n🎯 Target: @Tewahdotube-21\n📈 Published: ${totalPublished}\n⏱️ Uptime: ${uptime}m\n\n`;
  msg += scheduled.length > 0 ? `📋 *Next:*\n${scheduled[0].title}\n⏰ ${scheduled[0].time.toLocaleString()}` : '📭 *No scheduled shorts*\nUpload and choose "Schedule"';
  await ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📊 STATUS', async (ctx) => {
  const scheduled = await getScheduled();
  const publicCount = await getPublicCount();
  await ctx.reply(`📊 *STATUS*\n━━━━━━━━━━\n📹 Public: ${publicCount}\n📅 Scheduled: ${scheduled.length}\n🎯 Active: Yes\n🟢 Online`, { parse_mode: 'Markdown', ...menu });
});

bot.hears('📦 SUPPLY', async (ctx) => {
  const scheduled = await getScheduled();
  if (scheduled.length === 0) {
    await ctx.reply(`📭 *Empty supply*\nSchedule a Short to add it here`, { parse_mode: 'Markdown', ...menu });
  } else {
    let msg = `📦 *SUPPLY (${scheduled.length})*\n━━━━━━━━━━━━━━\n`;
    scheduled.forEach((s, i) => { msg += `${i+1}. ${s.title}\n   ⏰ ${s.time.toLocaleString()}\n\n`; });
    await ctx.reply(msg, { parse_mode: 'Markdown', ...menu });
  }
});

bot.hears('📈 STATS', async (ctx) => {
  const uptime = Math.floor((new Date() - botStartTime) / 60000);
  const scheduled = await getScheduled();
  await ctx.reply(`📈 *STATS*\n━━━━━━━━\n📅 Scheduled: ${scheduled.length}\n📤 Published: ${totalPublished}\n⏱️ Uptime: ${uptime}m\n🎯 Monitoring: Active`, { parse_mode: 'Markdown', ...menu });
});

bot.hears('🔄 REFRESH', async (ctx) => {
  await ctx.reply(`🔄 Refreshing...`);
  const scheduled = await getScheduled();
  await ctx.reply(`✅ Updated\n📅 Scheduled: ${scheduled.length}`, { parse_mode: 'Markdown', ...menu });
});

bot.catch((err, ctx) => console.error('Bot error:', err));

app.listen(PORT, async () => {
  console.log(`🌐 Server on port ${PORT}`);
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook/${BOT_TOKEN}`;
  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Webhook set`);
  } catch (err) { console.error('Webhook error:', err.message); }
  
  console.log('🚀 Bot started');
  setTimeout(async () => {
    const test = await youtubeAuth.channels.list({ part: 'id', mine: true });
    console.log('✅ Connected:', test.data.items?.[0]?.id);
  }, 2000);
});

setInterval(monitor, 30000);
monitor();

process.once('SIGINT', async () => { await bot.telegram.deleteWebhook(); bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', async () => { await bot.telegram.deleteWebhook(); bot.stop('SIGTERM'); process.exit(0); });
