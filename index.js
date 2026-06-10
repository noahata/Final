const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const PRIVATE_CHANNEL_ID = process.env.PRIVATE_CHANNEL_ID;

const API_KEY = 'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg';
const CLIENT_ID = '39782137338-niqk6sud510hbe7cvj6o6jhjdu52kktl';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04sVis7VSphGcCgYIARAAGAQSNwF-L9Irdx6qMc4h1scOU658OT7npy3u6IKjZffjotd3iJgSiGizUPWuGAoEk-_pQQxKkADOLh8';

const MASTER_PASSWORD = 'Noah@1221';
const CONTACT_USERNAME = '@acespy';
const MAX_COPIES_PER_PASSWORD = 10;

let bot = null;
let userData = {};
let userSession = {};

const app = express();
app.get('/', (req, res) => res.send('YouTube Timing Bot Running'));
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

const youtube = google.youtube({ version: 'v3', auth: API_KEY });

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

console.log('✅ Bot starting...');

// ============ KEYBOARD MENU ============
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "📊 MY STATUS" }, { text: "🎯 SET MY CHANNEL" }],
            [{ text: "👁️ SET TARGET" }, { text: "📦 MY SUPPLY" }],
            [{ text: "🔢 COPIES LEFT" }, { text: "❓ HELP" }],
            [{ text: "🚪 LOGOUT" }]
        ],
        resize_keyboard: true,
        persistent: true
    }
};

const authKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "🔐 I HAVE A PASSWORD" }],
            [{ text: "❓ HOW TO GET CHANNEL ID" }]
        ],
        resize_keyboard: true,
        persistent: true
    }
};

// ============ PASSWORD FUNCTIONS ============
function parsePassword(password) {
    if (!password || password.length !== 8) return null;
    const parts = password.split('');
    if (parts[0] !== '1' || parts[2] !== '8' || parts[4] !== '9' || parts[6] !== '7') {
        return null;
    }
    return { full: password };
}

function getAllPossiblePasswords() {
    const passwords = [];
    for (let x = 0; x <= 9; x++) {
        for (let y = 0; y <= 9; y++) {
            for (let z = 0; z <= 9; z++) {
                for (let w = 0; w <= 9; w++) {
                    passwords.push(`1${x}8${y}9${z}7${w}`);
                }
            }
        }
    }
    return passwords;
}

function getUnusedPasswords() {
    const allPasswords = getAllPossiblePasswords();
    const usedPasswords = Object.values(userData).map(u => u.password).filter(p => p);
    const usedSet = new Set(usedPasswords);
    const unused = allPasswords.filter(p => !usedSet.has(p));
    return { total: allPasswords.length, used: usedPasswords.length, unused: unused.length, unusedList: unused };
}

// ============ SAVE/LOAD DATA ============
async function saveAllUserData() {
    if (!bot) return;
    try {
        const messages = await bot.telegram.getChatHistory(PRIVATE_CHANNEL_ID, { limit: 200 });
        for (const msg of messages) {
            if (msg.text && (msg.text.startsWith('📦 MASTER_DATA') || msg.text.startsWith('👤 USER_DATA'))) {
                await bot.telegram.deleteMessage(PRIVATE_CHANNEL_ID, msg.message_id);
            }
        }
        
        const allPasswords = Object.values(userData).map(u => u.password);
        await bot.telegram.sendMessage(PRIVATE_CHANNEL_ID, `📦 MASTER_DATA\nTOTAL_USERS=${Object.keys(userData).length}\nUSED_PASSWORDS=${allPasswords.join(',')}\nLAST_UPDATE=${new Date().toISOString()}`);
        
        for (const [userId, user] of Object.entries(userData)) {
            await bot.telegram.sendMessage(PRIVATE_CHANNEL_ID, 
                `👤 USER_DATA:${userId}\n` +
                `PASSWORD=${user.password || ''}\n` +
                `COPIES_USED=${user.copiesUsed || 0}\n` +
                `YOUR_CHANNEL_ID=${user.yourChannelId || ''}\n` +
                `TARGET_CHANNEL_ID=${user.targetChannelId || ''}\n` +
                `REGISTERED_AT=${user.registeredAt || ''}`);
        }
        console.log(`💾 Saved ${Object.keys(userData).length} users`);
    } catch (error) {
        console.error('Error saving:', error.message);
    }
}

