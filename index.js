const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');
const { pipeline } = require('@xenova/transformers');

// ============ CREDENTIALS ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = '39782137338-leo8rmrpic812o2klvsrmgk84o10d4j4.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'https://final-boss-jnl3.onrender.com/oauth2callback';

// ============ API KEYS ============
const API_KEYS = [
    'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg',
    'AIzaSyAXzQXd0AONNgSI8E6D5_BeweMqyz4iGTg',
    'AIzaSyDjLVpU8M9VFBAuj-_pvSyDW1BbUfCjyIY'
];

// ============ CHANNEL REQUIREMENTS ============
const REQUIRED_TELEGRAM_CHANNEL = '@bot_Farming';
const REQUIRED_YOUTUBE_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const REQUIRED_YOUTUBE_CHANNEL_NAME = '@Noah_Technical';
const MAX_UPLOADS = 10;
const INVITE_BONUS = 1;
const INVITES_TO_ADD_ACCOUNT = 5;
const DEVELOPER_CONTACT = '@Ace_spy';
const MAX_FILE_SIZE_MB = 300;

// ============ EXPRESS SETUP ============
const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors());
app.use(session({
    secret: 'youtube_upload_secret_2024',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ OAuth Setup ============
const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
);

// Store user sessions
const userSessions = new Map();
const inviteTracker = new Map();
let isUploading = false;
let currentUploader = null;

// ============ TEMP DIR ============
const TEMP_DIR = '/tmp/youtube_uploads';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ============ DISTILGPT2 AI SETUP ============
let textGenerator = null;
let aiReady = false;

async function loadAI() {
    try {
        console.log('🧠 Loading DistilGPT2 (82MB)...');
        console.log('⏳ This takes 1-2 minutes...');
        textGenerator = await pipeline('text-generation', 'distilgpt2');
        aiReady = true;
        console.log('✅ DistilGPT2 loaded!');
        return true;
    } catch(error) {
        console.error('❌ AI Load error:', error.message);
        aiReady = false;
        return false;
    }
}

// ============ AI FUNCTIONS ============

async function chatWithAI(userMessage) {
    if (!textGenerator) return null;
    try {
        const prompt = `You are a helpful YouTube assistant. Answer the user's question.\n\nUser: ${userMessage}\nAssistant:`;
        const result = await textGenerator(prompt, { 
            max_length: 300, 
            temperature: 0.8,
            pad_token_id: 50256
        });
        return result[0]?.generated_text?.replace(prompt, '').trim() || null;
    } catch(error) {
        console.error('Chat error:', error.message);
        return null;
    }
}

async function summarizeContent(text) {
    if (!textGenerator) return null;
    try {
        const prompt = `Summarize this content in 3-4 sentences:\n\n${text}\n\nSummary:`;
        const result = await textGenerator(prompt, { 
            max_length: 150, 
            temperature: 0.5,
            pad_token_id: 50256
        });
        return result[0]?.generated_text?.replace(prompt, '').trim() || null;
    } catch(error) {
        console.error('Summary error:', error.message);
        return null;
    }
}

async function getAIAdvice(topic) {
    if (!textGenerator) return null;
    try {
        const prompt = `Give helpful advice about "${topic}" for YouTube creators.\n\nAdvice:`;
        const result = await textGenerator(prompt, { 
            max_length: 200, 
            temperature: 0.7,
            pad_token_id: 50256
        });
        return result[0]?.generated_text?.replace(prompt, '').trim() || null;
    } catch(error) {
        console.error('Advice error:', error.message);
        return null;
    }
}

async function generateTitles(topic, keywords = []) {
    if (!textGenerator) return null;
    try {
        const prompt = `Generate 3 YouTube video titles about "${topic}" with keywords: ${keywords.join(', ')}.\n1.`;
        const result = await textGenerator(prompt, { 
            max_length: 150, 
            temperature: 0.9,
            pad_token_id: 50256
        });
        const generated = result[0]?.generated_text || '';
        const titles = generated.split('\n')
            .filter(line => line.match(/^\d+\./))
            .map(line => line.replace(/^\d+\.\s*/, '').trim())
            .filter(t => t.length > 5 && t.length < 100);
        return titles.length > 0 ? titles : null;
    } catch(error) {
        console.error('Title error:', error.message);
        return null;
    }
}

async function generateDescription(topic, keywords = [], title = '') {
    if (!textGenerator) return null;
    try {
        const prompt = `Write a YouTube video description for "${title}" about "${topic}". Keywords: ${keywords.join(', ')}.\nDescription:`;
        const result = await textGenerator(prompt, { 
            max_length: 200, 
            temperature: 0.8,
            pad_token_id: 50256
        });
        return result[0]?.generated_text?.replace(prompt, '').trim() || null;
    } catch(error) {
        console.error('Description error:', error.message);
        return null;
    }
}

async function generateTags(topic, keywords = []) {
    if (!textGenerator) return null;
    try {
        const prompt = `Generate 10 hashtags for YouTube video about "${topic}". Keywords: ${keywords.join(', ')}.\nHashtags:`;
        const result = await textGenerator(prompt, { 
            max_length: 100, 
            temperature: 0.7,
            pad_token_id: 50256
        });
        const generated = result[0]?.generated_text?.replace(prompt, '').trim() || '';
        const tags = generated.split(/\s+/)
            .filter(t => t.startsWith('#'))
            .slice(0, 10);
        return tags.length > 0 ? tags : null;
    } catch(error) {
        console.error('Tags error:', error.message);
        return null;
    }
}

// ============ EXPRESS ROUTES ============

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>YouTube Upload Bot</title></head>
            <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1>🎬 YouTube Upload Bot</h1>
                <p>Bot running! Users: ${userSessions.size}</p>
                <p>AI: ${aiReady ? '✅ Ready' : '⏳ Loading...'}</p>
                <p>Max file: ${MAX_FILE_SIZE_MB}MB</p>
                <p><a href="/auth">Login with YouTube</a></p>
                <p>Contact: ${DEVELOPER_CONTACT}</p>
            </body>
        </html>
    `);
});

app.get('/health', (req, res) => {
    const tempFiles = fs.readdirSync(TEMP_DIR);
    let totalSize = 0;
    for (const file of tempFiles) {
        const filePath = path.join(TEMP_DIR, file);
        const stats = fs.statSync(filePath);
        totalSize += stats.size;
    }
    const freeMemory = Math.max(0, 350 - (totalSize / 1024 / 1024));
    res.json({
        status: 'ok',
        ai: aiReady ? 'ready' : 'loading',
        sessions: userSessions.size,
        tempFiles: tempFiles.length,
        tempSizeMB: (totalSize / 1024 / 1024).toFixed(2),
        freeSpaceMB: freeMemory.toFixed(2),
        maxFileSizeMB: MAX_FILE_SIZE_MB,
        isUploading: isUploading
    });
});

app.get('/auth', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/youtube.upload',
            'https://www.googleapis.com/auth/youtube',
            'https://www.googleapis.com/auth/youtube.readonly'
        ],
        prompt: 'consent'
    });
    res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.send('❌ No code received');
    
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        const channelRes = await youtube.channels.list({
            part: 'snippet',
            mine: true
        });
        
        if (!channelRes.data.items || channelRes.data.items.length === 0) {
            return res.send('❌ No YouTube channel found');
        }
        
        const channelId = channelRes.data.items[0].id;
        const channelName = channelRes.data.items[0].snippet.title;
        
        const userId = req.session.userId;
        if (userId && userSessions.has(userId)) {
            const session = userSessions.get(userId);
            session.mainAccount = {
                channelId: channelId,
                channelName: channelName,
                oauthClient: oauth2Client,
                youtube: youtube,
                tokens: tokens,
                authenticated: true
            };
            userSessions.set(userId, session);
        }
        
        res.send(`
            <html>
                <head><title>Login Successful</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1>✅ Login Successful!</h1>
                    <p>Channel: <strong>${channelName}</strong></p>
                    <p>Max file: ${MAX_FILE_SIZE_MB}MB</p>
                    <p>You can now close this window.</p>
                    <p>Contact: ${DEVELOPER_CONTACT}</p>
                </body>
            </html>
        `);
    } catch(error) {
        res.send(`❌ Login failed: ${error.message}`);
    }
});

// ============ TELEGRAM BOT ============
const bot = new Telegraf(BOT_TOKEN);

// ============ API KEY MANAGEMENT ============
let currentKey = 0;
let keyUsage = [0, 0, 0];
let keyReset = [Date.now(), Date.now(), Date.now()];

function getApiKey() {
    const now = Date.now();
    const ONE_DAY = 86400000;
    for(let i = 0; i < API_KEYS.length; i++) {
        if(now - keyReset[i] > ONE_DAY) { 
            keyUsage[i] = 0; 
            keyReset[i] = now; 
        }
        if(keyUsage[i] < 9000) {
            currentKey = i;
            keyUsage[i]++;
            return API_KEYS[i];
        }
    }
    return null;
}

function getYoutube() { 
    const key = getApiKey();
    if (!key) return null;
    return google.youtube({ version: 'v3', auth: key });
}

// ============ CLEANUP FUNCTIONS ============

function clearAllTempFiles() {
    const files = fs.readdirSync(TEMP_DIR);
    let deleted = 0;
    let freedSpace = 0;
    for (const file of files) {
        const filePath = path.join(TEMP_DIR, file);
        try {
            const stats = fs.statSync(filePath);
            freedSpace += stats.size;
            fs.unlinkSync(filePath);
            deleted++;
        } catch(e) {}
    }
    if (deleted > 0) {
        console.log(`🗑️ Cleared ${deleted} temp files (${(freedSpace / 1024 / 1024).toFixed(2)}MB freed)`);
    }
}

function clearUserTempFiles(userId) {
    const files = fs.readdirSync(TEMP_DIR);
    let deleted = 0;
    for (const file of files) {
        if (file.startsWith(userId)) {
            const filePath = path.join(TEMP_DIR, file);
            try {
                fs.unlinkSync(filePath);
                deleted++;
            } catch(e) {}
        }
    }
    return deleted;
}

// ============ VERIFY FUNCTIONS ============

async function checkYouTubeSubscriptionWithApi(channelId) {
    try {
        const youtube = getYoutube();
        if (!youtube) return false;
        const response = await youtube.subscriptions.list({
            part: 'snippet',
            channelId: channelId,
            forChannelId: REQUIRED_YOUTUBE_CHANNEL_ID
        });
        return response.data.items && response.data.items.length > 0;
    } catch(error) {
        return false;
    }
}

async function checkTelegramMembership(userId) {
    try {
        const chatMember = await bot.telegram.getChatMember(REQUIRED_TELEGRAM_CHANNEL, userId);
        return chatMember.status === 'member' || 
               chatMember.status === 'administrator' || 
               chatMember.status === 'creator';
    } catch(e) {
        return false;
    }
}

function trackInvite(inviterId, inviteeId) {
    if (!inviteTracker.has(inviterId)) {
        inviteTracker.set(inviterId, { invitedBy: null, invitedUsers: [] });
    }
    const inviterData = inviteTracker.get(inviterId);
    if (!inviterData.invitedUsers.includes(inviteeId)) {
        inviterData.invitedUsers.push(inviteeId);
        inviteTracker.set(inviterId, inviterData);
        return true;
    }
    return false;
}

function getRemainingUploads(session) {
    const totalAllowed = session.totalUploadsAllowed || MAX_UPLOADS;
    const used = session.uploadCount || 0;
    return Math.max(0, totalAllowed - used);
}

function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

async function getChannelId(youtube) {
    try {
        const res = await youtube.channels.list({ part: 'id', mine: true });
        return res.data.items[0]?.id || null;
    } catch(e) { return null; }
}

function parseDuration(duration) {
    const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
    const hours = (match[1] || '').replace('H', '') || 0;
    const minutes = (match[2] || '').replace('M', '') || 0;
    const seconds = (match[3] || '').replace('S', '') || 0;
    return `${hours}h ${minutes}m ${seconds}s`;
}
// ============ MAIN MENU ============
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('💬 Chat with AI', 'chat_ai')],
    [Markup.button.callback('📝 Summarize', 'summarize')],
    [Markup.button.callback('💡 Get Advice', 'advice')],
    [Markup.button.callback('🤖 AI Tools', 'ai_menu')],
    [Markup.button.callback('📤 Upload Video', 'upload')],
    [Markup.button.callback('🔍 Analyze Video', 'analyze_video')],
    [Markup.button.callback('📊 Analyze Channel', 'analyze_channel')],
    [Markup.button.callback('📊 Status', 'status')],
    [Markup.button.callback('👥 Invite', 'invite')],
    [Markup.button.callback('✅ Verify', 'verify_subscription')],
    [Markup.button.callback('🆘 Contact', 'contact_developer')],
    [Markup.button.callback('🚪 Logout', 'logout')]
]);

const aiMenu = Markup.inlineKeyboard([
    [Markup.button.callback('🎯 AI Titles', 'ai_title')],
    [Markup.button.callback('📝 AI Description', 'ai_desc')],
    [Markup.button.callback('🏷️ AI Tags', 'ai_tags')],
    [Markup.button.callback('🔙 Back', 'back_to_menu')]
]);

// ============ START COMMAND ============
bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            mainAccount: null,
            subscriptionVerified: false,
            uploadCount: 0,
            totalUploadsAllowed: MAX_UPLOADS,
            linkedAccounts: [],
            telegramVerified: false,
            aiMode: null,
            analysisMode: null,
            chatMode: null
        });
    }
    
    const session = userSessions.get(userId);
    const isTelegramMember = await checkTelegramMembership(ctx.from.id);
    
    if (!isTelegramMember) {
        return ctx.reply(
            `❌ *Join ${REQUIRED_TELEGRAM_CHANNEL} first!*`,
            Markup.inlineKeyboard([
                [Markup.button.url('📢 Join', `https://t.me/${REQUIRED_TELEGRAM_CHANNEL.replace('@', '')}`)],
                [Markup.button.callback('✅ Verify', 'verify_telegram')]
            ]),
            { parse_mode: 'Markdown' }
        );
    }
    
    session.telegramVerified = true;
    userSessions.set(userId, session);
    
    if (!session.mainAccount || !session.mainAccount.authenticated) {
        return ctx.reply(
            `✅ Verified!\n\nLogin with YouTube:`,
            Markup.inlineKeyboard([
                [Markup.button.url('🔑 Login', `${REDIRECT_URI.replace('/oauth2callback', '/auth')}`)]
            ])
        );
    }
    
    await showMainMenu(ctx, userId);
});

