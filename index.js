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
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// Setup OAuth for YOUR channel
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

// For monitoring target channel (public)
const youtube = google.youtube({ version: 'v3', auth: API_KEY });

let lastVideoId = null;

// ============ DEBUG: Check all videos ============
async function debugAllVideos() {
    console.log('\n🔍 === DEBUG START === 🔍');
    
    try {
        // Test 1: Can we access your channel?
        const channelCheck = await youtubeAuth.channels.list({
            part: 'id',
            id: YOUR_CHANNEL_ID
        });
        console.log(`✅ Channel access: ${channelCheck.data.items?.length > 0 ? 'SUCCESS' : 'FAILED'}`);
        
        // Test 2: Search for all videos
        const searchRes = await youtubeAuth.search.list({
            part: 'snippet',
            channelId: YOUR_CHANNEL_ID,
            type: 'video',
            maxResults: 50
        });
        
        const totalVideos = searchRes.data.items?.length || 0;
        console.log(`📊 Total videos found: ${totalVideos}`);
        
        if (totalVideos === 0) {
            console.log('❌ No videos found on your channel!');
            console.log('   Make sure YOUR_CHANNEL_ID is correct.');
            console.log(`   Current ID: ${YOUR_CHANNEL_ID}`);
            return;
        }
        
        // Test 3: Check each video's status
        let scheduledCount = 0;
        for (const item of searchRes.data.items) {
            const videoRes = await youtubeAuth.videos.list({
                part: 'status, snippet',
                id: item.id.videoId
            });
            
            const video = videoRes.data.items[0];
            if (video) {
                const status = video.status;
                const isScheduled = (status.privacyStatus === 'private' && status.publishAt);
                const isFuture = isScheduled ? new Date(status.publishAt) > new Date() : false;
                
                if (isScheduled && isFuture) {
                    scheduledCount++;
                    console.log(`\n✅ SCHEDULED VIDEO FOUND:`);
                    console.log(`   Title: ${video.snippet.title}`);
                    console.log(`   Video ID: ${item.id.videoId}`);
                    console.log(`   Privacy: ${status.privacyStatus}`);
                    console.log(`   Publish At: ${status.publishAt}`);
                    console.log(`   Scheduled Time: ${new Date(status.publishAt).toLocaleString()}`);
                } else if (isScheduled && !isFuture) {
                    console.log(`\n⏰ Past scheduled video: ${video.snippet.title} (already passed)`);
                }
            }
        }
        
        if (scheduledCount === 0) {
            console.log(`\n❌ NO FUTURE SCHEDULED VIDEOS FOUND!`);
            console.log(`   To schedule a video:`);
            console.log(`   1. Upload a Short`);
            console.log(`   2. Choose "Schedule" (NOT Public)`);
            console.log(`   3. Pick a FUTURE date/time`);
            console.log(`   4. Click "Schedule"`);
        } else {
            console.log(`\n✅ Total scheduled shorts: ${scheduledCount}`);
        }
        
    } catch (error) {
        console.error('❌ Debug error:', error.message);
        if (error.message.includes('invalid_grant')) {
            console.error('   Your REFRESH_TOKEN may have expired. Get a new one from OAuth Playground.');
        }
    }
    
    console.log('🔍 === DEBUG END === 🔍\n');
}

// ============ Get YOUR scheduled shorts ============
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
        console.log(`📊 Scheduled shorts count: ${scheduled.length}`);
        return scheduled;
    } catch (error) {
        console.error('Error getting scheduled shorts:', error.message);
        return [];
    }
}

// ============ Monitor target channel ============
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
console.log('\n🚀 ========== YOUTUBE TIMING BOT ==========');
console.log(`📤 Your Channel ID: ${YOUR_CHANNEL_ID}`);
console.log(`🎯 Target Channel ID: ${TARGET_CHANNEL_ID}`);
console.log(`🔓 Unlimited copies`);
console.log(`==========================================\n`);

// Run debug immediately
setTimeout(async () => {
    await debugAllVideos();
}, 2000);

// Also run debug every 2 minutes
setInterval(async () => {
    await debugAllVideos();
}, 120000);

// Monitor every 30 seconds
setInterval(monitor, 30000);
monitor();

console.log('🔍 Monitoring target channel every 30 seconds...');