async function loadAllUserData() {
    if (!bot) return;
    try {
        const messages = await bot.telegram.getChatHistory(PRIVATE_CHANNEL_ID, { limit: 200 });
        for (const msg of messages) {
            if (!msg.text) continue;
            if (msg.text.startsWith('👤 USER_DATA:')) {
                const lines = msg.text.split('\n');
                const userId = lines[0].replace('👤 USER_DATA:', '');
                const user = {};
                for (const line of lines.slice(1)) {
                    const [key, ...valueParts] = line.split('=');
                    const value = valueParts.join('=');
                    if (key === 'PASSWORD') user.password = value;
                    if (key === 'COPIES_USED') user.copiesUsed = parseInt(value) || 0;
                    if (key === 'YOUR_CHANNEL_ID') user.yourChannelId = value;
                    if (key === 'TARGET_CHANNEL_ID') user.targetChannelId = value;
                    if (key === 'REGISTERED_AT') user.registeredAt = value;
                }
                user.lastVideoId = null;
                userData[userId] = user;
            }
        }
        console.log(`📂 Loaded ${Object.keys(userData).length} users`);
    } catch (error) {
        console.error('Error loading:', error.message);
    }
}

// ============ AUTO-CONVERT FUNCTION ============
async function convertHandleToChannelId(handle) {
    const cleanHandle = handle.replace('@', '');
    try {
        const url = `https://www.youtube.com/@${cleanHandle}`;
        const response = await fetch(url);
        const html = await response.text();
        
        const metaMatch = html.match(/<meta itemprop="channelId" content="([^"]+)"/);
        if (metaMatch) return metaMatch[1];
        
        const jsMatch = html.match(/"channelId":"([^"]+)"/);
        if (jsMatch) return jsMatch[1];
        
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

// ============ HELPER FUNCTIONS ============
async function getYourScheduledShorts(yourChannelId) {
    if (!yourChannelId) return [];
    try {
        const response = await youtubeAuth.search.list({ part: 'snippet', channelId: yourChannelId, type: 'video', maxResults: 50 });
        const scheduledVideos = [];
        for (const item of response.data.items) {
            try {
                const videoRes = await youtubeAuth.videos.list({ part: 'status', id: item.id.videoId });
                if (videoRes.data.items && videoRes.data.items[0]) {
                    const status = videoRes.data.items[0].status;
                    if (status.privacyStatus === 'private' && status.publishAt) {
                        scheduledVideos.push({ id: item.id.videoId, title: item.snippet.title, scheduledTime: status.publishAt });
                    }
                }
            } catch (e) {}
        }
        return scheduledVideos;
    } catch (error) {
        return [];
    }
}

async function makeVideoPublic(videoId, videoTitle) {
    try {
        await youtubeAuth.videos.update({ part: 'status', requestBody: { id: videoId, status: { privacyStatus: 'public', publishAt: null } } });
        console.log(`✅ Made PUBLIC: "${videoTitle}"`);
        return true;
    } catch (error) {
        console.error(`Failed: ${error.message}`);
        return false;
    }
}

// ============ MONITOR FUNCTIONS ============
async function monitorForUser(userId, user) {
    if (!user.targetChannelId || !user.yourChannelId) return;
    const copiesUsed = user.copiesUsed || 0;
    if (copiesUsed >= MAX_COPIES_PER_PASSWORD) return;
    
    try {
        const channelRes = await youtube.channels.list({ part: 'contentDetails', id: user.targetChannelId });
        if (!channelRes.data.items) return;
        
        const playlistId = channelRes.data.items[0].contentDetails.relatedPlaylists.uploads;
        const playlistRes = await youtube.playlistItems.list({ part: 'snippet', playlistId, maxResults: 1 });
        if (!playlistRes.data.items) return;
        
        const latest = playlistRes.data.items[0];
        const videoId = latest.snippet.resourceId.videoId;
        
        if (videoId !== user.lastVideoId) {
            user.lastVideoId = videoId;
            const yourVideos = await getYourScheduledShorts(user.yourChannelId);
            if (yourVideos.length === 0) return;
            
            const nextVideo = yourVideos[0];
            user.copiesUsed = (user.copiesUsed || 0) + 1;
            await saveAllUserData();
            await makeVideoPublic(nextVideo.id, nextVideo.title);
            
            await bot.telegram.sendMessage(parseInt(userId), 
                `🎬 *Target channel posted!*\n\n📤 Published: *${nextVideo.title}*\n📊 Copies left: ${MAX_COPIES_PER_PASSWORD - user.copiesUsed}/${MAX_COPIES_PER_PASSWORD}`,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (error) {
        console.error('Monitor error:', error.message);
    }
}

async function monitorAllUsers() {
    for (const [userId, user] of Object.entries(userData)) {
        await monitorForUser(userId, user);
    }
}
