const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;

const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const TARGET_CHANNEL_HANDLE = '@Tewahdotube-21';
const CLIENT_ID = '635922113777-8c182r05vi5ve32nkqgqc2n5bbldhn18.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04F_QRLOYNyOdCgYIARAAGAQSNwF-L9IrWsT9K73DNxaQfqrmd6fgYUhdeQaFAvSJtB8y3eV6ZA3skvwUfUacaRTr53opx0mrn_k';

const API_KEYS = [
    'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg',
    'AIzaSyAXzQXd0AONNgSI8E6D5_BeweMqyz4iGTg',
    'AIzaSyDjLVpU8M9VFBAuj-_pvSyDW1BbUfCjyIY'
];

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN environment variable is required!');
    process.exit(1);
}

let currentKey = 0, keyUsage = [0,0,0];
let keyReset = [Date.now(), Date.now(), Date.now()];
let lastVideoId = null;
let isProcessing = false;
let scheduledCache = null;
let lastCache = 0;
let monitorCount = 0;
let lastPostInfo = null;
let consecutiveErrors = 0;
let publishedVideos = new Map();

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('Bot Running'));
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        lastVideoId, 
        monitorCount,
        scheduledCount: scheduledCache?.length || 0,
        consecutiveErrors,
        monitoredVideos: publishedVideos.size
    });
});
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
let youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

function getApiKey() {
    const now = Date.now();
    const ONE_DAY = 86400000;
    for(let i = 0; i < API_KEYS.length; i++) {
        if(now - keyReset[i] > ONE_DAY) { keyUsage[i] = 0; keyReset[i] = now; }
        if(keyUsage[i] < 50) { currentKey = i; keyUsage[i]++; return API_KEYS[i]; }
    }
    return null;
}

function getYoutube() { 
    const key = getApiKey();
    return key ? google.youtube({ version: 'v3', auth: key }) : null;
}

async function refreshToken() {
    try {
        await oauth2Client.refreshAccessToken();
        youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
        console.log('✅ Token refreshed');
        consecutiveErrors = 0;
    } catch(e) { console.error('❌ Token refresh failed:', e.message); consecutiveErrors++; }
}
setInterval(refreshToken, 45 * 60 * 1000);

async function getUploadsPlaylistId(channelId, retryCount = 0) {
    try {
        const youtube = getYoutube();
        if(!youtube && retryCount < 3) {
            await new Promise(r => setTimeout(r, 5000));
            return getUploadsPlaylistId(channelId, retryCount + 1);
        }
        const res = await youtube.channels.list({ part: 'contentDetails', id: channelId });
        if(res.data.items?.length) return res.data.items[0].contentDetails.relatedPlaylists.uploads;
        return null;
    } catch(e) { return null; }
}

async function getYourUploadsPlaylistId() {
    try {
        const res = await youtubeAuth.channels.list({ part: 'contentDetails', id: YOUR_CHANNEL_ID });
        return res.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
    } catch(e) { return null; }
}

async function getLatestPost(retryCount = 0) {
    try {
        const youtube = getYoutube();
        if(!youtube && retryCount < 3) {
            await new Promise(r => setTimeout(r, 5000));
            return getLatestPost(retryCount + 1);
        }
        const uploadsPlaylistId = await getUploadsPlaylistId(TARGET_CHANNEL_ID);
        if(!uploadsPlaylistId) return null;
        const res = await youtube.playlistItems.list({ part: 'snippet', playlistId: uploadsPlaylistId, maxResults: 1 });
        if(!res.data.items?.length) return null;
        const latest = res.data.items[0];
        return {
            id: latest.snippet.resourceId.videoId,
            title: latest.snippet.title,
            publishedAt: latest.snippet.publishedAt,
            url: `https://www.youtube.com/watch?v=${latest.snippet.resourceId.videoId}`
        };
    } catch(e) { return null; }
}

async function getScheduledShorts(force = false) {
    const now = Date.now();
    if(!force && scheduledCache && (now - lastCache) < 60000) return scheduledCache;
    try {
        const uploadsPlaylistId = await getYourUploadsPlaylistId();
        if(!uploadsPlaylistId) return [];
        const res = await youtubeAuth.playlistItems.list({ part: 'snippet', playlistId: uploadsPlaylistId, maxResults: 50 });
        const scheduled = [];
        for(let i = 0; i < (res.data.items || []).length; i += 10) {
            const batch = res.data.items.slice(i, i + 10);
            const videoIds = batch.map(item => item.snippet.resourceId.videoId);
            const videoRes = await youtubeAuth.videos.list({ part: 'status,snippet', id: videoIds.join(',') });
            for(const video of videoRes.data.items || []) {
                const status = video?.status;
                if(status?.privacyStatus === 'private' && status?.publishAt && new Date(status.publishAt) > new Date()) {
                    scheduled.push({ id: video.id, title: video.snippet.title, time: new Date(status.publishAt) });
                }
            }
        }
        scheduled.sort((a,b) => a.time - b.time);
        scheduledCache = scheduled;
        lastCache = now;
        return scheduled;
    } catch(e) { return []; }
}

async function publishVideo(id, title, retryCount = 0) {
    try {
        console.log(`📤 Publishing: ${title}`);
        await youtubeAuth.videos.update({ part: 'status', requestBody: { id: id, status: { privacyStatus: 'public' } } });
        console.log(`✅ Published: ${title}`);
        publishedVideos.set(id, { publishTime: Date.now(), title: title, status: 'checking' });
        scheduledCache = null;
        consecutiveErrors = 0;
        return true;
    } catch(e) {
        if(retryCount < 3) {
            await new Promise(r => setTimeout(r, 10000));
            return publishVideo(id, title, retryCount + 1);
        }
        return false;
    }
}