async function showMainMenu(ctx, userId) {
    const session = userSessions.get(userId);
    const remaining = getRemainingUploads(session);
    const inviteCount = inviteTracker.has(userId) ? inviteTracker.get(userId).invitedUsers.length : 0;
    
    let msg = `👋 *${session.mainAccount?.channelName || 'User'}*\n\n`;
    msg += `📤 Uploads: ${session.uploadCount || 0}/${session.totalUploadsAllowed}\n`;
    msg += `📊 Remaining: ${remaining}\n`;
    msg += `👥 Invites: ${inviteCount}\n`;
    msg += `📦 Max file: ${MAX_FILE_SIZE_MB}MB\n`;
    msg += `🤖 AI: ${aiReady ? '✅' : '⏳'}\n\n`;
    msg += `💬 *Chat, Summarize, Get Advice!*`;
    
    try {
        await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...mainMenu });
    } catch(e) {
        await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
    }
}

// ============ CHAT WITH AI ============
bot.action('chat_ai', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
    
    session.chatMode = 'chat';
    userSessions.set(userId, session);
    
    await ctx.editMessageText(
        `💬 *Chat with AI*\n\nAsk anything!\nExamples:\n• "How to grow my channel?"\n• "Best time to post?"\n• "How to get views?"\n\nType /cancel to exit.`,
        { parse_mode: 'Markdown' }
    );
});

