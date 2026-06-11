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

// Setup OAuth2 Client with auto-refresh
const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID, 
  CLIENT_SECRET, 
  'https://developers.google.com/oauthplayground'
);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

// Initialize YouTube clients
let youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
const youtubePublic = google.youtube({ version: 'v3', auth: API_KEY });

let lastVideoId = null;
let isProcessing = false;

// ============ TOKEN MANAGEMENT ============
async function ensureValidToken() {
  try {
    const tokenInfo = await oauth2Client.getAccessToken();
    if (!tokenInfo.token) {
      console.log('🔄 No token found, refreshing...');
      await refreshToken();
    }
    return true;
  } catch (error) {
    if (error.message.includes('invalid_grant') || error.message.includes('expired')) {
      console.log('🔄 Token expired, refreshing...');
      await refreshToken();
    } else {
      console.error('❌ Token check error:', error.message);
      throw error;
    }
  }
}

async function refreshToken() {
  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    console.log('✅ Token refreshed successfully');
    
    // Update the YouTube client with new credentials
    youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
    
    // Save new refresh token if provided
    if (credentials.refresh_token && credentials.refresh_token !== REFRESH_TOKEN) {
      console.log('⚠️ New refresh token received. Update your code with:', credentials.refresh_token);
    }
    
    return true;
  } catch (error) {
    console.error('❌ Token refresh failed:', error.message);
    throw error;
  }
}

// Auto-refresh token every 45 minutes (before it expires)
setInterval(async () => {
  try {
    await refreshToken();
  } catch (error) {
    console.error('❌ Scheduled token refresh failed:', error.message);
  }
}, 45 * 60 * 1000);

// ============ HELPER FUNCTIONS ============
function getPlaylistId(channelId) {
  // Convert channel ID to uploads playlist ID
  if (channelId.startsWith('UC')) {
    return `UU${channelId.substring(2)}`;
  }
  return null;
}

