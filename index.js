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

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

console.log('✅ Bot starting...');

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
                `TARGET_USERNAME=${user.targetUsername || ''}\n` +
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
                    if (key === 'TARGET_USERNAME') user.targetUsername = value;
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
            
            await bot.telegram.sendMessage(parseInt(userId), 
                `🎬 ${user.targetUsername} posted!\n📤 Published: "${nextVideo.title}"\n📊 Copies left: ${MAX_COPIES_PER_PASSWORD - user.copiesUsed}/${MAX_COPIES_PER_PASSWORD}`);
            
            await makeVideoPublic(nextVideo.id, nextVideo.title);
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
// ============ BOT COMMANDS WITH BUTTONS ============
async function initBot() {
    bot = new Telegraf(BOT_TOKEN);
    
    async function showMainMenu(ctx) {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        let message = `🤖 *YOUTUBE TIMING BOT*\n\n`;
        
        if (user) {
            const copiesLeft = MAX_COPIES_PER_PASSWORD - (user.copiesUsed || 0);
            message += `✅ *Logged in*\n`;
            message += `🔐 Password: \`${user.password}\`\n`;
            message += `📦 Copies left: ${copiesLeft}/${MAX_COPIES_PER_PASSWORD}\n\n`;
            message += `👇 *Choose an option:*`;
        } else {
            message += `👋 *Welcome!*\n\n`;
            message += `Contact ${CONTACT_USERNAME} to purchase a password\n\n`;
            message += `👇 *Choose an option:*`;
        }
        
        await ctx.reply(message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: user ? [
                    [{ text: "🎯 Set My Channel", callback_data: "setmyid" }],
                    [{ text: "👁️ Set Target", callback_data: "settarget" }],
                    [{ text: "📊 Status", callback_data: "status" }],
                    [{ text: "📦 Supply", callback_data: "supply" }],
                    [{ text: "🔢 Copies Left", callback_data: "copies" }],
                    [{ text: "🚪 Logout", callback_data: "logout" }]
                ] : [
                    [{ text: "📝 Register", callback_data: "register" }],
                    [{ text: "❓ Help", callback_data: "help" }]
                ]
            }
        });
    }
    
    // START command
    bot.command('start', async (ctx) => {
        await showMainMenu(ctx);
    });
    
    // ============ BUTTON HANDLERS ============
    
    bot.action('register', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply(
            `🔐 *REGISTER*\n\n` +
            `Send your password:\n` +
            `<code>/register 13869972</code>\n\n` +
            `📦 Each password: ${MAX_COPIES_PER_PASSWORD} Short copies\n\n` +
            `Contact ${CONTACT_USERNAME} to purchase.`,
            { parse_mode: 'Markdown' }
        );
    });
    
    bot.action('setmyid', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply(
            `🎯 *SET YOUR YOUTUBE CHANNEL*\n\n` +
            `Send:\n` +
            `<code>/setmyid @Tewahdotube-21</code>\n\n` +
            `Bot will auto-convert to channel ID!`,
            { parse_mode: 'Markdown' }
        );
    });
    
    bot.action('settarget', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply(
            `👁️ *SET WHO TO MONITOR*\n\n` +
            `Send:\n` +
            `<code>/settarget @Tewahdotube-21</code>`,
            { parse_mode: 'Markdown' }
        );
    });
    
    bot.action('status', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (!user) {
            await ctx.reply('❌ Not registered. Click Register button first.');
            return;
        }
        
        const copiesUsed = user.copiesUsed || 0;
        const copiesLeft = MAX_COPIES_PER_PASSWORD - copiesUsed;
        const videos = user.yourChannelId ? await getYourScheduledShorts(user.yourChannelId) : [];
        
        await ctx.reply(
            `📊 *YOUR STATUS*\n\n` +
            `🔐 Password: ${user.password}\n` +
            `📦 Copies used: ${copiesUsed}/${MAX_COPIES_PER_PASSWORD}\n` +
            `📦 Copies left: ${copiesLeft}\n` +
            `📤 Your Channel: ${user.yourChannelId ? '✅ Set' : '❌ Not set'}\n` +
            `🎯 Target: ${user.targetUsername || '❌ Not set'}\n` +
            `📦 Supply: ${videos.length} scheduled shorts\n` +
            `🟢 Status: ${(user.targetChannelId && user.yourChannelId) ? '✅ ACTIVE' : '⚠️ Setup incomplete'}`,
            { parse_mode: 'Markdown' }
        );
    });
    
    bot.action('supply', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (!user) {
            await ctx.reply('❌ Not registered.');
            return;
        }
        if (!user.yourChannelId) {
            await ctx.reply('❌ Set your channel first using /setmyid');
            return;
        }
        
        const videos = await getYourScheduledShorts(user.yourChannelId);
        if (videos.length === 0) {
            await ctx.reply('📭 No scheduled shorts found.');
        } else {
            let msg = `📦 YOUR SUPPLY (${videos.length})\n\n`;
            videos.slice(0, 10).forEach((v, i) => {
                msg += `${i+1}. ${v.title}\n   ⏰ ${new Date(v.scheduledTime).toLocaleString()}\n\n`;
            });
            await ctx.reply(msg);
        }
    });
    
    bot.action('copies', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (!user) {
            await ctx.reply('❌ Not registered.');
            return;
        }
        
        const copiesUsed = user.copiesUsed || 0;
        const copiesLeft = MAX_COPIES_PER_PASSWORD - copiesUsed;
        
        await ctx.reply(
            `📦 *COPIES REMAINING*\n\n` +
            `Used: ${copiesUsed}/${MAX_COPIES_PER_PASSWORD}\n` +
            `Left: ${copiesLeft}\n\n` +
            `${copiesLeft === 0 ? '⚠️ Password expired! Contact @acespy' : '✅ Active'}`,
            { parse_mode: 'Markdown' }
        );
    });
    
    bot.action('logout', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id.toString();
        delete userData[userId];
        await saveAllUserData();
        await ctx.reply('🔴 Logged out! Send /start to login again.');
    });
    
    bot.action('help', async (ctx) => {
        await ctx.answerCbQuery();
        await showMainMenu(ctx);
    });
    
    // ============ COMMAND HANDLERS ============
    
    bot.command('register', async (ctx) => {
        const userId = ctx.from.id.toString();
        const args = ctx.message.text.split(' ');
        const password = args[1];
        
        if (!password) {
            return ctx.reply(`Usage: /register <password>\nExample: /register 13869972`);
        }
        
        if (password === MASTER_PASSWORD) {
            const info = getUnusedPasswords();
            let msg = `🔓 UNUSED PASSWORDS (${info.unused} available)\n\n`;
            info.unusedList.slice(0, 30).forEach(p => { msg += `${p}  `; });
            return ctx.reply(msg);
        }
        
        if (!parsePassword(password)) {
            return ctx.reply(`❌ Invalid format! Must be 8 digits: 1x8y9z7w`);
        }
        
        if (userData[userId]) {
            return ctx.reply(`✅ Already registered! Password: ${userData[userId].password}`);
        }
        
        const existing = Object.values(userData).find(u => u.password === password);
        if (existing) {
            return ctx.reply(`❌ Password already registered! Contact ${CONTACT_USERNAME}`);
        }
        
        userData[userId] = {
            password: password,
            copiesUsed: 0,
            registeredAt: new Date().toISOString(),
            yourChannelId: '',
            targetUsername: '',
            targetChannelId: ''
        };
        
        await saveAllUserData();
        await ctx.reply(`✅ Registered! Password: ${password}\n📦 ${MAX_COPIES_PER_PASSWORD} copies\n\nNow use /setmyid @yourchannel`);
    });
    
    bot.command('setmyid', async (ctx) => {
        const userId = ctx.from.id.toString();
        const args = ctx.message.text.split(' ');
        const input = args[1];
        
        if (!userData[userId]) {
            return ctx.reply('❌ Register first: /register <password>');
        }
        
        if (!input) {
            return ctx.reply('Usage: /setmyid @username\nExample: /setmyid @Tewahdotube-21');
        }
        
        let channelId = input;
        
        if (input.startsWith('@')) {
            await ctx.reply(`🔄 Converting ${input}...`);
            channelId = await usernameToChannelId(input);
            if (!channelId) {
                return ctx.reply(`❌ Could not find: ${input}`);
            }
        }
        
        if (!channelId.startsWith('UC')) {
            return ctx.reply('❌ Invalid channel ID!');
        }
        
        userData[userId].yourChannelId = channelId;
        await saveAllUserData();
        await ctx.reply(`✅ Your channel saved!\n🔹 ${input}\n🔸 ${channelId}\n\nNow use /settarget @user`);
    });
    
    bot.command('settarget', async (ctx) => {
        const userId = ctx.from.id.toString();
        const args = ctx.message.text.split(' ');
        const target = args[1];
        
        if (!userData[userId]) {
            return ctx.reply('❌ Register first');
        }
        
        if (!target) {
            return ctx.reply('Usage: /settarget @username\nExample: /settarget @Tewahdotube-21');
        }
        
        userData[userId].targetUsername = target;
        await ctx.reply(`🔄 Converting ${target}...`);
        const channelId = await usernameToChannelId(target);
        
        if (channelId) {
            userData[userId].targetChannelId = channelId;
            await saveAllUserData();
            await ctx.reply(`✅ Now monitoring: ${target}\n🆔 ${channelId}`);
        } else {
            await ctx.reply(`❌ Could not find: ${target}`);
        }
    });
    
    bot.command('status', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (!user) {
            return ctx.reply('❌ Not registered. Send /start');
        }
        
        const copiesUsed = user.copiesUsed || 0;
        const copiesLeft = MAX_COPIES_PER_PASSWORD - copiesUsed;
        const videos = user.yourChannelId ? await getYourScheduledShorts(user.yourChannelId) : [];
        
        await ctx.reply(
            `📊 *YOUR STATUS*\n\n` +
            `🔐 Password: ${user.password}\n` +
            `📦 Copies used: ${copiesUsed}/${MAX_COPIES_PER_PASSWORD}\n` +
            `📦 Copies left: ${copiesLeft}\n` +
            `📤 Your Channel: ${user.yourChannelId || '❌ Not set'}\n` +
            `🎯 Target: ${user.targetUsername || '❌ Not set'}\n` +
            `📦 Supply: ${videos.length} scheduled shorts\n` +
            `🟢 Status: ${(user.targetChannelId && user.yourChannelId) ? '✅ ACTIVE' : '⚠️ Setup incomplete'}`,
            { parse_mode: 'Markdown' }
        );
    });
    
    bot.command('supply', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (!user) return ctx.reply('❌ Register first');
        if (!user.yourChannelId) return ctx.reply('❌ Set your channel first: /setmyid');
        
        const videos = await getYourScheduledShorts(user.yourChannelId);
        if (videos.length === 0) {
            await ctx.reply('📭 No scheduled shorts found.');
        } else {
            let msg = `📦 YOUR SUPPLY (${videos.length})\n\n`;
            videos.slice(0, 10).forEach((v, i) => {
                msg += `${i+1}. ${v.title}\n   ⏰ ${new Date(v.scheduledTime).toLocaleString()}\n\n`;
            });
            await ctx.reply(msg);
        }
    });
    
    bot.command('copies', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (!user) return ctx.reply('❌ Register first');
        
        const copiesUsed = user.copiesUsed || 0;
        const copiesLeft = MAX_COPIES_PER_PASSWORD - copiesUsed;
        
        await ctx.reply(`📦 COPIES REMAINING\n\nUsed: ${copiesUsed}/${MAX_COPIES_PER_PASSWORD}\nLeft: ${copiesLeft}`);
    });
    
    bot.command('help', async (ctx) => {
        await showMainMenu(ctx);
    });
    
    bot.launch();
    console.log('🤖 Bot started with buttons!');
}

// ============ START ============
async function start() {
    console.log('🚀 Starting YouTube Timing Bot...');
    await initBot();
    await loadAllUserData();
    console.log(`👥 Loaded ${Object.keys(userData).length} users`);
    setInterval(monitorAllUsers, 60000);
    console.log('🔍 Monitoring active...');
}

start();