// ============ SUMMARIZE ============
bot.action('summarize', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
    
    session.chatMode = 'summarize';
    userSessions.set(userId, session);
    
    await ctx.editMessageText(
        `📝 *Summarize Content*\n\nSend me any text to summarize.\n\nType /cancel to exit.`,
        { parse_mode: 'Markdown' }
    );
});

// ============ GET ADVICE ============
bot.action('advice', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
    
    session.chatMode = 'advice';
    userSessions.set(userId, session);
    
    await ctx.editMessageText(
        `💡 *Get Advice*\n\nWhat do you need advice on?\nExamples:\n• "YouTube growth"\n• "Content ideas"\n• "Engagement tips"\n\nType /cancel to exit.`,
        { parse_mode: 'Markdown' }
    );
});

// ============ AI TOOLS ============
bot.action('ai_menu', async (ctx) => {
    await ctx.editMessageText(
        `🤖 *AI Tools*\n\n🎯 Titles | 📝 Descriptions | 🏷️ Tags`,
        { parse_mode: 'Markdown', ...aiMenu }
    );
});

bot.action('ai_title', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    session.aiMode = 'title';
    userSessions.set(userId, session);
    await ctx.editMessageText(`🎯 Send me a topic.\n\nExample: "Gaming montage"\n\nType /cancel to exit.`);
});

bot.action('ai_desc', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    session.aiMode = 'description';
    userSessions.set(userId, session);
    await ctx.editMessageText(`📝 Send: Title | Topic | Keywords\n\nExample: "Gaming Montage | Call of Duty | Skills"\n\nType /cancel to exit.`);
});

bot.action('ai_tags', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    session.aiMode = 'tags';
    userSessions.set(userId, session);
    await ctx.editMessageText(`🏷️ Send me a topic.\n\nExample: "Fifa football skills"\n\nType /cancel to exit.`);
});

// ============ CONTACT DEVELOPER ============
bot.action('contact_developer', async (ctx) => {
    await ctx.editMessageText(
        `🆘 *Contact Developer*\n\n👨‍💻 ${DEVELOPER_CONTACT}\n📱 Telegram: ${DEVELOPER_CONTACT}`,
        Markup.inlineKeyboard([
            [Markup.button.url('📩 Contact', `https://t.me/${DEVELOPER_CONTACT.replace('@', '')}`)],
            [Markup.button.callback('🔙 Back', 'back_to_menu')]
        ]),
        { parse_mode: 'Markdown' }
    );
});

