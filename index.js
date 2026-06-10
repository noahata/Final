const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const PRIVATE_CHANNEL_ID = process.env.PRIVATE_CHANNEL_ID;

// ============ YOUR CREDENTIALS ============
const API_KEY = 'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg';
const CLIENT_ID = '39782137338-niqk6sud510hbe7cvj6o6jhjdu52kktl';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04sVis7VSphGcCgYIARAAGAQSNwF-L9Irdx6qMc4h1scOU658OT7npy3u6IKjZffjotd3iJgSiGizUPWuGAoEk-_pQQxKkADOLh8';
// ==========================================

const MASTER_PASSWORD = 'Noah@1221';
const CONTACT_USERNAME = '@acespy';
const MAX_COPIES_PER_PASSWORD = 10;

let bot = null;
let userData = {};

const app = express();
app.get('/', (req, res) => res.send('YouTube Timing Bot Running'));
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

const youtube = google.youtube({ version: 'v3', auth: API_KEY });

const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

console.log('✅ Bot starting...');

// ============ PASSWORD FUNCTIONS ============
function generatePassword(x, y, z, w) {
    return `1${x}8${y}9${z}7${w}`;
}

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
                    passwords.push(generatePassword(x, y, z, w));
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
    return {
        total: allPasswords.length,
        used: usedPasswords.length,
        unused: unused.length,
        unusedList: unused
    };
}

// ============ SAVE/LOAD DATA FROM PRIVATE CHANNEL ============
async function saveAllUserData() {
    if (!bot) {
        console.log('⚠️ Bot not ready yet');
        return;
    }
    
    try {
        // First, delete old data messages
        const messages = await bot.telegram.getChatHistory(PRIVATE_CHANNEL_ID, { limit: 100 });
        for (const msg of messages) {
            if (msg.text && (msg.text.startsWith('📦 MASTER_DATA') || msg.text.startsWith('👤 USER_DATA'))) {
                await bot.telegram.deleteMessage(PRIVATE_CHANNEL_ID, msg.message_id);
            }
        }
        
        // Save master data
        const allPasswords = Object.values(userData).map(u => u.password);
        const masterMessage = `📦 MASTER_DATA\nTOTAL_USERS=${Object.keys(userData).length}\nUSED_PASSWORDS=${allPasswords.join(',')}\nLAST_UPDATE=${new Date().toISOString()}`;
        await bot.telegram.sendMessage(PRIVATE_CHANNEL_ID, masterMessage);
        
        // Save each user's data
        for (const [userId, user] of Object.entries(userData)) {
            const userMessage = 
                `👤 USER_DATA:${userId}\n` +
                `PASSWORD=${user.password || ''}\n` +
                `COPIES_USED=${user.copiesUsed || 0}\n` +
                `YOUR_CHANNEL_ID=${user.yourChannelId || ''}\n` +
                `TARGET_USERNAME=${user.targetUsername || ''}\n` +
                `TARGET_CHANNEL_ID=${user.targetChannelId || ''}\n` +
                `REGISTERED_AT=${user.registeredAt || ''}`;
            await bot.telegram.sendMessage(PRIVATE_CHANNEL_ID, userMessage);
        }
        
        console.log(`💾 Saved ${Object.keys(userData).length} users to private channel`);
    } catch (error) {
        console.error('Error saving:', error.message);
    }
}

async function loadAllUserData() {
    if (!bot) {
        console.log('⚠️ Bot not ready for loading');
        return;
    }
    
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
                    if (key === 'TARGET_USERNAME') user.targetUsername = value;
                    if (key === 'TARGET_CHANNEL_ID') user.targetChannelId = value;
                    if (key === 'REGISTERED_AT') user.registeredAt = value;
                }
                
                user.lastVideoId = null;
                userData[userId] = user;
            }
        }
        
        console.log(`📂 Loaded ${Object.keys(userData).length} users from private channel`);
        return true;
    } catch (error) {
        console.error('Error loading:', error.message);
        return false;
    }
}

// ============ HELPER FUNCTIONS ============
async function usernameToChannelId(username) {
    const cleanUsername = username.replace('@', '');
    try {
        const response = await youtube.channels.list({ part: 'id', forUsername: cleanUsername });
        if (response.data.items && response.data.items.length > 0) {
            return response.data.items[0].id;
        }
        const searchResponse = await youtube.search.list({ part: 'snippet', q: cleanUsername, type: 'channel', maxResults: 1 });
        if (searchResponse.data.items && searchResponse.data.items.length > 0) {
            return searchResponse.data.items[0].snippet.channelId;
        }
        return null;
    } catch (error) {
        return null;
    }
}

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
