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

// YouTube for monitoring (API Key - reads public data)
const youtube = google.youtube({ version: 'v3', auth: API_KEY });

// OAuth2 client with AUTO-REFRESH capability
const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

console.log('✅ OAuth2 client configured with auto-refresh');

// ============ PASSWORD FORMULA ============
function generatePassword(x, y, z, w) {
    return `1${x}8${y}9${z}7${w}`;
}

function parsePassword(password) {
    if (!password || password.length !== 8) return null;
    const parts = password.split('');
    if (parts[0] !== '1' || parts[2] !== '8' || parts[4] !== '9' || parts[6] !== '7') {
        return null;
    }
    return {
        x: parseInt(parts[1]),
        y: parseInt(parts[3]),
        z: parseInt(parts[5]),
        w: parseInt(parts[7]),
        full: password
    };
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

// ============ STORE DATA IN PRIVATE CHANNEL ============
async function saveAllUserData() {
    try {
        const messages = await bot.telegram.getChatHistory(PRIVATE_CHANNEL_ID, { limit: 200 });
        for (const msg of messages) {
            if (msg.text && (msg.text.startsWith('📦 MASTER_DATA') || msg.text.startsWith('👤 USER_DATA'))) {
                await bot.telegram.deleteMessage(PRIVATE_CHANNEL_ID, msg.message_id);
            }
        }
        
        const allPasswords = Object.values(userData).map(u => u.password);
        const masterMessage = 
            `📦 MASTER_DATA\n` +
            `TOTAL_USERS=${Object.keys(userData).length}\n` +
            `USED_PASSWORDS=${allPasswords.join(',')}\n` +
            `LAST_UPDATE=${new Date().toISOString()}`;
        await bot.telegram.sendMessage(PRIVATE_CHANNEL_ID, masterMessage);
        
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
        
        console.log(`💾 Saved ${Object.keys(userData).length} users`);
    } catch (error) {
        console.error('Error saving:', error.message);
    }
}

async function loadAllUserData() {
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
        return true;
    } catch (error) {
        console.error('Error loading:', error.message);
        return false;
    }
}

// ============ CONVERT USERNAME TO CHANNEL ID ============
async function usernameToChannelId(username) {
    const cleanUsername = username.replace('@', '');
    try {
        const response = await youtube.channels.list({
            part: 'id',
            forUsername: cleanUsername
        });
        if (response.data.items && response.data.items.length > 0) {
            return response.data.items[0].id;
        }
        const searchResponse = await youtube.search.list({
            part: 'snippet',
            q: cleanUsername,
            type: 'channel',
            maxResults: 1
        });
        if (searchResponse.data.items && searchResponse.data.items.length > 0) {
            return searchResponse.data.items[0].snippet.channelId;
        }
        return null;
    } catch (error) {
        return null;
    }
}

// ============ VIDEO MANAGEMENT ============
async function getYourScheduledShorts(yourChannelId) {
    if (!yourChannelId) return [];
    
    try {
        const response = await youtubeAuth.search.list({
            part: 'snippet',
            channelId: yourChannelId,
            type: 'video',
            maxResults: 50
        });
        
        const scheduledVideos = [];
        for (const item of response.data.items) {
            try {
                const videoRes = await youtubeAuth.videos.list({
                    part: 'status',
                    id: item.id.videoId
                });
                if (videoRes.data.items && videoRes.data.items[0]) {
                    const status = videoRes.data.items[0].status;
                    if (status.privacyStatus === 'private' && status.publishAt) {
                        scheduledVideos.push({
                            id: item.id.videoId,
                            title: item.snippet.title,
                            scheduledTime: status.publishAt
                        });
                    }
                }
            } catch (e) {}
        }
        return scheduledVideos;
    } catch (error) {
        console.error('Error:', error.message);
        return [];
    }
}