// ============ VERIFY TELEGRAM ============
bot.action('verify_telegram', async (ctx) => {
    const isMember = await checkTelegramMembership(ctx.from.id);
    if (isMember) {
        const userId = ctx.from.id.toString();
        const session = userSessions.get(userId);
        if (session) session.telegramVerified = true;
        await ctx.editMessageText(`✅ Verified! Login with YouTube.`, Markup.inlineKeyboard([
            [Markup.button.url('🔑 Login', `${REDIRECT_URI.replace('/oauth2callback', '/auth')}`)]
        ]));
        await ctx.answerCbQuery('Verified!');
    } else {
        await ctx.answerCbQuery('❌ Not a member!', { show_alert: true });
    }
});

// ============ VERIFY SUBSCRIPTION ============
bot.action('verify_subscription', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
    
    const isSubscribed = await checkYouTubeSubscriptionWithApi(session.mainAccount.channelId);
    if (isSubscribed) {
        session.subscriptionVerified = true;
        userSessions.set(userId, session);
        await ctx.editMessageText(`✅ Subscribed!`, mainMenu);
    } else {
        await ctx.editMessageText(
            `❌ Subscribe to ${REQUIRED_YOUTUBE_CHANNEL_NAME}`,
            Markup.inlineKeyboard([
                [Markup.button.url('📺 Subscribe', `https://www.youtube.com/${REQUIRED_YOUTUBE_CHANNEL_NAME}`)],
                [Markup.button.callback('✅ Verify', 'verify_subscription')],
                [Markup.button.callback('🔙 Back', 'back_to_menu')]
            ])
        );
    }
});

// ============ INVITE ============
bot.action('invite', async (ctx) => {
    const userId = ctx.from.id.toString();
    const botUsername = ctx.botInfo.username;
    const inviteLink = `https://t.me/${botUsername}?start=ref_${userId}`;
    const inviteCount = inviteTracker.has(userId) ? inviteTracker.get(userId).invitedUsers.length : 0;
    
    await ctx.editMessageText(
        `👥 *Invite Friends*\n\n+${INVITE_BONUS} upload per invite!\n${INVITES_TO_ADD_ACCOUNT} invites = extra account\n\n📊 ${inviteCount}\n\n🔗 ${inviteLink}`,
        Markup.inlineKeyboard([
            [Markup.button.url('📤 Share', `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=Join this bot!`)],
            [Markup.button.callback('🔙 Back', 'back_to_menu')]
        ]),
        { parse_mode: 'Markdown' }
    );
});

// ============ BACK TO MENU ============
bot.action('back_to_menu', async (ctx) => {
    const userId = ctx.from.id.toString();
    await showMainMenu(ctx, userId);
});

// ============ STATUS ============
bot.action('status', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount) return ctx.reply('❌ Not logged in');
    
    try {
        const channelRes = await session.mainAccount.youtube.channels.list({
            part: 'statistics',
            mine: true
        });
        
        const stats = channelRes.data.items[0]?.statistics || {};
        const remaining = getRemainingUploads(session);
        const inviteCount = inviteTracker.has(userId) ? inviteTracker.get(userId).invitedUsers.length : 0;
        
        let msg = `📊 *Status*\n\n📺 ${session.mainAccount.channelName}\n👥 ${formatNumber(parseInt(stats.subscriberCount || 0))}\n🎬 ${formatNumber(parseInt(stats.videoCount || 0))}\n👁️ ${formatNumber(parseInt(stats.viewCount || 0))}\n\n📤 ${session.uploadCount || 0}/${session.totalUploadsAllowed}\n📊 Remaining: ${remaining}\n👥 Invites: ${inviteCount}\n✅ ${session.subscriptionVerified ? 'Subscribed' : 'Not subscribed'}\n📦 Max: ${MAX_FILE_SIZE_MB}MB`;
        
        await ctx.editMessageText(msg, { parse_mode: 'Markdown' });
        await ctx.answerCbQuery();
    } catch(error) {
        await ctx.reply(`❌ Error: ${error.message}`);
    }
});

// ============ LOGOUT ============
bot.action('logout', async (ctx) => {
    const userId = ctx.from.id.toString();
    clearUserTempFiles(userId);
    userSessions.delete(userId);
    await ctx.editMessageText(`🚪 Logged out! Send /start to login.`);
    await ctx.answerCbQuery('Logged out');
});

// ============ UPLOAD HANDLER ============
bot.action('upload', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
    if (isUploading) return ctx.editMessageText(`⏳ Another upload in progress.`);
    if (!session.subscriptionVerified) {
        return ctx.editMessageText(`❌ Subscribe first!`, Markup.inlineKeyboard([
            [Markup.button.callback('✅ Verify', 'verify_subscription')]
        ]));
    }
    
    const remaining = getRemainingUploads(session);
    if (remaining <= 0) {
        return ctx.editMessageText(`❌ No uploads remaining!`, Markup.inlineKeyboard([
            [Markup.button.callback('👥 Invite', 'invite')]
        ]));
    }
    
    await ctx.editMessageText(
        `📤 Send a video.\n📊 Remaining: ${remaining}\n📦 Max: ${MAX_FILE_SIZE_MB}MB\n\nAdd title in caption.`
    );
});

// ============ ANALYZE VIDEO ============
bot.action('analyze_video', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    session.analysisMode = 'video';
    userSessions.set(userId, session);
    await ctx.editMessageText(`🔍 Send me a YouTube video link or ID.\n\nType /cancel to exit.`);
});

// ============ ANALYZE CHANNEL ============
bot.action('analyze_channel', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    session.analysisMode = 'channel';
    userSessions.set(userId, session);
    await ctx.editMessageText(`📊 Send me a YouTube channel link or ID.\n\nType /cancel to exit.`);
});
// ============ HANDLE TEXT MESSAGES ============
bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    const text = ctx.message.text;
    
    if (text === '/cancel') {
        if (session) {
            session.aiMode = null;
            session.analysisMode = null;
            session.chatMode = null;
            userSessions.set(userId, session);
        }
        return ctx.reply('✅ Cancelled.', mainMenu);
    }
    
    if (session && session.chatMode === 'chat') {
        await handleChat(ctx, text);
    } else if (session && session.chatMode === 'summarize') {
        await handleSummarize(ctx, text);
    } else if (session && session.chatMode === 'advice') {
        await handleAdvice(ctx, text);
    } else if (session && session.aiMode === 'title') {
        await handleAITitle(ctx, text);
    } else if (session && session.aiMode === 'description') {
        await handleAIDescription(ctx, text);
    } else if (session && session.aiMode === 'tags') {
        await handleAITags(ctx, text);
    } else if (session && session.analysisMode === 'video') {
        await handleVideoAnalysis(ctx, text);
    } else if (session && session.analysisMode === 'channel') {
        await handleChannelAnalysis(ctx, text);
    }
});

