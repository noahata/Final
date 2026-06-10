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
// ============ BOT COMMANDS ============
async function initBot() {
    bot = new Telegraf(BOT_TOKEN);
    
    // START command
    bot.command('start', async (ctx) => {
        const userId = ctx.from.id;
        if (userData[userId]) {
            const left = MAX_COPIES - (userData[userId].copiesUsed || 0);
            await ctx.reply(`👋 Welcome back!\n📦 ${left}/${MAX_COPIES} copies left`, mainMenu);
        } else {
            await ctx.reply(`🎬 *YouTube Timing Bot*\n\nContact ${CONTACT_USERNAME} to purchase access.\n\n/register PASSWORD`, { parse_mode: 'Markdown', ...authMenu });
        }
    });
    
    // REGISTER - Customer only sees success/failure
    bot.command('register', async (ctx) => {
        const userId = ctx.from.id;
        const parts = ctx.message.text.split(' ');
        const password = parts[1];
        
        if (!password) return ctx.reply('Send: /register PASSWORD');
        
        // MASTER PASSWORD - Only YOU see the list
        if (password === MASTER_PASSWORD) {
            const used = Object.values(userData).map(u => u.password);
            await ctx.reply(`📊 *Admin Stats*\n\nUsed passwords: ${used.length}\nTotal users: ${Object.keys(userData).length}\n\nUsed: ${used.join(', ') || 'None'}`, { parse_mode: 'Markdown' });
            return;
        }
        
        // Validate format
        if (!/^1[0-9]8[0-9]9[0-9]7[0-9]$/.test(password)) {
            return ctx.reply('❌ Invalid password format! Contact support.');
        }
        
        if (userData[userId]) return ctx.reply('✅ You are already registered!');
        
        // Check if password already used
        const taken = Object.values(userData).some(u => u.password === password);
        if (taken) {
            return ctx.reply('❌ Invalid password. Please contact support.');
        }
        
        // Register new user
        userData[userId] = {
            password,
            copiesUsed: 0,
            channelId: '',
            targetId: '',
            refreshToken: '',
            lastVideoId: null
        };
        await saveData();
        
        await ctx.reply(
            `✅ *Access Granted!*\n\n📦 ${MAX_COPIES} timing copies\n\n🔐 *Next: Authorize YouTube*\nTap "🔐 OAUTH" button below.`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    });
    
    // OAUTH button - Send login link
    bot.hears('🔐 OAUTH', async (ctx) => {
        const userId = ctx.from.id;
        if (!userData[userId]) {
            return ctx.reply('Register first: /register PASSWORD', authMenu);
        }
        
        if (userData[userId].refreshToken) {
            return ctx.reply('✅ Already authorized! Use /status to check.', mainMenu);
        }
        
        const oauthLink = getOAuthLink();
        await ctx.reply(
            `🔐 *Authorize YouTube*\n\n` +
            `1️⃣ Click: ${oauthLink}\n\n` +
            `2️⃣ Login with your YouTube account\n\n` +
            `3️⃣ Click "Allow"\n\n` +
            `4️⃣ Copy the code (starts with 4/)\n\n` +
            `5️⃣ Send: /auth CODE`,
            { parse_mode: 'Markdown' }
        );
    });
    
    // AUTH command
    bot.command('auth', async (ctx) => {
        const userId = ctx.from.id;
        const parts = ctx.message.text.split(' ');
        const code = parts[1];
        
        if (!userData[userId]) return ctx.reply('Register first!');
        if (!code) return ctx.reply('Send: /auth CODE');
        
        await ctx.reply('🔄 Authorizing...');
        
        try {
            const tokens = await exchangeCodeForTokens(code);
            userData[userId].refreshToken = tokens.refresh_token;
            
            const channelId = await getYouTubeChannelId(tokens.access_token);
            if (channelId) {
                userData[userId].channelId = channelId;
                await ctx.reply(`✅ Authorized!\n📤 Your Channel ID: ${channelId}\n\nNow set your target:\n/settarget @username`, mainMenu);
            } else {
                await ctx.reply(`✅ Authorized!\n\nNow set your channel:\n/setchannel UCxxxxxx`, mainMenu);
            }
            await saveData();
        } catch (error) {
            await ctx.reply(`❌ Authorization failed!\n\nPlease try again with a new code.`, mainMenu);
        }
    });
    
    // SET MY CHANNEL - Auto-converts ANY @username
    bot.command('setchannel', async (ctx) => {
        const userId = ctx.from.id;
        const parts = ctx.message.text.split(' ');
        let input = parts.slice(1).join(' ');
        
        if (!userData[userId]) return ctx.reply('Register first!');
        if (!input) return ctx.reply('Send: /setchannel @username OR UCxxxxxx');
        
        let channelId = input;
        
        if (input.startsWith('@')) {
            await ctx.reply(`🔄 Converting ${input}...`);
            channelId = await convertHandleToChannelId(input);
            if (!channelId) {
                return ctx.reply(`❌ Could not find: ${input}\n\nUse @youtube_channel_id_bot to get Channel ID.`);
            }
            await ctx.reply(`✅ Found: ${channelId}`);
        }
        
        if (!channelId.startsWith('UC')) {
            return ctx.reply('❌ Invalid! Must start with UC');
        }
        
        userData[userId].channelId = channelId;
        await saveData();
        await ctx.reply(`✅ Channel saved!`, mainMenu);
    });
    
    // SET TARGET - Auto-converts ANY @username
    bot.command('settarget', async (ctx) => {
        const userId = ctx.from.id;
        const parts = ctx.message.text.split(' ');
        let input = parts.slice(1).join(' ');
        
        if (!userData[userId]) return ctx.reply('Register first!');
        if (!input) return ctx.reply('Send: /settarget @username OR UCxxxxxx');
        
        let targetId = input;
        
        if (input.startsWith('@')) {
            await ctx.reply(`🔄 Converting ${input}...`);
            targetId = await convertHandleToChannelId(input);
            if (!targetId) {
                return ctx.reply(`❌ Could not find: ${input}\n\nUse @youtube_channel_id_bot to get Channel ID.`);
            }
            await ctx.reply(`✅ Found: ${targetId}`);
        }
        
        if (!targetId.startsWith('UC')) {
            return ctx.reply('❌ Invalid! Must start with UC');
        }
        
        userData[userId].targetId = targetId;
        await saveData();
        await ctx.reply(`✅ Now monitoring!`, mainMenu);
    });
    
    // STATUS command
    bot.command('status', async (ctx) => {
        const userId = ctx.from.id;
        const user = userData[userId];
        if (!user) return ctx.reply('Register first!', authMenu);
        
        const left = MAX_COPIES - (user.copiesUsed || 0);
        await ctx.reply(
            `📊 *Status*\n\n` +
            `📦 Copies left: ${left}/${MAX_COPIES}\n` +
            `🔑 OAuth: ${user.refreshToken ? '✅' : '❌'}\n` +
            `📤 Your Channel: ${user.channelId ? '✅' : '❌'}\n` +
            `🎯 Target: ${user.targetId ? '✅' : '❌'}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    });
    
    // SUPPLY command
    bot.command('supply', async (ctx) => {
        const userId = ctx.from.id;
        const user = userData[userId];
        if (!user) return ctx.reply('Register first!');
        if (!user.channelId || !user.refreshToken) {
            return ctx.reply('Set up your channel and authorize OAuth first!', mainMenu);
        }
        
        await ctx.reply('🔄 Loading your scheduled shorts...');
        const shorts = await getScheduledShorts(user.channelId, user.refreshToken);
        
        if (shorts.length === 0) {
            await ctx.reply('📭 No scheduled shorts found.\n\nUpload a Short and choose "Schedule" instead of "Public".', mainMenu);
        } else {
            let msg = `📦 *Your Supply (${shorts.length})*\n\n`;
            shorts.slice(0, 10).forEach((s, i) => {
                msg += `${i+1}. ${s.title}\n   ⏰ ${new Date(s.time).toLocaleString()}\n\n`;
            });
            await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
        }
    });
    
    // COPIES command
    bot.command('copies', async (ctx) => {
        const userId = ctx.from.id;
        const user = userData[userId];
        if (!user) return ctx.reply('Register first!');
        
        const left = MAX_COPIES - (user.copiesUsed || 0);
        await ctx.reply(`📦 *Copies Remaining*\n\n${left}/${MAX_COPIES}\n\n${left === 0 ? `⚠️ Contact ${CONTACT_USERNAME} to purchase more.` : '✅ Active'}`, { parse_mode: 'Markdown', ...mainMenu });
    });
    
    // ============ BUTTON HANDLERS ============
    bot.hears('📊 STATUS', async (ctx) => await ctx.reply('/status'));
    bot.hears('🎯 MY CHANNEL', async (ctx) => await ctx.reply('/setchannel @username'));
    bot.hears('👁️ TARGET', async (ctx) => await ctx.reply('/settarget @username'));
    bot.hears('🔢 COPIES', async (ctx) => await ctx.reply('/copies'));
    bot.hears('📦 SUPPLY', async (ctx) => await ctx.reply('/supply'));
    bot.hears('🔐 REGISTER', async (ctx) => await ctx.reply('/register PASSWORD'));
    bot.hears('❓ HELP', async (ctx) => await ctx.reply('/status'));
    
    bot.hears('🚪 LOGOUT', async (ctx) => {
        const userId = ctx.from.id;
        delete userData[userId];
        await saveData();
        await ctx.reply('🔴 Logged out! Send /start to login again.', authMenu);
    });
    
    bot.launch();
    console.log('🤖 Bot started!');
}

// ============ START ============
async function start() {
    console.log('🚀 Starting YouTube Timing Bot...');
    await initBot();
    await loadData();
    console.log(`👥 Loaded ${Object.keys(userData).length} users`);
    console.log(`📦 Max copies per password: ${MAX_COPIES}`);
    
    // Monitor all users every 30 seconds
    setInterval(async () => {
        for (const [userId, user] of Object.entries(userData)) {
            await monitorTargetChannel(userId, user);
        }
    }, 30000);
    
    console.log('🔍 Monitoring active...');
}

start();
