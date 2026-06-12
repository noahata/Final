const { google } = require('googleapis');
const express = require('express');
const path = require('path');

// ============ CREDENTIALS ============
const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const CLIENT_ID = '635922113777-8c182r05vi5ve32nkqgqc2n5bbldhn18.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04F_QRLOYNyOdCgYIARAAGAQSNwF-L9IrWsT9K73DNxaQfqrmd6fgYUhdeQaFAvSJtB8y3eV6ZA3skvwUfUacaRTr53opx0mrn_k';
const API_KEY = 'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg';

const PORT = process.env.PORT || 3000;
const app = express();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// CORS for all websites
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============ YOUTUBE SETUP WITH CORRECT SCOPES ============
const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID, 
  CLIENT_SECRET, 
  'https://developers.google.com/oauthplayground'
);

// Set credentials
oauth2Client.setCredentials({
  refresh_token: REFRESH_TOKEN,
  scope: 'https://www.googleapis.com/auth/youtube.force-ssl'
});

let youtubeAuth = null;
const youtubePublic = google.youtube({ version: 'v3', auth: API_KEY });

let lastVideoId = null;
let isProcessing = false;
let totalPublished = 0;
let botStartTime = new Date();
let publishHistory = [];
let isInitialized = false;

// ============ INITIALIZE AUTH ============
async function initializeAuth() {
  try {
    // Force token refresh on startup
    const { credentials } = await oauth2Client.refreshAccessToken();
    console.log('✅ Initial token obtained');
    
    // Create authenticated client
    youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
    
    // Verify access
    const test = await youtubeAuth.channels.list({ part: 'id', mine: true });
    console.log(`✅ Connected to channel: ${test.data.items?.[0]?.id}`);
    
    return true;
  } catch (error) {
    console.error('❌ Auth initialization failed:', error.message);
    return false;
  }
}

// ============ TOKEN REFRESH ============
async function refreshToken() {
  if (!youtubeAuth) return false;
  
  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
    console.log('✅ Token refreshed successfully');
    return true;
  } catch (error) {
    console.error('❌ Token refresh failed:', error.message);
    return false;
  }
}

// Refresh token every 50 minutes
setInterval(async () => {
  await refreshToken();
}, 50 * 60 * 1000);

// ============ HELPER FUNCTIONS ============
function getPlaylistId(channelId) {
  if (!channelId) return null;
  // Convert UC... to UU... for uploads playlist
  if (channelId.startsWith('UC')) {
    return `UU${channelId.substring(2)}`;
  }
  return null;
}

async function retryOperation(operation, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      const isTokenError = error.message.includes('invalid_grant') || 
                          error.message.includes('expired') ||
                          error.message.includes('auth');
      
      if (isTokenError && i < maxRetries - 1) {
        console.log(`Token error, refreshing... (attempt ${i + 1})`);
        await refreshToken();
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      
      if (i === maxRetries - 1) throw error;
      console.log(`Retry ${i + 1}/${maxRetries} after error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
    }
  }
}

// ============ GET SCHEDULED VIDEOS ============
async function getScheduled() {
  if (!youtubeAuth) {
    console.log('⚠️ Auth not ready, waiting...');
    return [];
  }
  
  return await retryOperation(async () => {
    const playlistId = getPlaylistId(YOUR_CHANNEL_ID);
    if (!playlistId) {
      console.error('❌ Invalid channel ID');
      return [];
    }
    
    console.log(`📡 Fetching uploads from playlist: ${playlistId}`);
    
    const res = await youtubeAuth.playlistItems.list({
      part: 'snippet',
      playlistId: playlistId,
      maxResults: 50
    });
    
    if (!res.data.items) return [];
    
    const scheduled = [];
    
    for (const item of res.data.items) {
      const videoId = item.snippet.resourceId.videoId;
      
      const videoRes = await youtubeAuth.videos.list({
        part: 'status,snippet',
        id: videoId
      });
      
      const video = videoRes.data.items?.[0];
      if (!video) continue;
      
      const status = video.status;
      
      // Check if video is scheduled (private + has publishAt)
      if (status?.privacyStatus === 'private' && status?.publishAt) {
        const publishTime = new Date(status.publishAt);
        const now = new Date();
        
        if (publishTime > now) {
          scheduled.push({
            id: videoId,
            title: video.snippet.title,
            time: publishTime,
            url: `https://youtu.be/${videoId}`,
            thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`
          });
          console.log(`  📹 Scheduled: "${video.snippet.title}" for ${publishTime.toLocaleString()}`);
        }
      }
    }
    
    scheduled.sort((a, b) => a.time - b.time);
    console.log(`📊 Total scheduled videos found: ${scheduled.length}`);
    return scheduled;
  });
}

// ============ GET PUBLIC VIDEO COUNT ============
async function getPublicCount() {
  if (!youtubeAuth) return 0;
  
  return await retryOperation(async () => {
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
        
        if (videoRes.data.items?.[0]?.status?.privacyStatus === 'public') {
          publicCount++;
        }
      }
      
      nextPageToken = searchRes.data.nextPageToken;
    } while (nextPageToken);
    
    return publicCount;
  });
}

// ============ PUBLISH VIDEO ============
async function publishVideo(videoId, title) {
  if (!youtubeAuth) return false;
  
  return await retryOperation(async () => {
    console.log(`📤 Publishing: ${title}`);
    
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
    
    totalPublished++;
    publishHistory.unshift({
      id: videoId,
      title: title,
      time: new Date().toISOString(),
      url: `https://youtu.be/${videoId}`
    });
    
    if (publishHistory.length > 20) publishHistory.pop();
    
    console.log(`✅ Successfully published: ${title}`);
    return true;
  });
}