// ============ CHAT HANDLER ============
async function handleChat(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    if (!aiReady) return ctx.reply('⏳ AI is loading. Try again in a minute.');
    
    const msg = await ctx.reply(`💬 Thinking...⏳`);
    const response = await chatWithAI(text);
    
    if (response) {
        session.chatMode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `💬 *Response*\n\n${response}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    } else {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ AI unavailable. Try again.`, mainMenu
        );
    }
}

// ============ SUMMARIZE HANDLER ============
async function handleSummarize(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    if (!aiReady) return ctx.reply('⏳ AI is loading. Try again in a minute.');
    
    const msg = await ctx.reply(`📝 Summarizing...⏳`);
    const summary = await summarizeContent(text);
    
    if (summary) {
        session.chatMode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `📝 *Summary*\n\n${summary}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    } else {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ Summarization failed.`, mainMenu
        );
    }
}

// ============ ADVICE HANDLER ============
async function handleAdvice(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    if (!aiReady) return ctx.reply('⏳ AI is loading. Try again in a minute.');
    
    const msg = await ctx.reply(`💡 Generating advice...⏳`);
    const advice = await getAIAdvice(text);
    
    if (advice) {
        session.chatMode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `💡 *Advice*\n\n${advice}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    } else {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ Advice generation failed.`, mainMenu
        );
    }
}

// ============ AI TITLE HANDLER ============
async function handleAITitle(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    if (!aiReady) return ctx.reply('⏳ AI is loading. Try again in a minute.');
    
    const msg = await ctx.reply(`🎯 Generating titles...⏳`);
    const titles = await generateTitles(text);
    
    if (titles) {
        session.aiMode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `🎯 *Titles*\n\n${titles}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    } else {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ Title generation failed.`, mainMenu
        );
    }
}

// ============ AI DESCRIPTION HANDLER ============
async function handleAIDescription(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    if (!aiReady) return ctx.reply('⏳ AI is loading. Try again in a minute.');
    
    const parts = text.split('|');
    const title = parts[0]?.trim() || text;
    const topic = parts[1]?.trim() || title;
    const keywords = parts[2]?.trim()?.split(',').map(k => k.trim()) || [];
    
    const msg = await ctx.reply(`📝 Generating description...⏳`);
    const description = await generateDescription(topic, keywords, title);
    
    if (description) {
        session.aiMode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `📝 *Description*\n\n${description}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    } else {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ Description generation failed.`, mainMenu
        );
    }
}

// ============ AI TAGS HANDLER ============
async function handleAITags(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    if (!aiReady) return ctx.reply('⏳ AI is loading. Try again in a minute.');
    
    const msg = await ctx.reply(`🏷️ Generating tags...⏳`);
    const tags = await generateTags(text);
    
    if (tags) {
        session.aiMode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `🏷️ *Tags*\n\n${tags.join(' ')}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    } else {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ Tag generation failed.`, mainMenu
        );
    }
}

