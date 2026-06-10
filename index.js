const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const PRIVATE_CHANNEL_ID = process.env.PRIVATE_CHANNEL_ID;

// ============ HIDDEN BUSINESS LOGIC (Only YOU know) ============
const API_KEY = 'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg';
const CLIENT_ID = '39782137338-niqk6sud510hbe7cvj6o6jhjdu52kktl';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'https://developers.google.com/oauthplayground';
const MASTER_PASSWORD = 'Noah@1221';  // Only YOU know this
const CONTACT_USERNAME = '@acespy';
const MAX_COPIES = 10;
// ================================================================

let bot = null;
let userData = {};

const app = express();
app.get('/', (req, res) => res.send('Bot Running'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

const youtube = google.youtube({ version: 'v3', auth: API_KEY });

// ============ SAVE/LOAD DATA (Hidden from customers) ============
async function saveData() {
    if (!bot) return;
    try {
        const messages = await bot.telegram.getChatHistory(PRIVATE_CHANNEL_ID, { limit: 50 });
        for (const msg of messages) {
            if (msg.text && msg.text.startsWith('DATA:')) {
                await bot.telegram.deleteMessage(PRIVATE_CHANNEL_ID, msg.message_id);
            }
        }
        await bot.telegram.sendMessage(PRIVATE_CHANNEL_ID, `DATA:${JSON.stringify(userData)}`);
        console.log('💾 Data saved');
    } catch (e) {
        console.error('Save error:', e.message);
    }
}

async function loadData() {
    if (!bot) return;
    try {
        const messages = await bot.telegram.getChatHistory(PRIVATE_CHANNEL_ID, { limit: 50 });
        for (const msg of messages) {
            if (msg.text && msg.text.startsWith('DATA:')) {
                const jsonStr = msg.text.replace('DATA:', '');
                userData = JSON.parse(jsonStr);
                console.log(`📂 Loaded ${Object.keys(userData).length} users`);
                break;
            }
        }
    } catch (e) {
        console.error('Load error:', e.message);
    }
}

// ============ AUTO-CONVERT @USERNAME TO CHANNEL ID ============
async function convertHandleToChannelId(handle) {
    const cleanHandle = handle.replace('@', '');
    
    try {
        // Method 1: Scrape from YouTube page
        const url = `https://www.youtube.com/@${cleanHandle}`;
        const response = await fetch(url);
        const html = await response.text();
        
        const metaMatch = html.match(/<meta itemprop="channelId" content="([^"]+)"/);
        if (metaMatch) return metaMatch[1];
        
        const jsMatch = html.match(/"channelId":"([^"]+)"/);
        if (jsMatch) return jsMatch[1];
        
        const externalMatch = html.match(/externalChannelId":"([^"]+)"/);
        if (externalMatch) return externalMatch[1];
        
        // Method 2: YouTube Search API (fallback)
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${cleanHandle}&type=channel&maxResults=1&key=${API_KEY}`;
        const searchResponse = await fetch(searchUrl);
        const searchData = await searchResponse.json();
        
        if (searchData.items && searchData.items.length > 0) {
            return searchData.items[0].snippet.channelId;
        }
        
        return null;
    } catch (error) {
        console.error('Auto-convert error:', error.message);
        return null;
    }
}

// ============ OAUTH FUNCTIONS ============
function getOAuthLink() {
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/youtube']
    });
}

async function exchangeCodeForTokens(code) {
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
}

async function getYouTubeChannelId(accessToken) {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });
    const youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
    const response = await youtubeAuth.channels.list({ part: 'id', mine: true });
    return response.data.items[0]?.id || null;
}

async function makeVideoPublic(videoId, videoTitle, refreshToken) {
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
    
    try {
        await youtubeAuth.videos.update({
            part: 'status',
            requestBody: { id: videoId, status: { privacyStatus: 'public', publishAt: null } }
        });
        console.log(`✅ Made PUBLIC: ${videoTitle}`);
        return true;
    } catch (error) {
        console.error(`Failed: ${error.message}`);
        return false;
    }
}

async function getScheduledShorts(channelId, refreshToken) {
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
    
    try {
        const response = await youtubeAuth.search.list({
            part: 'snippet',
            channelId: channelId,
            type: 'video',
            maxResults: 50
        });
        
        const scheduled = [];
        for (const item of response.data.items) {
            try {
                const videoRes = await youtubeAuth.videos.list({ part: 'status', id: item.id.videoId });
                const status = videoRes.data.items[0]?.status;
                if (status?.privacyStatus === 'private' && status?.publishAt) {
                    scheduled.push({
                        id: item.id.videoId,
                        title: item.snippet.title,
                        time: status.publishAt
                    });
                }
            } catch (e) {}
        }
        return scheduled;
    } catch (error) {
        return [];
    }
}

// ============ MONITOR TARGET CHANNEL ============
async function monitorTargetChannel(userId, user) {
    if (!user.targetId || !user.channelId || !user.refreshToken) return;
    if ((user.copiesUsed || 0) >= MAX_COPIES) return;
    
    try {
        const channelRes = await youtube.channels.list({ part: 'contentDetails', id: user.targetId });
        if (!channelRes.data.items) return;
        
        const playlistId = channelRes.data.items[0].contentDetails.relatedPlaylists.uploads;
        const playlistRes = await youtube.playlistItems.list({ part: 'snippet', playlistId, maxResults: 1 });
        if (!playlistRes.data.items) return;
        
        const latest = playlistRes.data.items[0];
        const videoId = latest.snippet.resourceId.videoId;
        
        if (videoId !== user.lastVideoId) {
            user.lastVideoId = videoId;
            const shorts = await getScheduledShorts(user.channelId, user.refreshToken);
            if (shorts.length === 0) return;
            
            const nextVideo = shorts[0];
            user.copiesUsed = (user.copiesUsed || 0) + 1;
            await saveData();
            await makeVideoPublic(nextVideo.id, nextVideo.title, user.refreshToken);
            
            const left = MAX_COPIES - user.copiesUsed;
            await bot.telegram.sendMessage(parseInt(userId),
                `🎬 *Target posted!*\n📤 Published: ${nextVideo.title}\n📊 Copies left: ${left}/${MAX_COPIES}`,
                { parse_mode: 'Markdown' }
            );
            
            if (left === 0) {
                await bot.telegram.sendMessage(parseInt(userId),
                    `⚠️ *No copies left!*\nContact ${CONTACT_USERNAME} to purchase more.`,
                    { parse_mode: 'Markdown' }
                );
            }
        }
    } catch (error) {
        console.error('Monitor error:', error.message);
    }
}

// ============ KEYBOARDS ============
const mainMenu = {
    reply_markup: {
        keyboard: [
            ['📊 STATUS', '🎯 MY CHANNEL'],
            ['👁️ TARGET', '📦 SUPPLY'],
            ['🔢 COPIES', '🔐 OAUTH'],
            ['🚪 LOGOUT']
        ],
        resize_keyboard: true
    }
};

const authMenu = {
    reply_markup: {
        keyboard: [['🔐 REGISTER'], ['❓ HELP']],
        resize_keyboard: true
    }
};
