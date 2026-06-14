const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const ytdl = require('ytdl-core');
const fs = require('fs');
const path = require('path');

// ============ CREDENTIALS ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const TARGET_CHANNEL_HANDLE = '@Tewahdotube-21';
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
let lastVideoId = null;
let isProcessing = false;
let scheduledCache = null;
let lastCache = 0;
let monitorCount = 0;
let lastPostInfo = null;

// ============ ZERO VIEW TRACKING ============
let zeroViewVideos = new Map();
let isZeroViewProcessing = false;
const ZERO_VIEW_CHECK_DELAY = 2 * 60 * 60 * 1000; // 2 hours
const REUPLOAD_DELAY = 30; // 30 days

// Create temp directory for downloads
const TEMP_DIR = path.join(__dirname, 'temp_downloads');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    console.log(`📁 Created temp directory: ${TEMP_DIR}`);
}

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

function getYoutube() { 
    const key = getApiKey();
    return key ? google.youtube({ version: 'v3', auth: key }) : null;
}

// Token refresh
async function refreshToken() {
    try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
        console.log('✅ Token refreshed');
    } catch(e) { console.error('❌ Token refresh failed:', e.message); }
}
setInterval(refreshToken, 45 * 60 * 1000);

// Get uploads playlist ID reliably
async function getUploadsPlaylistId(channelId) {
    try {
        const youtube = getYoutube();
        if(!youtube) return null;
        
        const res = await youtube.channels.list({
            part: 'contentDetails',
            id: channelId
        });
        
        if(res.data.items && res.data.items.length > 0) {
            return res.data.items[0].contentDetails.relatedPlaylists.uploads;
        }
        return null;
    } catch(e) {
        console.error('Error getting uploads playlist:', e.message);
        return null;
    }
}

// Get your uploads playlist ID reliably
async function getYourUploadsPlaylistId() {
    try {
        const res = await youtubeAuth.channels.list({
            part: 'contentDetails',
            id: YOUR_CHANNEL_ID
        });
        
        if(res.data.items && res.data.items.length > 0) {
            return res.data.items[0].contentDetails.relatedPlaylists.uploads;
        }
        return null;
    } catch(e) {
        console.error('Error getting your uploads playlist:', e.message);
        return null;
    }
}

// Get latest post from target channel
async function getLatestPost() {
    try {
        const youtube = getYoutube();
        if(!youtube) return null;
        
        const uploadsPlaylistId = await getUploadsPlaylistId(TARGET_CHANNEL_ID);
        if(!uploadsPlaylistId) return null;
        
        const res = await youtube.playlistItems.list({
            part: 'snippet',
            playlistId: uploadsPlaylistId,
            maxResults: 1
        });
        
        if(!res.data.items || res.data.items.length === 0) return null;
        
        const latest = res.data.items[0];
        return {
            id: latest.snippet.resourceId.videoId,
            title: latest.snippet.title,
            publishedAt: latest.snippet.publishedAt,
            url: `https://www.youtube.com/watch?v=${latest.snippet.resourceId.videoId}`,
            thumbnail: latest.snippet.thumbnails.default.url
        };
    } catch(e) {
        console.error('Error getting latest post:', e.message);
        return null;
    }
}

// Get scheduled shorts using reliable playlist ID
async function getScheduledShorts(force=false) {
    const now = Date.now();
    if(!force && scheduledCache && (now - lastCache) < 60000) return scheduledCache;
    
    try {
        const uploadsPlaylistId = await getYourUploadsPlaylistId();
        if(!uploadsPlaylistId) {
            console.error('❌ Could not get your uploads playlist ID');
            return [];
        }
        
        const res = await youtubeAuth.playlistItems.list({ 
            part: 'snippet', 
            playlistId: uploadsPlaylistId, 
            maxResults: 50 
        });
        
        const scheduled = [];
        
        for(let i=0; i<(res.data.items||[]).length; i+=10) {
            const batch = res.data.items.slice(i, i+10);
            const videoIds = batch.map(item => item.snippet.resourceId.videoId);
            const videoRes = await youtubeAuth.videos.list({ 
                part: 'status,snippet', 
                id: videoIds.join(',') 
            });
            
            for(const video of videoRes.data.items||[]) {
                const status = video?.status;
                if(status?.privacyStatus === 'private' && status?.publishAt) {
                    const publishTime = new Date(status.publishAt);
                    if(publishTime > new Date()) {
                        scheduled.push({ 
                            id: video.id, 
                            title: video.snippet.title, 
                            time: publishTime 
                        });
                    }
                }
            }
        }
        scheduled.sort((a,b) => a.time - b.time);
        scheduledCache = scheduled;
        lastCache = now;
        return scheduled;
    } catch(e) { 
        console.error('Error getting scheduled:', e.message);
        return []; 
    }
}

// Publish video
async function publishVideo(id, title) {
    try {
        console.log(`📤 Publishing: ${title}`);
        await youtubeAuth.videos.update({ 
            part: 'status', 
            requestBody: { 
                id: id, 
                status: { 
                    privacyStatus: 'public'
                } 
            } 
        });
        console.log(`✅ Published: ${title}`);
        scheduledCache = null;
        return true;
    } catch(e) { 
        console.error(`❌ Failed to publish ${title}:`, e.message);
        return false;
    }
}

// Monitor target channel
async function monitor() {
    if(isProcessing) return;
    isProcessing = true;
    monitorCount++;
    
    try {
        const latestPost = await getLatestPost();
        
        if(!latestPost) {
            console.log('❌ Could not fetch latest post');
            return;
        }
        
        lastPostInfo = latestPost;
        
        console.log(`\n📹 Latest from ${TARGET_CHANNEL_HANDLE}:`);
        console.log(`   ID: ${latestPost.id}`);
        console.log(`   Title: ${latestPost.title}`);
        console.log(`   Time: ${latestPost.publishedAt}`);
        console.log(`   Last known ID: ${lastVideoId || 'none'}`);
        
        if(latestPost.id !== lastVideoId && lastVideoId !== null) {
            console.log(`\n🎬🎬🎬 NEW VIDEO DETECTED! 🎬🎬🎬`);
            console.log(`📹 Target video: "${latestPost.title}"`);
            
            const scheduled = await getScheduledShorts(true);
            
            if(scheduled.length > 0) {
                const toPublish = scheduled[0];
                console.log(`📤 Publishing your video: "${toPublish.title}"`);
                console.log(`📅 Originally scheduled for: ${toPublish.time.toLocaleString()}`);
                
                await publishVideo(toPublish.id, toPublish.title);
                console.log(`✅ Publishing complete!`);
            } else {
                console.log(`❌ No scheduled videos to publish`);
            }
            
            lastVideoId = latestPost.id;
            console.log(`💾 Updated last known video ID to: ${lastVideoId}`);
            
        } else if(lastVideoId === null) {
            console.log(`📝 First run - storing initial video ID: ${latestPost.id}`);
            lastVideoId = latestPost.id;
        } else {
            console.log(`✓ No new videos since last check (Last: ${lastVideoId})`);
        }
        
    } catch(e) { 
        console.error('Monitor error:', e.message);
    } finally { 
        isProcessing = false;
    }
}

// Get public video count
async function getPublicCount() {
    try {
        let count = 0, page = null;
        do {
            const res = await youtubeAuth.search.list({ 
                part: 'snippet', 
                channelId: YOUR_CHANNEL_ID, 
                type: 'video', 
                maxResults: 50, 
                pageToken: page 
            });
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

// Format time difference
function getTimeAgo(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if(diffMins < 1) return 'Just now';
    if(diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    if(diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    }