async function retryOperation(operation, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      
      // If token error, refresh and retry
      if (error.message.includes('invalid_grant') || error.message.includes('expired')) {
        await refreshToken();
      }
      
      console.log(`🔄 Retry ${i + 1}/${maxRetries} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }
}

// ============ GET SCHEDULED SHORTS ============
async function getScheduledShorts() {
  return await retryOperation(async () => {
    await ensureValidToken();
    
    const playlistId = getPlaylistId(YOUR_CHANNEL_ID);
    if (!playlistId) {
      console.error('❌ Invalid channel ID format');
      return [];
    }
    
    // Get all uploads
    const res = await youtubeAuth.playlistItems.list({
      part: 'snippet',
      playlistId: playlistId,
      maxResults: 50
    });

    const scheduled = [];
    
    for (const item of res.data.items || []) {
      const videoId = item.snippet.resourceId.videoId;
      
      const videoRes = await youtubeAuth.videos.list({
        part: 'status,snippet',
        id: videoId
      });
      
      const video = videoRes.data.items?.[0];
      const status = video?.status;
      
      // Check if video is scheduled
      if (status?.privacyStatus === 'private' && status?.publishAt) {
        const publishTime = new Date(status.publishAt);
        if (publishTime > new Date()) {
          scheduled.push({
            id: videoId,
            title: video.snippet.title,
            time: publishTime,
            description: video.snippet.description
          });
        }
      }
    }
    
    // Sort by publish time (earliest first)
    scheduled.sort((a, b) => a.time - b.time);
    
    console.log(`📹 Found ${scheduled.length} scheduled videos`);
    return scheduled;
  });
}

// ============ GET PUBLIC VIDEO COUNT ============
async function getPublicVideoCount() {
  return await retryOperation(async () => {
    await ensureValidToken();
    
    let publicCount = 0;
    let nextPageToken = null;
    
    do {
      const searchRes = await youtubeAuth.search.list({
        part: 'snippet',
        channelId: YOUR_CHANNEL_ID,
        type: 'video',
        maxResults: 50,
        pageToken: nextPageToken
      });
      
      for (const item of searchRes.data.items || []) {
        const videoRes = await youtubeAuth.videos.list({
          part: 'status',
          id: item.id.videoId
        });
        
        const status = videoRes.data.items?.[0]?.status;
        if (status?.privacyStatus === 'public') {
          publicCount++;
        }
      }
      
      nextPageToken = searchRes.data.nextPageToken;
    } while (nextPageToken);
    
    return publicCount;
  });
}

// ============ GET VIDEO STATS ============
async function getVideoStats() {
  const scheduled = await getScheduledShorts();
  const publicCount = await getPublicVideoCount();
  
  return {
    publicCount,
    scheduledCount: scheduled.length,
    scheduled
  };
}

// ============ PUBLISH VIDEO ============
async function publishVideo(videoId, videoTitle) {
  return await retryOperation(async () => {
    await ensureValidToken();
    
    console.log(`📤 Publishing scheduled video: ${videoTitle}`);
    
    await youtubeAuth.videos.update({
      part: 'status',
      requestBody: {
        id: videoId,
        status: {
          privacyStatus: 'public',
          publishAt: null
        }
      }
    });
    
    console.log(`✅ Published video: ${videoTitle} (${videoId})`);
    return true;
  });
}

// ============ MONITOR TARGET CHANNEL ============
async function monitorTargetChannel() {
  if (isProcessing) {
    console.log('⏳ Already processing, skipping...');
    return;
  }
  
  isProcessing = true;
  
  try {
    const playlistId = getPlaylistId(TARGET_CHANNEL_ID);
    if (!playlistId) {
      console.error('❌ Invalid target channel ID');
      return;
    }
    
    const res = await youtubePublic.playlistItems.list({
      part: 'snippet',
      playlistId: playlistId,
      maxResults: 1
    });

    const latest = res.data.items?.[0];
    if (!latest) return;
    
    const videoId = latest.snippet.resourceId.videoId;
    const videoTitle = latest.snippet.title;
    const publishedAt = latest.snippet.publishedAt;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    
    if (videoId !== lastVideoId && lastVideoId !== null) {
      console.log(`\n🎬 NEW VIDEO DETECTED!`);
      console.log(`📹 Title: ${videoTitle}`);
      console.log(`⏰ Time: ${publishedAt}`);
      console.log(`🔗 URL: ${videoUrl}`);
      console.log(`👤 Channel: ${TARGET_CHANNEL_ID}`);
      console.log(`---`);
      
      // Get scheduled shorts
      const scheduled = await getScheduledShorts();
      
      if (scheduled.length > 0) {
        const toPublish = scheduled[0];
        console.log(`📤 Publishing scheduled video: ${toPublish.title}`);
        console.log(`📅 Originally scheduled for: ${toPublish.time.toLocaleString()}`);
        
        await publishVideo(toPublish.id, toPublish.title);
        
        console.log(`✅ Published video: ${toPublish.title}`);
        console.log(`📊 Remaining scheduled videos: ${scheduled.length - 1}`);
        console.log(`---\n`);
        
        // Try to send Telegram notification
        try {
          // You can add a chat ID here to send notifications to a specific user
          // await bot.telegram.sendMessage(YOUR_CHAT_ID, 
          //   `✅ Auto-published: "${toPublish.title}"\n` +
          //   `🎯 Triggered by: "${videoTitle}"\n` +
          //   `📅 Original schedule: ${toPublish.time.toLocaleString()}`
          // );
        } catch (err) {
          console.log('Telegram notification failed');
        }
      } else {
        console.log(`❌ No scheduled videos to publish`);
        console.log(`💡 Tip: Upload a Short and choose "Schedule" instead of "Public"`);
        console.log(`---\n`);
      }
    }
    
    lastVideoId = videoId;
  } catch (error) {
    console.error('❌ Monitor error:', error.message);
  } finally {
    isProcessing = false;
  }
}

// ============ TEST ACCESS ============
async function testAccess() {
  console.log('\n🔍 === TESTING ACCESS ===');
  
  try {
    await ensureValidToken();
    const test = await youtubeAuth.channels.list({
      part: 'id',
      mine: true
    });
    console.log('✅ OAuth token works! Connected to channel:', test.data.items?.[0]?.id);
  } catch (error) {
    console.error('❌ OAuth token error:', error.message);
  }
  
  try {
    const test = await youtubePublic.channels.list({
      part: 'id',
      id: TARGET_CHANNEL_ID
    });
    console.log('✅ API key works! Found target channel:', test.data.items?.[0]?.id);
  } catch (error) {
    console.error('❌ API key error:', error.message);
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
  let message = `🤖 *YouTube Timing Bot*\n\n` +
    `📹 Public videos: ${stats.publicCount}\n` +
    `📅 Scheduled shorts: ${stats.scheduledCount}\n` +
    `🎯 Monitoring channel: @Tewahdotube-21\n` +
    `🟢 Status: Active\n\n`;
  
  if (stats.scheduled.length > 0) {
    message += `📋 *Next scheduled:*\n${stats.scheduled[0].title}\n⏰ ${stats.scheduled[0].time.toLocaleString()}`;
  } else {
    message += `📭 *No scheduled shorts*\n\nUpload a Short and choose "Schedule" instead of "Public" or "Unlisted"`;
  }
  
  await ctx.reply(message, { parse_mode: 'Markdown', ...mainMenu });
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
    await ctx.reply(
      `📭 *No scheduled shorts*\n\nUpload a Short and choose "Schedule" (not "Public" or "Unlisted") to add it to your supply.`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  } else {
    let message = `📦 *YOUR SUPPLY (${stats.scheduled.length})*\n\n`;
    stats.scheduled.forEach((s, i) => {
      message += `${i+1}. ${s.title}\n   ⏰ ${s.time.toLocaleString()}\n\n`;
    });
    await ctx.reply(message, { parse_mode: 'Markdown', ...mainMenu });
  }
});

bot.hears('🔄 REFRESH', async (ctx) => {
  await ctx.reply(`🔄 Refreshing data...`);
  const stats = await getVideoStats();
  await ctx.reply(
    `✅ Updated\n📹 Public: ${stats.publicCount}\n📅 Scheduled: ${stats.scheduledCount}`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

bot.catch((err, ctx) => {
  console.error('❌ Bot error:', err);
  ctx.reply('An error occurred. Please try again later.');
});

// Launch bot
bot.launch().then(() => {
  console.log('🤖 Telegram bot started');
}).catch(err => {
  console.error('❌ Failed to start bot:', err);
});

// ============ START APPLICATION ============
console.log('\n🚀 Starting YouTube Timing Bot...');
console.log(`📤 Your Channel ID: ${YOUR_CHANNEL_ID}`);
console.log(`🎯 Target Channel ID: ${TARGET_CHANNEL_ID}`);

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('🛑 Shutting down...');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('🛑 Shutting down...');
  bot.stop('SIGTERM');
  process.exit(0);
});

// Initial setup
setTimeout(async () => {
  await testAccess();
  const stats = await getVideoStats();
  console.log(`\n📊 Initial stats:`);
  console.log(`   - Public videos: ${stats.publicCount}`);
  console.log(`   - Scheduled videos: ${stats.scheduledCount}`);
  
  if (stats.scheduled.length > 0) {
    console.log(`   - Next scheduled: "${stats.scheduled[0].title}"`);
    console.log(`   - Scheduled for: ${stats.scheduled[0].time.toLocaleString()}`);
  }
  console.log('');
}, 2000);

// Start monitoring (every 30 seconds)
setInterval(monitorTargetChannel, 30000);
monitorTargetChannel();

// Show periodic stats (every 5 minutes)
setInterval(async () => {
  const stats = await getVideoStats();
  console.log(`📊 [${new Date().toLocaleTimeString()}] Stats - Public: ${stats.publicCount}, Scheduled: ${stats.scheduledCount}`);
}, 300000);