// ============ VIDEO ANALYSIS HANDLER ============
async function handleVideoAnalysis(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    let videoId = text;
    const urlMatch = text.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (urlMatch) videoId = urlMatch[1];
    
    const youtube = getYoutube();
    if (!youtube) return ctx.reply(`❌ API keys exhausted.`);
    
    const msg = await ctx.reply(`🔍 Analyzing...⏳`);
    
    try {
        const videoRes = await youtube.videos.list({
            part: 'snippet,statistics,contentDetails',
            id: videoId
        });
        
        if (!videoRes.data.items || videoRes.data.items.length === 0) {
            return ctx.reply('❌ Video not found.');
        }
        
        const video = videoRes.data.items[0];
        const stats = video.statistics || {};
        
        let msgText = `🔍 *Video Analysis*\n\n📹 ${video.snippet.title}\n📺 ${video.snippet.channelTitle}\n📅 ${new Date(video.snippet.publishedAt).toLocaleString()}\n⏱️ ${parseDuration(video.contentDetails.duration)}\n👁️ ${formatNumber(parseInt(stats.viewCount || 0))}\n👍 ${formatNumber(parseInt(stats.likeCount || 0))}\n💬 ${formatNumber(parseInt(stats.commentCount || 0))}\n\n🔗 https://www.youtube.com/watch?v=${videoId}`;
        
        session.analysisMode = null;
        userSessions.set(userId, session);
        
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            msgText, { parse_mode: 'Markdown', ...mainMenu }
        );
    } catch(error) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ Error: ${error.message}`, mainMenu
        );
    }
}

// ============ CHANNEL ANALYSIS HANDLER ============
async function handleChannelAnalysis(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    let channelId = text;
    const handleMatch = text.match(/(?:youtube\.com\/@|youtube\.com\/channel\/)([a-zA-Z0-9_-]+)/);
    if (handleMatch) channelId = handleMatch[1];
    
    const youtube = getYoutube();
    if (!youtube) return ctx.reply(`❌ API keys exhausted.`);
    
    const msg = await ctx.reply(`📊 Analyzing...⏳`);
    
    try {
        const channelRes = await youtube.channels.list({
            part: 'snippet,statistics,contentDetails',
            id: channelId
        });
        
        if (!channelRes.data.items || channelRes.data.items.length === 0) {
            return ctx.reply('❌ Channel not found.');
        }
        
        const channel = channelRes.data.items[0];
        const stats = channel.statistics || {};
        
        let msgText = `📊 *Channel Analysis*\n\n📺 ${channel.snippet.title}\n👥 ${formatNumber(parseInt(stats.subscriberCount || 0))}\n🎬 ${formatNumber(parseInt(stats.videoCount || 0))}\n👁️ ${formatNumber(parseInt(stats.viewCount || 0))}\n📅 ${new Date(channel.snippet.publishedAt).toLocaleString()}\n🌍 ${channel.snippet.country || 'Unknown'}\n\n🔗 https://www.youtube.com/channel/${channelId}`;
        
        session.analysisMode = null;
        userSessions.set(userId, session);
        
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            msgText, { parse_mode: 'Markdown', ...mainMenu }
        );
    } catch(error) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ Error: ${error.message}`, mainMenu
        );
    }
}
// ============ VIDEO UPLOAD HANDLER ============
bot.on('video', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
    if (isUploading) return ctx.reply(`⏳ Another upload in progress.`);
    if (!session.subscriptionVerified) return ctx.reply(`❌ Subscribe first!`);
    
    const remaining = getRemainingUploads(session);
    if (remaining <= 0) return ctx.reply(`❌ No uploads remaining!`);
    
    const video = ctx.message.video;
    const fileSizeMB = video.file_size / 1024 / 1024;
    
    if (fileSizeMB > MAX_FILE_SIZE_MB) {
        return ctx.reply(
            `❌ *Video Too Large!*\n\n📦 Your video: ${fileSizeMB.toFixed(2)}MB\n📦 Max: ${MAX_FILE_SIZE_MB}MB\n\nPlease compress your video.`
        );
    }
    
    const tempFiles = fs.readdirSync(TEMP_DIR);
    let totalSize = 0;
    for (const file of tempFiles) {
        const filePath = path.join(TEMP_DIR, file);
        const stats = fs.statSync(filePath);
        totalSize += stats.size;
    }
    const currentUsageMB = totalSize / 1024 / 1024;
    const freeSpaceMB = 350 - currentUsageMB;
    
    if (fileSizeMB > freeSpaceMB) {
        clearAllTempFiles();
        const newFreeSpace = 350 - (fs.readdirSync(TEMP_DIR).reduce((acc, file) => {
            const filePath = path.join(TEMP_DIR, file);
            const stats = fs.statSync(filePath);
            return acc + stats.size;
        }, 0) / 1024 / 1024);
        
        if (fileSizeMB > newFreeSpace) {
            return ctx.reply(
                `❌ *Not Enough Space!*\n\n📦 Video: ${fileSizeMB.toFixed(2)}MB\n📊 Available: ${newFreeSpace.toFixed(2)}MB\n\nTry again later.`
            );
        }
    }
    
    clearUserTempFiles(userId);
    isUploading = true;
    currentUploader = userId;
    
    const caption = ctx.message.caption || '';
    const lines = caption.split('\n');
    let title = lines[0] || `Video ${Date.now()}`;
    let description = lines.slice(1).join('\n') || title;
    
    const msg = await ctx.reply(
        `📥 Downloading...\n\n📹 ${title}\n📦 ${fileSizeMB.toFixed(2)} MB\n📊 Remaining: ${remaining - 1}\n💾 Free: ${freeSpaceMB.toFixed(2)}MB`
    );
    
    try {
        const fileLink = await ctx.telegram.getFileLink(video.file_id);
        const tempPath = path.join(TEMP_DIR, `${userId}_${Date.now()}.mp4`);
        
        const response = await axios({
            method: 'GET',
            url: fileLink.href,
            responseType: 'stream',
            maxContentLength: MAX_FILE_SIZE_MB * 1024 * 1024
        });
        
        const writer = fs.createWriteStream(tempPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        session.tempFile = tempPath;
        session.videoData = { title, description };
        userSessions.set(userId, session);
        
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `✅ Ready!\n\nChoose option:`,
            Markup.inlineKeyboard([
                [Markup.button.callback('🌐 Public', 'upload_public')],
                [Markup.button.callback('🔒 Private', 'upload_private')],
                [Markup.button.callback('📅 Schedule', 'upload_schedule')],
                [Markup.button.callback('❌ Cancel', 'upload_cancel')]
            ])
        );
    } catch(error) {
        isUploading = false;
        currentUploader = null;
        clearUserTempFiles(userId);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ Error: ${error.message}`
        );
    }
});

// ============ UPLOAD HANDLERS ============
bot.action('upload_public', async (ctx) => await handleUpload(ctx, 'public'));
bot.action('upload_private', async (ctx) => await handleUpload(ctx, 'private'));
bot.action('upload_schedule', async (ctx) => await handleUpload(ctx, 'scheduled'));

bot.action('upload_cancel', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (session && session.tempFile && fs.existsSync(session.tempFile)) {
        fs.unlinkSync(session.tempFile);
    }
    if (session) {
        session.tempFile = null;
        session.videoData = null;
        userSessions.set(userId, session);
    }
    isUploading = false;
    currentUploader = null;
    await ctx.editMessageText('❌ Cancelled');
    await ctx.answerCbQuery('Cancelled');
});

async function handleUpload(ctx, privacy) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    if (!session || !session.tempFile) {
        isUploading = false;
        currentUploader = null;
        return ctx.reply('❌ No video found.');
    }
    
    await ctx.editMessageText(`📤 Uploading (${privacy})...⏳`);
    await ctx.answerCbQuery('Uploading...');
    
    try {
        const { title, description } = session.videoData;
        
        const requestBody = {
            snippet: {
                title: title.substring(0, 100),
                description: description.substring(0, 5000),
                categoryId: '22'
            },
            status: {
                privacyStatus: privacy === 'scheduled' ? 'private' : privacy,
                selfDeclaredMadeForKids: false
            }
        };
        
        if (privacy === 'scheduled') {
            const publishDate = new Date();
            publishDate.setDate(publishDate.getDate() + 1);
            requestBody.status.publishAt = publishDate.toISOString();
        }
        
        const fileStream = fs.createReadStream(session.tempFile);
        const response = await session.mainAccount.youtube.videos.insert({
            part: 'snippet,status',
            requestBody: requestBody,
            media: { body: fileStream }
        });
        
        fileStream.close();
        
        session.uploadCount = (session.uploadCount || 0) + 1;
        
        if (fs.existsSync(session.tempFile)) {
            fs.unlinkSync(session.tempFile);
        }
        session.tempFile = null;
        session.videoData = null;
        userSessions.set(userId, session);
        
        clearAllTempFiles();
        isUploading = false;
        currentUploader = null;
        
        const statusText = privacy === 'public' ? '🌐 Public' : privacy === 'private' ? '🔒 Private' : '📅 Scheduled';
        
        await ctx.editMessageText(
            `✅ **Upload Successful!**\n\n📹 ${title}\n🔗 https://www.youtube.com/watch?v=${response.data.id}\n📊 ${statusText}\n📤 Remaining: ${getRemainingUploads(session)}\n\nSend another video!`,
            { parse_mode: 'Markdown' }
        );
    } catch(error) {
        if (session.tempFile && fs.existsSync(session.tempFile)) {
            fs.unlinkSync(session.tempFile);
            session.tempFile = null;
            session.videoData = null;
            userSessions.set(userId, session);
        }
        isUploading = false;
        currentUploader = null;
        await ctx.editMessageText(`❌ Upload failed: ${error.message}`);
    }
}

