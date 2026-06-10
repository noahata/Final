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
    
    // Check if user has copies left (MAX 10)
    const copiesUsed = user.copiesUsed || 0;
    if (copiesUsed >= MAX_COPIES_PER_PASSWORD) {
        console.log(`User ${userId}: No copies left (${copiesUsed}/${MAX_COPIES_PER_PASSWORD})`);
        return;
    }
    
    try {
        const channelRes = await youtube.channels.list({ part: 'contentDetails', id: user.targetChannelId });
        if (!channelRes.data.items) return;
        
        const playlistId = channelRes.data.items[0].contentDetails.relatedPlaylists.uploads;
        const playlistRes = await youtube.playlistItems.list({ part: 'snippet', playlistId, maxResults: 1 });
        if (!playlistRes.data.items) return;
        
        const latest = playlistRes.data.items[0];
        const videoId = latest.snippet.resourceId.videoId;
        const publishedAt = latest.snippet.publishedAt;
        
        const videoRes = await youtube.videos.list({ part: 'contentDetails', id: videoId });
        const duration = videoRes.data.items[0].contentDetails.duration;
        const match = duration.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
        const minutes = parseInt(match?.[1]) || 0;
        const seconds = parseInt(match?.[2]) || 0;
        const isShort = (minutes * 60 + seconds) <= 60;
        
        if (videoId !== user.lastVideoId && isShort) {
            user.lastVideoId = videoId;
            const yourVideos = await getYourScheduledShorts(user.yourChannelId);
            if (yourVideos.length === 0) return;
            
            const nextVideo = yourVideos[0];
            user.copiesUsed = (user.copiesUsed || 0) + 1;
            await saveAllUserData();
            await makeVideoPublic(nextVideo.id, nextVideo.title);
            
            const copiesLeft = MAX_COPIES_PER_PASSWORD - user.copiesUsed;
            await bot.telegram.sendMessage(parseInt(userId), 
                `🎬 *Target channel posted!*\n\n📤 Published: *${nextVideo.title}*\n📊 Copies left: ${copiesLeft}/${MAX_COPIES_PER_PASSWORD}`,
                { parse_mode: 'Markdown' }
            );
            
            if (user.copiesUsed >= MAX_COPIES_PER_PASSWORD) {
                await bot.telegram.sendMessage(parseInt(userId),
                    `⚠️ *Password expired!*\n\nYou've used all ${MAX_COPIES_PER_PASSWORD} copies.\nContact ${CONTACT_USERNAME} to purchase a new password.`,
                    { parse_mode: 'Markdown' }
                );
            }
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
// ============ BOT COMMANDS WITH KEYBOARD ============
async function initBot() {
    bot = new Telegraf(BOT_TOKEN);
    
    // START command
    bot.command('start', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (user) {
            const copiesLeft = MAX_COPIES_PER_PASSWORD - (user.copiesUsed || 0);
            await ctx.reply(
                `👋 *Welcome back!*\n\n🔐 Password: \`${user.password}\`\n📦 ${copiesLeft}/${MAX_COPIES_PER_PASSWORD} copies remaining\n\n👇 *Tap any button below*`,
                { parse_mode: 'Markdown', ...mainKeyboard }
            );
        } else {
            await ctx.reply(
                `🎬 *YouTube Timing Bot*\n\nI help you publish your scheduled Shorts at the EXACT same time as any creator.\n\n✨ ${MAX_COPIES_PER_PASSWORD} timing copies per password\n\n👇 *Get started*`,
                { parse_mode: 'Markdown', ...authKeyboard }
            );
        }
    });
    
    // ============ KEYBOARD BUTTON HANDLERS ============
    
    bot.hears('📊 MY STATUS', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (!user) {
            await ctx.reply('❌ Not registered. Tap "🔐 I HAVE A PASSWORD" to start.', authKeyboard);
            return;
        }
        
        const copiesUsed = user.copiesUsed || 0;
        const copiesLeft = MAX_COPIES_PER_PASSWORD - copiesUsed;
        const videos = user.yourChannelId ? await getYourScheduledShorts(user.yourChannelId) : [];
        
        await ctx.reply(
            `📊 *YOUR STATUS*\n\n🔐 Password: \`${user.password}\`\n📦 Used: ${copiesUsed}/${MAX_COPIES_PER_PASSWORD}\n📦 Left: ${copiesLeft}\n📤 Your Channel: ${user.yourChannelId ? '✅ Set' : '❌ Not set'}\n🎯 Target: ${user.targetChannelId ? '✅ Set' : '❌ Not set'}\n📹 Supply: ${videos.length} scheduled shorts\n🟢 Status: ${(user.targetChannelId && user.yourChannelId) ? '✅ ACTIVE' : '⚠️ Setup needed'}`,
            { parse_mode: 'Markdown', ...mainKeyboard }
        );
    });
    
    bot.hears('🎯 SET MY CHANNEL', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (!user) {
            await ctx.reply('❌ Register first. Tap "🔐 I HAVE A PASSWORD"', authKeyboard);
            return;
        }
        
        await ctx.reply(
            `🎯 *Set Your YouTube Channel*\n\nSend me your channel @username or Channel ID:\n\nExamples:\n• \`/setmyid @MrBeast\`\n• \`/setmyid UCX6OQ3DkcsbYNE6H8uQQuVA\`\n\nI'll auto-convert @username for you! 🔄`,
            { parse_mode: 'Markdown', ...mainKeyboard }
        );
        userSession[userId] = { step: 'awaiting_channel_id' };
    });
    
    bot.hears('👁️ SET TARGET', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (!user) {
            await ctx.reply('❌ Register first.', authKeyboard);
            return;
        }
        
        await ctx.reply(
            `👁️ *Set Who to Monitor*\n\nSend me their channel @username or Channel ID:\n\nExamples:\n• \`/settarget @Tewahdotube-21\`\n• \`/settarget UC7_YxT-KID8kRbqZo7MyscQ\`\n\nI'll watch this channel and copy their timing! ⏰`,
            { parse_mode: 'Markdown', ...mainKeyboard }
        );
        userSession[userId] = { step: 'awaiting_target_id' };
    });
    
    bot.hears('📦 MY SUPPLY', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (!user) {
            await ctx.reply('❌ Register first.', authKeyboard);
            return;
        }
        
        if (!user.yourChannelId) {
            await ctx.reply('❌ Set your channel first using "🎯 SET MY CHANNEL" button', mainKeyboard);
            return;
        }
        
        const videos = await getYourScheduledShorts(user.yourChannelId);
        if (videos.length === 0) {
            await ctx.reply(`📭 *No scheduled shorts found*\n\nUpload a Short to YouTube and choose "Schedule" instead of "Public".\n\nThen I'll publish them at the right time! 🚀`, { parse_mode: 'Markdown', ...mainKeyboard });
        } else {
            let msg = `📦 *YOUR SUPPLY (${videos.length} shorts)*\n\n`;
            videos.slice(0, 10).forEach((v, i) => {
                msg += `${i+1}. ${v.title}\n   ⏰ ${new Date(v.scheduledTime).toLocaleString()}\n\n`;
            });
            await ctx.reply(msg, { parse_mode: 'Markdown', ...mainKeyboard });
        }
    });
    
    bot.hears('🔢 COPIES LEFT', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (!user) {
            await ctx.reply('❌ Register first.', authKeyboard);
            return;
        }
        
        const copiesUsed = user.copiesUsed || 0;
        const copiesLeft = MAX_COPIES_PER_PASSWORD - copiesUsed;
        
        await ctx.reply(
            `📦 *TIMING COPIES*\n\n🎯 Used: ${copiesUsed}/${MAX_COPIES_PER_PASSWORD}\n✨ Remaining: ${copiesLeft}\n🔐 Status: ${copiesLeft === 0 ? '⚠️ EXPIRED' : '✅ ACTIVE'}\n\n${copiesLeft === 0 ? `Contact ${CONTACT_USERNAME} to purchase more.` : 'Ready for the next Short!'}`,
            { parse_mode: 'Markdown', ...mainKeyboard }
        );
    });
    
    bot.hears('❓ HELP', async (ctx) => {
        await ctx.reply(
            `🤖 *YouTube Timing Bot - Help*\n\n📋 *How it works:*\n1. Purchase a password from ${CONTACT_USERNAME}\n2. Tap "🔐 I HAVE A PASSWORD"\n3. Set your YouTube Channel\n4. Set who to monitor\n5. I'll automatically publish your scheduled Shorts at the exact same time!\n\n📦 Each password: ${MAX_COPIES_PER_PASSWORD} timing copies\n\n🔤 *Password format:* \`1x8y9z7w\` (Example: \`13869972\`)`,
            { parse_mode: 'Markdown', ...mainKeyboard }
        );
    });
    
    bot.hears('❓ HOW TO GET CHANNEL ID', async (ctx) => {
        await ctx.reply(
            `🔍 *Find Any YouTube Channel ID*\n\n📱 *Method 1 (Easiest):*\n• Open Telegram\n• Search @youtube_channel_id_bot\n• Send @username or video link\n• Copy the UCxxxxxx ID\n\n💻 *Method 2:*\n• Go to YouTube Studio\n• Settings → Channel → Advanced\n• Copy your Channel ID\n\n🎯 *Method 3:*\n• Look at channel URL\n• youtube.com/channel/UCxxxxxx\n• Copy the UCxxxxxx part`,
            { parse_mode: 'Markdown', ...mainKeyboard }
        );
    });
    
    bot.hears('🔐 I HAVE A PASSWORD', async (ctx) => {
        await ctx.reply(
            `🔐 *Enter Your Password*\n\nPlease send your 8-digit password:\n\nExample: \`13869972\`\n\n(Format: 1x8y9z7w where x,y,z,w are digits 0-9)`,
            { parse_mode: 'Markdown' }
        );
        userSession[ctx.from.id.toString()] = { step: 'awaiting_password' };
    });
    
    bot.hears('🚪 LOGOUT', async (ctx) => {
        const userId = ctx.from.id.toString();
        delete userData[userId];
        await saveAllUserData();
        await ctx.reply(`🔴 *Logged out successfully*\n\nYour data has been cleared. Send /start to login again.`, { parse_mode: 'Markdown', ...authKeyboard });
    });
    
    // ============ TEXT HANDLERS ============
    bot.on('text', async (ctx) => {
        const userId = ctx.from.id.toString();
        const text = ctx.message.text.trim();
        const session = userSession[userId];
        
        // Handle /setmyid command
        if (text.startsWith('/setmyid')) {
            const args = text.split(' ');
            const input = args[1];
            const user = userData[userId];
            
            if (!user) {
                await ctx.reply('❌ Register first.', authKeyboard);
                return;
            }
            
            if (!input) {
                await ctx.reply('Usage: /setmyid @username or UCxxxxxx', mainKeyboard);
                return;
            }
            
            let channelId = input;
            if (input.startsWith('@')) {
                await ctx.reply(`🔄 Converting...`);
                channelId = await convertHandleToChannelId(input);
                if (!channelId) {
                    await ctx.reply(`❌ Could not find: ${input}`, mainKeyboard);
                    return;
                }
            }
            
            if (!channelId.startsWith('UC')) {
                await ctx.reply('❌ Invalid Channel ID!', mainKeyboard);
                return;
            }
            
            userData[userId].yourChannelId = channelId;
            await saveAllUserData();
            await ctx.reply(`✅ Channel saved: \`${channelId}\``, { parse_mode: 'Markdown', ...mainKeyboard });
            return;
        }
        
        // Handle /settarget command
        if (text.startsWith('/settarget')) {
            const args = text.split(' ');
            const input = args[1];
            const user = userData[userId];
            
            if (!user) {
                await ctx.reply('❌ Register first.', authKeyboard);
                return;
            }
            
            if (!input) {
                await ctx.reply('Usage: /settarget @username or UCxxxxxx', mainKeyboard);
                return;
            }
            
            let targetId = input;
            if (input.startsWith('@')) {
                await ctx.reply(`🔄 Converting...`);
                targetId = await convertHandleToChannelId(input);
                if (!targetId) {
                    await ctx.reply(`❌ Could not find: ${input}`, mainKeyboard);
                    return;
                }
            }
            
            if (!targetId.startsWith('UC')) {
                await ctx.reply('❌ Invalid Channel ID!', mainKeyboard);
                return;
            }
            
            userData[userId].targetChannelId = targetId;
            await saveAllUserData();
            await ctx.reply(`✅ Now monitoring: \`${targetId}\``, { parse_mode: 'Markdown', ...mainKeyboard });
            return;
        }
        
        // Handle password input
        if (session && session.step === 'awaiting_password') {
            const password = text;
            
            if (password === MASTER_PASSWORD) {
                const info = getUnusedPasswords();
                let msg = `🔓 *Available passwords: ${info.unused}*\n\n`;
                info.unusedList.slice(0, 30).forEach(p => { msg += `\`${p}\` `; });
                await ctx.reply(msg, { parse_mode: 'Markdown', ...mainKeyboard });
                delete userSession[userId];
                return;
            }
            
            if (!parsePassword(password)) {
                await ctx.reply(`❌ Invalid format! Password must be 8 digits.\nExample: \`13869972\``, { parse_mode: 'Markdown' });
                return;
            }
            
            if (userData[userId]) {
                await ctx.reply(`✅ Already registered!`, mainKeyboard);
                delete userSession[userId];
                return;
            }
            
            const existing = Object.values(userData).find(u => u.password === password);
            if (existing) {
                await ctx.reply(`❌ Password already used! Contact ${CONTACT_USERNAME}`, authKeyboard);
                delete userSession[userId];
                return;
            }
            
            userData[userId] = {
                password: password,
                copiesUsed: 0,
                registeredAt: new Date().toISOString(),
                yourChannelId: '',
                targetChannelId: ''
            };
            await saveAllUserData();
            
            await ctx.reply(`🎉 *Registration successful!*\n\n🔐 Password: \`${password}\`\n📦 ${MAX_COPIES_PER_PASSWORD} timing copies\n\nNow tap "🎯 SET MY CHANNEL" to get started!`, { parse_mode: 'Markdown', ...mainKeyboard });
            delete userSession[userId];
        }
        
        // Handle Channel ID input from button flow
        else if (session && session.step === 'awaiting_channel_id') {
            let channelId = text;
            const user = userData[userId];
            
            if (!user) {
                await ctx.reply('❌ Register first.', authKeyboard);
                delete userSession[userId];
                return;
            }
            
            if (text.startsWith('@')) {
                await ctx.reply(`🔄 Converting @handle...`);
                channelId = await convertHandleToChannelId(text);
                if (!channelId) {
                    await ctx.reply(`❌ Could not find: ${text}\n\nUse @youtube_channel_id_bot to get the ID.`, mainKeyboard);
                    delete userSession[userId];
                    return;
                }
                await ctx.reply(`✅ Found: \`${channelId}\``, { parse_mode: 'Markdown' });
            }
            
            if (!channelId.startsWith('UC')) {
                await ctx.reply(`❌ Invalid Channel ID! Must start with "UC"`, mainKeyboard);
                delete userSession[userId];
                return;
            }
            
            userData[userId].yourChannelId = channelId;
            await saveAllUserData();
            await ctx.reply(`✅ Channel saved: \`${channelId}\`\n\nNow tap "👁️ SET TARGET" to choose who to monitor!`, { parse_mode: 'Markdown', ...mainKeyboard });
            delete userSession[userId];
        }
        
        // Handle Target ID input from button flow
        else if (session && session.step === 'awaiting_target_id') {
            let targetId = text;
            const user = userData[userId];
            
            if (!user) {
                await ctx.reply('❌ Register first.', authKeyboard);
                delete userSession[userId];
                return;
            }
            
            if (text.startsWith('@')) {
                await ctx.reply(`🔄 Converting @handle...`);
                targetId = await convertHandleToChannelId(text);
                if (!targetId) {
                    await ctx.reply(`❌ Could not find: ${text}\n\nUse @youtube_channel_id_bot to get the ID.`, mainKeyboard);
                    delete userSession[userId];
                    return;
                }
                await ctx.reply(`✅ Found: \`${targetId}\``, { parse_mode: 'Markdown' });
            }
            
            if (!targetId.startsWith('UC')) {
                await ctx.reply(`❌ Invalid Channel ID! Must start with "UC"`, mainKeyboard);
                delete userSession[userId];
                return;
            }
            
            userData[userId].targetChannelId = targetId;
            await saveAllUserData();
            await ctx.reply(`✅ Now monitoring: \`${targetId}\`\n\nTap "📊 MY STATUS" to see everything is ready! 🚀`, { parse_mode: 'Markdown', ...mainKeyboard });
            delete userSession[userId];
        }
    });
    
    bot.launch();
    console.log('🤖 Bot started with keyboard menu!');
}

// ============ START ============
async function start() {
    console.log('🚀 Starting YouTube Timing Bot...');
    await initBot();
    await loadAllUserData();
    console.log(`👥 Loaded ${Object.keys(userData).length} users`);
    console.log(`📦 Max copies per password: ${MAX_COPIES_PER_PASSWORD}`);
    setInterval(monitorAllUsers, 60000);
    console.log('🔍 Monitoring active...');
}

start();
