const { google } = require('googleapis');
const express = require('express');

// ============ YOUR CREDENTIALS ============
const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const CLIENT_ID = '39782137338-niqk6sud510hbe7cvj6o6jhjdu52kktl';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04t-MSLMiJSi8CgYIARAAGAQSNwF-L9IrbRXm4tDNl2pBvs4BhdLeVkx76PLDtLbEDw4ZbqRVR19d-ZpL0Sy6G1W6UYd_tIQbPgM';
const API_KEY = 'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg';
// =========================================

const PORT = process.env.PORT || 3000;
const app = express();
app.get('/', (req, res) => res.send('Bot Running'));
app.listen(PORT);

// Setup OAuth for YOUR channel
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

// For monitoring target channel (public)
const youtube = google.youtube({ version: 'v3', auth: API_KEY });

let lastVideoId = null;

// Get YOUR scheduled shorts
async function getScheduledShorts() {
    try {
        const searchRes = await youtubeAuth.search.list({
            part: 'snippet',
            channelId: YOUR_CHANNEL_ID,
            type: 'video',
            maxResults: 50
        });
        
        const scheduled = [];
        for (const item of searchRes.data.items || []) {
            const videoRes = await youtubeAuth.videos.list({
                part: 'status',
                id: item.id.videoId
            });
            const status = videoRes.data.items[0]?.status;
            
            // Scheduled = private + publishAt exists + future date
            if (status?.privacyStatus === 'private' && status?.publishAt) {
                const scheduledTime = new Date(status.publishAt);
                if (scheduledTime > new Date()) {
                    scheduled.push({
                        id: item.id.videoId,
                        title: item.snippet.title,
                        time: scheduledTime
                    });
                }
            }
        }
        scheduled.sort((a, b) => a.time - b.time);
        console.log(`📹 Scheduled shorts found: ${scheduled.length}`);
        return scheduled;
    } catch (error) {
        console.error('Error getting scheduled shorts:', error.message);
        return [];
    }
}

// Monitor target channel for new Shorts
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
        
        // New video detected
        if (videoId !== lastVideoId && lastVideoId !== null) {
            console.log(`\n🎬 NEW SHORT DETECTED!`);
            console.log(`📹 Title: ${latest.snippet.title}`);
            console.log(`⏰ Time: ${latest.snippet.publishedAt}`);
            
            const shorts = await getScheduledShorts();
            if (shorts.length > 0) {
                const toPublish = shorts[0];
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

// ============ START ============
console.log('🚀 Starting YouTube Timing Bot...');
console.log(`📤 Your Channel ID: ${YOUR_CHANNEL_ID}`);
console.log(`🎯 Target: @Tewahdotube-21`);
console.log(`🔓 Unlimited copies`);
console.log(`🔍 Monitoring every 30 seconds...`);

// Run first check immediately
monitor();

// Then every 30 seconds
setInterval(monitor, 30000);

// Show supply count every 5 minutes
setInterval(async () => {
    const shorts = await getScheduledShorts();
    console.log(`📊 Supply status: ${shorts.length} scheduled shorts`);
}, 300000);