// ============ HANDLE REFERRALS ============
bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    const refMatch = ctx.message.text.match(/\/start\s+ref_(\d+)/);
    
    if (refMatch) {
        const inviterId = refMatch[1];
        if (inviterId !== userId) {
            const invited = trackInvite(inviterId, userId);
            if (invited) {
                const inviterSession = userSessions.get(inviterId);
                if (inviterSession) {
                    inviterSession.totalUploadsAllowed = (inviterSession.totalUploadsAllowed || MAX_UPLOADS) + INVITE_BONUS;
                    userSessions.set(inviterId, inviterSession);
                }
                await ctx.reply(`🎉 Welcome! Inviter earned +${INVITE_BONUS} upload!`);
            }
        }
    }
    
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            mainAccount: null,
            subscriptionVerified: false,
            uploadCount: 0,
            totalUploadsAllowed: MAX_UPLOADS,
            linkedAccounts: [],
            telegramVerified: false,
            aiMode: null,
            analysisMode: null,
            chatMode: null
        });
    }
    
    const session = userSessions.get(userId);
    const isTelegramMember = await checkTelegramMembership(ctx.from.id);
    
    if (!isTelegramMember) {
        return ctx.reply(
            `❌ Join ${REQUIRED_TELEGRAM_CHANNEL} first!`,
            Markup.inlineKeyboard([
                [Markup.button.url('📢 Join', `https://t.me/${REQUIRED_TELEGRAM_CHANNEL.replace('@', '')}`)],
                [Markup.button.callback('✅ Verify', 'verify_telegram')]
            ])
        );
    }
    
    session.telegramVerified = true;
    userSessions.set(userId, session);
    
    if (!session.mainAccount || !session.mainAccount.authenticated) {
        return ctx.reply(
            `✅ Verified!\n\nLogin with YouTube:`,
            Markup.inlineKeyboard([
                [Markup.button.url('🔑 Login', `${REDIRECT_URI.replace('/oauth2callback', '/auth')}`)]
            ])
        );
    }
    
    await showMainMenu(ctx, userId);
});

// ============ START SERVER ============

loadAI().then(() => {
    bot.launch().then(() => {
        console.log('🤖 Bot started!');
        console.log(`📦 Max file size: ${MAX_FILE_SIZE_MB}MB`);
    });
    
    app.listen(PORT, () => {
        console.log(`🌐 Server on port ${PORT}`);
        console.log(`🔗 OAuth: ${REDIRECT_URI}`);
        console.log(`🧠 AI: ${aiReady ? '✅ Ready' : '⏳ Loading...'}`);
    });
    
    clearAllTempFiles();
    
    setInterval(() => {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();
        let deleted = 0;
        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                const age = (now - stats.mtimeMs) / 1000 / 60;
                if (age > 60) {
                    fs.unlinkSync(filePath);
                    deleted++;
                }
            } catch(e) {}
        }
        if (deleted > 0) console.log(`🗑️ Cleaned up ${deleted} old temp files`);
    }, 60000);
    
    console.log('🚀 YouTube Bot Ready!');
    console.log(`📦 Max upload: ${MAX_FILE_SIZE_MB}MB`);
    console.log(`🤖 AI: ${aiReady ? '✅ Ready' : '⏳ Loading...'}`);
    console.log(`🆘 Contact: ${DEVELOPER_CONTACT}`);
}).catch(error => {
    console.error('❌ Failed to start:', error);
});
// ============ FIX: OAuth Callback Handler ============
// Replace the existing /oauth2callback route with this
app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.send('❌ No code received');
    
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        const channelRes = await youtube.channels.list({
            part: 'snippet',
            mine: true
        });
        
        if (!channelRes.data.items || channelRes.data.items.length === 0) {
            return res.send('❌ No YouTube channel found');
        }
        
        const channelId = channelRes.data.items[0].id;
        const channelName = channelRes.data.items[0].snippet.title;
        
        // Get userId from session or state
        const userId = req.session.userId || req.query.state;
        
        if (userId && userSessions.has(userId)) {
            const session = userSessions.get(userId);
            session.mainAccount = {
                channelId: channelId,
                channelName: channelName,
                oauthClient: oauth2Client,
                youtube: youtube,
                tokens: tokens,
                authenticated: true
            };
            userSessions.set(userId, session);
            
            // Send success message to Telegram
            try {
                await bot.telegram.sendMessage(
                    userId,
                    `✅ **YouTube Login Successful!**\n\n` +
                    `📺 Channel: ${channelName}\n` +
                    `📦 Max file: ${MAX_FILE_SIZE_MB}MB\n\n` +
                    `Send /start to see the menu.`,
                    { parse_mode: 'Markdown' }
                );
            } catch(e) {
                console.log('Could not send message:', e.message);
            }
        } else {
            // Create new session if needed
            const newUserId = userId || `user_${Date.now()}`;
            if (!userSessions.has(newUserId)) {
                userSessions.set(newUserId, {
                    mainAccount: {
                        channelId: channelId,
                        channelName: channelName,
                        oauthClient: oauth2Client,
                        youtube: youtube,
                        tokens: tokens,
                        authenticated: true
                    },
                    subscriptionVerified: false,
                    uploadCount: 0,
                    totalUploadsAllowed: MAX_UPLOADS,
                    linkedAccounts: [],
                    telegramVerified: false,
                    aiMode: null,
                    analysisMode: null,
                    chatMode: null
                });
            }
        }
        
        res.send(`
            <html>
                <head><title>Login Successful</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1>✅ Login Successful!</h1>
                    <p>Channel: <strong>${channelName}</strong></p>
                    <p>Max file: ${MAX_FILE_SIZE_MB}MB</p>
                    <p>You can now close this window.</p>
                    <p>Send <strong>/start</strong> to the bot.</p>
                    <p><a href="/">Go to Home</a></p>
                </body>
            </html>
        `);
    } catch(error) {
        console.error('OAuth error:', error);
        res.send(`❌ Login failed: ${error.message}`);
    }
});