// ============ MONITOR TARGET CHANNEL ============
async function monitor() {
  if (isProcessing) {
    console.log('⏳ Monitor already running, skipping...');
    return;
  }
  
  if (!youtubeAuth) {
    console.log('⚠️ Auth not ready, skipping monitor...');
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
    const videoUrl = `https://youtu.be/${videoId}`;
    
    if (videoId !== lastVideoId && lastVideoId !== null) {
      console.log(`\n🎬━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`🎬 NEW VIDEO DETECTED ON TARGET CHANNEL!`);
      console.log(`📹 Title: ${videoTitle}`);
      console.log(`🔗 URL: ${videoUrl}`);
      console.log(`⏰ Time: ${new Date().toLocaleString()}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      
      const scheduled = await getScheduled();
      
      if (scheduled.length > 0) {
        const toPublish = scheduled[0];
        console.log(`📦 Found ${scheduled.length} scheduled videos`);
        console.log(`🎯 Publishing oldest: "${toPublish.title}"`);
        console.log(`📅 Original schedule: ${toPublish.time.toLocaleString()}`);
        
        await publishVideo(toPublish.id, toPublish.title);
        
        const remaining = scheduled.length - 1;
        console.log(`✅ Published successfully!`);
        console.log(`📊 Remaining in supply: ${remaining}`);
        console.log(`📈 Total published to date: ${totalPublished}\n`);
      } else {
        console.log(`❌ No scheduled videos available to publish`);
        console.log(`💡 Tip: Upload a Short to YouTube and choose "Schedule" option\n`);
      }
    }
    
    lastVideoId = videoId;
  } catch (error) {
    console.error('❌ Monitor error:', error.message);
  } finally {
    isProcessing = false;
  }
}

// ============ API ENDPOINTS ============
app.get('/api/status', async (req, res) => {
  try {
    const scheduled = await getScheduled();
    const publicCount = await getPublicCount();
    res.json({
      success: true,
      data: {
        publicVideos: publicCount,
        scheduledShorts: scheduled.length,
        totalPublished: totalPublished,
        uptime: Math.floor((new Date() - botStartTime) / 1000),
        status: isInitialized ? 'active' : 'initializing',
        lastCheck: new Date().toISOString(),
        targetChannel: TARGET_CHANNEL_ID,
        yourChannel: YOUR_CHANNEL_ID
      }
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/supply', async (req, res) => {
  try {
    const scheduled = await getScheduled();
    res.json({
      success: true,
      data: {
        count: scheduled.length,
        videos: scheduled
      }
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/history', (req, res) => {
  res.json({
    success: true,
    data: publishHistory
  });
});

app.post('/api/publish', async (req, res) => {
  try {
    const scheduled = await getScheduled();
    if (scheduled.length > 0) {
      await publishVideo(scheduled[0].id, scheduled[0].title);
      res.json({ success: true, message: `Published: ${scheduled[0].title}` });
    } else {
      res.json({ success: false, message: 'No scheduled videos available' });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    await refreshToken();
    res.json({ success: true, message: 'Token refreshed' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Serve website
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START SERVER ============
async function startServer() {
  console.log('\n🚀 Starting YouTube Timing Bot...');
  console.log('═══════════════════════════════════════');
  
  // Initialize YouTube auth
  isInitialized = await initializeAuth();
  
  if (!isInitialized) {
    console.log('\n⚠️ WARNING: Auth initialization failed!');
    console.log('   Bot will retry authentication...');
    
    // Retry after 10 seconds
    setTimeout(async () => {
      isInitialized = await initializeAuth();
      if (isInitialized) {
        console.log('✅ Auth recovered on retry!');
        await monitor();
      }
    }, 10000);
  }
  
  // Start express server
  app.listen(PORT, () => {
    console.log(`\n🌐 Web server running on port ${PORT}`);
    console.log(`📊 Dashboard available at: http://localhost:${PORT}`);
    console.log(`✅ CORS enabled for all websites`);
    console.log('\n📡 API Endpoints:');
    console.log(`   GET  /api/status  - Bot statistics`);
    console.log(`   GET  /api/supply  - Scheduled videos`);
    console.log(`   GET  /api/history - Publish history`);
    console.log(`   POST /api/publish - Manual publish`);
    console.log(`   POST /api/refresh - Force token refresh`);
    console.log('\n═══════════════════════════════════════\n');
  });
  
  // Initial delay to let auth settle
  setTimeout(async () => {
    if (isInitialized) {
      const scheduled = await getScheduled();
      console.log(`📊 INITIAL STATUS:`);
      console.log(`   📅 Scheduled videos: ${scheduled.length}`);
      if (scheduled.length > 0) {
        console.log(`   📹 Next: "${scheduled[0].title}"`);
        console.log(`   ⏰ At: ${scheduled[0].time.toLocaleString()}`);
      }
      console.log(`   🎯 Monitoring: ${TARGET_CHANNEL_ID}`);
      console.log(`   🤖 Status: ACTIVE\n`);
    }
  }, 3000);
  
  // Start monitoring (every 30 seconds)
  setInterval(monitor, 30000);
  
  // First monitor after 10 seconds
  setTimeout(() => {
    if (isInitialized) monitor();
  }, 10000);
  
  // Periodic stats every 5 minutes
  setInterval(async () => {
    if (isInitialized) {
      const scheduled = await getScheduled();
      console.log(`📊 [${new Date().toLocaleTimeString()}] Scheduled: ${scheduled.length}, Published: ${totalPublished}`);
    }
  }, 300000);
}

startServer();

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('\n🛑 Shutting down...');
  process.exit(0);
});