async function makeVideoPublic(videoId, videoTitle) {
    try {
        await youtubeAuth.videos.update({
            part: 'status',
            requestBody: {
                id: videoId,
                status: {
                    privacyStatus: 'public',
                    publishAt: null
                }
            }
        });
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
    
    // Check if user has copies left
    const copiesUsed = user.copiesUsed || 0;
    if (copiesUsed >= MAX_COPIES_PER_PASSWORD) {
        console.log(`User ${userId}: No copies left (${copiesUsed}/${MAX_COPIES_PER_PASSWORD})`);
        return;
    }
    
    try {
        const channelRes = await youtube.channels.list({
            part: 'contentDetails',
            id: user.targetChannelId
        });
        if (!channelRes.data.items || channelRes.data.items.length === 0) return;
        
        const playlistId = channelRes.data.items[0].contentDetails.relatedPlaylists.uploads;
        const playlistRes = await youtube.playlistItems.list({
            part: 'snippet',
            playlistId: playlistId,
            maxResults: 1
        });
        if (!playlistRes.data.items || playlistRes.data.items.length === 0) return;
        
        const latest = playlistRes.data.items[0];
        const videoId = latest.snippet.resourceId.videoId;
        const publishedAt = latest.snippet.publishedAt;
        
        const videoRes = await youtube.videos.list({
            part: 'contentDetails',
            id: videoId
        });
        
        const duration = videoRes.data.items[0].contentDetails.duration;
        const match = duration.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
        const minutes = parseInt(match?.[1]) || 0;
        const seconds = parseInt(match?.[2]) || 0;
        const totalSeconds = minutes * 60 + seconds;
        const isShort = totalSeconds <= 60;
        
        if (videoId !== user.lastVideoId && isShort) {
            user.lastVideoId = videoId;
            console.log(`\n🎬 ${user.targetUsername} posted at: ${publishedAt}`);
            
            const yourVideos = await getYourScheduledShorts(user.yourChannelId);
            if (yourVideos.length === 0) {
                console.log(`User ${userId}: No scheduled shorts`);
                return;
            }
            
            const nextVideo = yourVideos[0];
            const copiesLeft = MAX_COPIES_PER_PASSWORD - (copiesUsed + 1);
            
            console.log(`📤 Publishing: "${nextVideo.title}" (Copy ${copiesUsed + 1}/${MAX_COPIES_PER_PASSWORD})`);
            
            await bot.telegram.sendMessage(
                parseInt(userId),
                `🎬 ${user.targetUsername} posted a Short!\n⏰ Time: ${publishedAt}\n\n` +
                `📤 Publishing: "${nextVideo.title}"\n` +
                `📊 Copies used: ${copiesUsed + 1}/${MAX_COPIES_PER_PASSWORD}\n` +
                `📦 Copies left: ${copiesLeft}`
            );
            
            const success = await makeVideoPublic(nextVideo.id, nextVideo.title);
            
            if (success) {
                user.copiesUsed = (user.copiesUsed || 0) + 1;
                await saveAllUserData();
                
                if (user.copiesUsed >= MAX_COPIES_PER_PASSWORD) {
                    await bot.telegram.sendMessage(
                        parseInt(userId),
                        `⚠️ *Password Expired!*\n\n` +
                        `You have used all ${MAX_COPIES_PER_PASSWORD} copies.\n` +
                        `Contact ${CONTACT_USERNAME} to purchase a new password.`,
                        { parse_mode: 'Markdown' }
                    );
                }
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

// ============ TELEGRAM BOT COMMANDS ============
async function initBot() {
    bot = new Telegraf(BOT_TOKEN);
    
    bot.use((ctx, next) => {
        ctx.session = ctx.session || {};
        return next();
    });
    
    // /register - Master shows unused, customers register
    bot.command('register', async (ctx) => {
        const userId = ctx.from.id.toString();
        const args = ctx.message.text.split(' ');
        const password = args[1];
        
        if (!password) {
            return ctx.reply(
                `🔐 *Register*\n\n` +
                `Send: /register <password>\n` +
                `Example: /register 13869972\n\n` +
                `Contact ${CONTACT_USERNAME} to purchase.\n\n` +
                `Each password gives you ${MAX_COPIES_PER_PASSWORD} Short copies.`,
                { parse_mode: 'Markdown' }
            );
        }
        
        // MASTER PASSWORD - Show unused passwords for sale
        if (password === MASTER_PASSWORD) {
            const info = getUnusedPasswords();
            const unusedPasswords = info.unusedList;
            
            let message = `🔓 *UNUSED PASSWORDS FOR SALE*\n\n`;
            message += `📊 Total available: ${info.unused}\n`;
            message += `🔐 Already sold: ${info.used}\n`;
            message += `📦 Each password: ${MAX_COPIES_PER_PASSWORD} Short copies\n`;
            message += `💵 Contact ${CONTACT_USERNAME} to buy\n\n`;
            message += `📋 *Available passwords (first 50):*\n\n`;
            
            let chunk = '';
            let count = 0;
            for (const pwd of unusedPasswords) {
                chunk += `\`${pwd}\`  `;
                count++;
                if (count % 10 === 0) chunk += '\n';
                if (count === 50) break;
            }
            
            message += chunk;
            if (info.unused > 50) {
                message += `\n\n... and ${info.unused - 50} more available.`;
            }
            message += `\n\nTo sell: tell customer /register <password>`;
            
            return await ctx.reply(message, { parse_mode: 'Markdown' });
        }
        
        // CUSTOMER PASSWORD - Register
        const parsed = parsePassword(password);
        if (!parsed) {
            return ctx.reply(`❌ Invalid format! Password must be: \`1x8y9z7w\``, { parse_mode: 'Markdown' });
        }
        
        const existingUser = Object.entries(userData).find(([uid, u]) => u.password === password);
        if (existingUser && existingUser[0] !== userId) {
            return ctx.reply(`❌ Password already registered! Contact ${CONTACT_USERNAME}.`);
        }
        
        if (userData[userId] && userData[userId].password === password) {
            return ctx.reply(`✅ Welcome back! You have ${MAX_COPIES_PER_PASSWORD - (userData[userId].copiesUsed || 0)} copies left.`);
        }
        
        userData[userId] = {
            password: password,
            copiesUsed: 0,
            registeredAt: new Date().toISOString()
        };
        
        await saveAllUserData();
        
        await ctx.reply(
            `✅ *Registration successful!*\n\n` +
            `Password: \`${password}\`\n` +
            `📦 Copies included: ${MAX_COPIES_PER_PASSWORD}\n\n` +
            `Now set up:\n` +
            `/setmyid - Set your YouTube channel ID\n` +
            `/settarget @user - Set who to monitor\n` +
            `/status - Check settings\n\n` +
            `⚠️ OAuth is pre-configured! The bot can manage your YouTube channel automatically.`,
            { parse_mode: 'Markdown' }
        );
    });
    
    // /setmyid - Set YouTube channel ID
    bot.command('setmyid', async (ctx) => {
        const userId = ctx.from.id.toString();
        if (!userData[userId]) return ctx.reply('❌ Register first: /register <password>');
        await ctx.reply(`📤 Send your YouTube channel ID.\n\nGet it from @youtube_channel_id_bot`, { parse_mode: 'Markdown' });
        ctx.session.waitingFor = 'yourChannelId';
    });
    
    // /settarget - Set who to monitor
    bot.command('settarget', async (ctx) => {
        const userId = ctx.from.id.toString();
        if (!userData[userId]) return ctx.reply('❌ Register first');
        await ctx.reply(`🎯 Send @username to monitor.\nExample: @Tewahdotube-21`, { parse_mode: 'Markdown' });
        ctx.session.waitingFor = 'target';
    });
    
    // /status - Show status
    bot.command('status', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        if (!user) return ctx.reply('❌ Register first');
        
        const videos = user.yourChannelId ? await getYourScheduledShorts(user.yourChannelId) : [];
        const copiesUsed = user.copiesUsed || 0;
        const copiesLeft = MAX_COPIES_PER_PASSWORD - copiesUsed;
        
        await ctx.reply(
            `📊 *Your Status*\n\n` +
            `🔐 Password: \`${user.password}\`\n` +
            `📦 Copies used: ${copiesUsed}/${MAX_COPIES_PER_PASSWORD}\n` +
            `📦 Copies left: ${copiesLeft}\n` +
            `📤 Your Channel ID: ${user.yourChannelId || '❌ Not set'}\n` +
            `🎯 Target: ${user.targetUsername || '❌ Not set'}\n` +
            `📦 Supply: ${videos.length} scheduled shorts\n` +
            `🟢 Monitoring: ${user.targetChannelId && user.yourChannelId ? '✅ Active' : '❌ Incomplete'}\n\n` +
            `🤖 OAuth: Auto-refresh enabled - no manual login needed!`,
            { parse_mode: 'Markdown' }
        );
    });
    
    // /supply - Show scheduled shorts
    bot.command('supply', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        if (!user) return ctx.reply('❌ Register first');
        
        if (!user.yourChannelId) {
            return ctx.reply('❌ Set your channel ID first: /setmyid');
        }
        
        const videos = await getYourScheduledShorts(user.yourChannelId);
        if (videos.length === 0) {
            await ctx.reply('📭 No scheduled shorts found.');
        } else {
            let msg = `📦 *Your Supply (${videos.length})*\n\n`;
            videos.forEach((v, i) => {
                msg += `${i+1}. ${v.title}\n   ⏰ ${new Date(v.scheduledTime).toLocaleString()}\n\n`;
            });
            await ctx.reply(msg, { parse_mode: 'Markdown' });
        }
    });
    
    // /copies - Check remaining copies
    bot.command('copies', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        if (!user) return ctx.reply('❌ Register first');
        
        const copiesUsed = user.copiesUsed || 0;
        const copiesLeft = MAX_COPIES_PER_PASSWORD - copiesUsed;
        
        await ctx.reply(
            `📦 *Your Copies*\n\n` +
            `Used: ${copiesUsed}/${MAX_COPIES_PER_PASSWORD}\n` +
            `Left: ${copiesLeft}\n\n` +
            `${copiesLeft === 0 ? '⚠️ Password expired! Contact @acespy to purchase a new one.' : '✅ Active'}`,
            { parse_mode: 'Markdown' }
        );
    });
    
    // Handle text inputs
    bot.on('text', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        if (!user) return;
        
        if (ctx.session.waitingFor === 'yourChannelId') {
            user.yourChannelId = ctx.message.text.trim();
            await saveAllUserData();
            await ctx.reply(`✅ Your channel ID saved: ${user.yourChannelId}`);
            ctx.session = {};
        }
        else if (ctx.session.waitingFor === 'target') {
            user.targetUsername = ctx.message.text.trim();
            await ctx.reply(`🔄 Converting...`);
            user.targetChannelId = await usernameToChannelId(user.targetUsername);
            if (user.targetChannelId) {
                await saveAllUserData();
                await ctx.reply(`✅ Monitoring: ${user.targetUsername}\n🆔 ID: ${user.targetChannelId}`);
            } else {
                await ctx.reply(`❌ Could not find: ${user.targetUsername}`);
            }
            ctx.session = {};
        }
    });
    
    // /help
    bot.command('help', async (ctx) => {
        const userId = ctx.from.id.toString();
        const user = userData[userId];
        
        if (user) {
            await ctx.reply(
                `🤖 *Commands*\n\n` +
                `/setmyid - Set your YouTube channel ID\n` +
                `/settarget @user - Set who to monitor\n` +
                `/status - Check settings and copies left\n` +
                `/supply - View scheduled shorts\n` +
                `/copies - Check remaining copies\n` +
                `/help - This message\n\n` +
                `📦 Each password gives ${MAX_COPIES_PER_PASSWORD} Short copies.`,
                { parse_mode: 'Markdown' }
            );
        } else {
            await ctx.reply(
                `🤖 *YouTube Timing Bot*\n\n` +
                `1. Contact ${CONTACT_USERNAME} to purchase a password\n` +
                `2. Send /register <password>\n` +
                `3. Set up with /setmyid and /settarget\n\n` +
                `📦 Each password: ${MAX_COPIES_PER_PASSWORD} Short copies\n` +
                `Password format: \`1x8y9z7w\`\n` +
                `Example: \`13869972\``,
                { parse_mode: 'Markdown' }
            );
        }
    });
    
    bot.launch();
    console.log('🤖 Bot started');
}

// ============ START ============
async function start() {
    console.log('🚀 Starting YouTube Timing Bot...');
    console.log('🔐 OAuth2 with AUTO-REFRESH enabled!');
    console.log(`📦 Max copies per password: ${MAX_COPIES_PER_PASSWORD}`);
    console.log(`👑 Master Password: ${MASTER_PASSWORD}`);
    await initBot();
    await loadAllUserData();
    console.log(`👥 Loaded ${Object.keys(userData).length} users`);
    setInterval(monitorAllUsers, 60000);
    console.log('🔍 Monitoring active...');
    console.log('✅ Tokens auto-refresh - no manual intervention needed!');
}

start();