// ============ FIX: Auth Route with User ID ============
// Replace the existing /auth route with this
app.get('/auth', (req, res) => {
    const userId = req.query.userId || req.session.userId;
    if (userId) {
        req.session.userId = userId;
    }
    
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/youtube.upload',
            'https://www.googleapis.com/auth/youtube',
            'https://www.googleapis.com/auth/youtube.readonly'
        ],
        prompt: 'consent',
        state: userId || ''
    });
    res.redirect(authUrl);
});

// ============ FIX: Start Command with Login Flow ============
// Replace the existing start command with this
bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            mainAccount: null,
            subscriptionVerified: false,
            uploadCount: 0,
            totalUploadsAllowed: MAX_UPLOADS,
            linkedAccounts: [],
            telegramVerified: false,
            aiMode: null,
            analysisMode: null,
            chatMode: null
        });
    }
    
    const session = userSessions.get(userId);
    const isTelegramMember = await checkTelegramMembership(ctx.from.id);
    
    if (!isTelegramMember) {
        return ctx.reply(
            `❌ *Join ${REQUIRED_TELEGRAM_CHANNEL} first!*`,
            Markup.inlineKeyboard([
                [Markup.button.url('📢 Join', `https://t.me/${REQUIRED_TELEGRAM_CHANNEL.replace('@', '')}`)],
                [Markup.button.callback('✅ Verify', 'verify_telegram')]
            ]),
            { parse_mode: 'Markdown' }
        );
    }
    
    session.telegramVerified = true;
    userSessions.set(userId, session);
    
    // Check if already logged in
    if (session.mainAccount && session.mainAccount.authenticated) {
        await showMainMenu(ctx, userId);
        return;
    }
    
    // Not logged in - show login button
    const authUrl = `${REDIRECT_URI.replace('/oauth2callback', '/auth')}?userId=${userId}`;
    
    await ctx.reply(
        `✅ Telegram verified!\n\n` +
        `Now login with YouTube to start uploading.\n\n` +
        `🔐 Click the button below to login.`,
        Markup.inlineKeyboard([
            [Markup.button.url('🔑 Login with YouTube', authUrl)]
        ])
    );
});

// ============ FIX: Show Main Menu After Login ============
// Make sure showMainMenu function exists and works
async function showMainMenu(ctx, userId) {
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount || !session.mainAccount.authenticated) {
        return ctx.reply('❌ Please login first.');
    }
    
    const remaining = getRemainingUploads(session);
    const inviteCount = inviteTracker.has(userId) ? inviteTracker.get(userId).invitedUsers.length : 0;
    
    let msg = `👋 *${session.mainAccount?.channelName || 'User'}*\n\n`;
    msg += `📤 Uploads: ${session.uploadCount || 0}/${session.totalUploadsAllowed}\n`;
    msg += `📊 Remaining: ${remaining}\n`;
    msg += `👥 Invites: ${inviteCount}\n`;
    msg += `📦 Max file: ${MAX_FILE_SIZE_MB}MB\n`;
    msg += `🤖 AI: ${aiReady ? '✅' : '⏳'}\n\n`;
    msg += `💬 *Chat, Summarize, Get Advice!*`;
    
    try {
        await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...mainMenu });
    } catch(e) {
        await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
    }
}

// ============ FIX: Verification Button ============
// Make sure verify button works
bot.action('verify_telegram', async (ctx) => {
    const isMember = await checkTelegramMembership(ctx.from.id);
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    if (isMember) {
        if (session) session.telegramVerified = true;
        await ctx.editMessageText(
            `✅ Telegram verified!\n\n` +
            `Now login with YouTube to start uploading.`,
            Markup.inlineKeyboard([
                [Markup.button.url('🔑 Login with YouTube', `${REDIRECT_URI.replace('/oauth2callback', '/auth')}?userId=${userId}`)]
            ])
        );
        await ctx.answerCbQuery('Verified!');
    } else {
        await ctx.answerCbQuery('❌ Not a member! Join first.', { show_alert: true });
    }
});

// ============ FIX: Debug Status Command ============
bot.command('status', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    let msg = `📊 *Your Status*\n\n`;
    msg += `👤 User ID: ${userId}\n`;
    msg += `✅ Telegram: ${session?.telegramVerified ? '✅' : '❌'}\n`;
    msg += `✅ YouTube: ${session?.mainAccount?.authenticated ? '✅' : '❌'}\n`;
    
    if (session?.mainAccount?.authenticated) {
        msg += `📺 Channel: ${session.mainAccount.channelName}\n`;
        msg += `📤 Uploads: ${session.uploadCount || 0}/${session.totalUploadsAllowed}\n`;
        msg += `📊 Remaining: ${getRemainingUploads(session)}\n`;
    } else {
        msg += `\n🔑 *Login to start uploading*\n`;
        const authUrl = `${REDIRECT_URI.replace('/oauth2callback', '/auth')}?userId=${userId}`;
        msg += `\n[Login Link](${authUrl})`;
    }
    
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ============ FIX: Login Check Middleware ============
// Add this to check login status on every action
async function requireLogin(ctx, next) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    
    if (!session || !session.mainAccount || !session.mainAccount.authenticated) {
        const authUrl = `${REDIRECT_URI.replace('/oauth2callback', '/auth')}?userId=${userId}`;
        await ctx.reply(
            `❌ *Please Login First*\n\n` +
            `You need to login with YouTube to use this feature.\n\n` +
            `🔐 Click the button below to login.`,
            Markup.inlineKeyboard([
                [Markup.button.url('🔑 Login with YouTube', authUrl)]
            ]),
            { parse_mode: 'Markdown' }
        );
        return;
    }
    
    return next(ctx);
}

console.log('✅ All fixes applied!');
console.log('📌 Make sure your bot is admin in @bot_Farming');
console.log('🔄 After login, send /start to see the menu');