async function makePrivateAndReschedule(videoId, title) {
    try {
        console.log(`🔒 Rescheduling low-view video: ${title}`);
        const newPublishDate = new Date();
        newPublishDate.setDate(newPublishDate.getDate() + 3);
        await youtubeAuth.videos.update({
            part: 'status',
            requestBody: { 
                id: videoId, 
                status: { 
                    privacyStatus: 'private', 
                    publishAt: newPublishDate.toISOString(),
                    selfDeclaredMadeForKids: false
                } 
            }
        });
        console.log(`✅ "${title}" rescheduled for ${newPublishDate.toLocaleString()}`);
        scheduledCache = null;
        return true;
    } catch(e) { 
        console.error(`❌ Failed to reschedule: ${e.message}`);
        return false; 
    }
}

// NEW: Scan ALL videos on the channel for low views
async function scanAllVideosForLowViews() {
    console.log('\n🔍 Scanning ALL videos for low views (less than 2)...');
    
    try {
        const uploadsPlaylistId = await getYourUploadsPlaylistId();
        if (!uploadsPlaylistId) {
            console.log('❌ Could not get uploads playlist');
            return;
        }
        
        let pageToken = null;
        let totalScanned = 0;
        let rescheduled = 0;
        
        do {
            const res = await youtubeAuth.playlistItems.list({
                part: 'snippet',
                playlistId: uploadsPlaylistId,
                maxResults: 50,
                pageToken: pageToken
            });
            
            const videoIds = (res.data.items || []).map(item => item.snippet.resourceId.videoId);
            
            // Get video details in batches
            for (let i = 0; i < videoIds.length; i += 10) {
                const batch = videoIds.slice(i, i + 10);
                const videoRes = await youtubeAuth.videos.list({
                    part: 'statistics,status,snippet',
                    id: batch.join(',')
                });
                
                for (const video of videoRes.data.items || []) {
                    totalScanned++;
                    const viewCount = parseInt(video.statistics?.viewCount || 0);
                    const privacyStatus = video.status?.privacyStatus;
                    const title = video.snippet?.title;
                    const videoId = video.id;
                    const publishedAt = new Date(video.snippet?.publishedAt);
                    const daysOld = Math.floor((Date.now() - publishedAt) / (1000 * 60 * 60 * 24));
                    
                    // Check if video is public AND has less than 2 views
                    if (privacyStatus === 'public' && viewCount < 2) {
                        console.log(`\n⚠️ Found low-view video: "${title}"`);
                        console.log(`   Views: ${viewCount} | Age: ${daysOld} days old`);
                        console.log(`   Rescheduling...`);
                        
                        await makePrivateAndReschedule(videoId, title);
                        rescheduled++;
                        
                        // Wait a bit to avoid rate limits
                        await new Promise(r => setTimeout(r, 1000));
                    } else if (privacyStatus === 'public') {
                        console.log(`✅ Video has good views: "${title}" - ${viewCount} views`);
                    }
                }
            }
            
            pageToken = res.data.nextPageToken;
            
        } while (pageToken);
        
        console.log(`\n📊 Scan complete: ${totalScanned} videos checked, ${rescheduled} rescheduled`);
        
    } catch (error) {
        console.error('❌ Error scanning videos:', error.message);
    }
}

// Modified checkVideoViews - now includes old videos
async function checkVideoViews() {
    const now = Date.now();
    const videosToCheck = [];
    
    // Check recently published videos (last 48 hours)
    for (const [videoId, data] of publishedVideos.entries()) {
        const hoursSincePublish = (now - data.publishTime) / (1000 * 60 * 60);
        if (hoursSincePublish >= 2 && data.status === 'checking') {
            videosToCheck.push({ videoId, ...data });
        }
    }
    
    // Check recent videos
    for (const video of videosToCheck) {
        try {
            const response = await youtubeAuth.videos.list({ part: 'statistics', id: video.videoId });
            const viewCount = parseInt(response.data.items?.[0]?.statistics?.viewCount || 0);
            console.log(`📊 "${video.title}" has ${viewCount} view(s)`);
            
            if (viewCount < 2) {
                await makePrivateAndReschedule(video.videoId, video.title);
                publishedVideos.set(video.videoId, { ...video, status: 'rescheduled' });
            } else {
                publishedVideos.set(video.videoId, { ...video, status: 'success', viewCount });
            }
        } catch(e) {}
    }
}

async function monitor() {
    if(isProcessing) return;
    if(consecutiveErrors > 10) {
        await new Promise(r => setTimeout(r, 300000));
        consecutiveErrors = 0;
    }
    isProcessing = true;
    monitorCount++;
    try {
        await checkVideoViews();
        const latestPost = await getLatestPost();
        if(!latestPost) return;
        
        if(latestPost.id !== lastVideoId && lastVideoId !== null) {
            console.log(`\n🎬 NEW VIDEO DETECTED!`);
            const scheduled = await getScheduledShorts(true);
            if(scheduled.length > 0) {
                await publishVideo(scheduled[0].id, scheduled[0].title);
            } else {
                console.log(`❌ No scheduled videos to publish`);
            }
            lastVideoId = latestPost.id;
        } else if(lastVideoId === null) {
            lastVideoId = latestPost.id;
        }
    } catch(e) { 
        consecutiveErrors++;
    } finally { 
        isProcessing = false; 
    }
}
