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

const API_KEYS = [
    'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg',
    'AIzaSyAXzQXd0AONNgSI8E6D5_BeweMqyz4iGTg',
    'AIzaSyDjLVpU8M9VFBAuj-_pvSyDW1BbUfCjyIY'
];

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
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const userSessions = new Map();
const inviteTracker = new Map();
let isUploading = false;
let currentUploader = null;

const TEMP_DIR = '/tmp/youtube_uploads';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ============ FAST AI SETUP WITH PROGRESS ============
let textGenerator = null;
let aiReady = false;
let aiLoading = false;
let loadingProgress = 0;
let loadingMessage = 'Starting...';
const AI_MODEL = 'distilgpt2';
const MAX_LENGTH = 100;
const TEMPERATURE = 0.8;

function updateProgress(step, message) {
    loadingProgress = step;
    loadingMessage = message;
    console.log(`⏳ AI Loading: ${step}% - ${message}`);
}

async function loadAI() {
    if (aiLoading || aiReady) return;
    aiLoading = true;
    updateProgress(5, 'Initializing...');
    try {
        updateProgress(10, 'Loading model files...');
        await new Promise(resolve => setTimeout(resolve, 500));
        updateProgress(30, 'Preparing pipeline...');
        await new Promise(resolve => setTimeout(resolve, 500));
        updateProgress(50, 'Loading DistilGPT2 (82MB)...');
        textGenerator = await pipeline('text-generation', AI_MODEL, {
            device: 'cpu',
            dtype: 'float32'
        });
        updateProgress(80, 'Optimizing model...');
        await new Promise(resolve => setTimeout(resolve, 300));
        updateProgress(95, 'Finalizing...');
        await new Promise(resolve => setTimeout(resolve, 200));
        aiReady = true;
        aiLoading = false;
        updateProgress(100, '✅ Ready!');
        console.log('✅ Fast AI ready!');
        return true;
    } catch(error) {
        console.error('❌ AI Error:', error.message);
        aiReady = false;
        aiLoading = false;
        updateProgress(0, '❌ Error, retrying...');
        setTimeout(loadAI, 10000);
        return false;
    }
}

loadAI();

setInterval(() => {
    if (textGenerator && aiReady) {
        textGenerator('ping', { max_length: 2 }).catch(() => {});
    } else if (!aiReady && !aiLoading) {
        loadAI();
    }
}, 60000);

async function ensureAIReady() {
    if (aiReady && textGenerator) return true;
    if (!aiLoading && !aiReady) loadAI();
    let attempts = 0;
    while (!aiReady && attempts < 5) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
    }
    return aiReady && textGenerator !== null;
}

// ============ AI FUNCTIONS ============

async function chatWithAI(userMessage) {
    await ensureAIReady();
    if (!textGenerator) return "⏳ Loading...";
    try {
        const result = await textGenerator(`User: ${userMessage}\nAI:`, {
            max_length: MAX_LENGTH, temperature: TEMPERATURE,
            pad_token_id: 50256, do_sample: true, top_k: 50
        });
        let response = result[0]?.generated_text || '';
        response = response.replace(`User: ${userMessage}\nAI:`, '').trim();
        return response || "Got it!";
    } catch(e) { return "Try again!"; }
}

async function summarizeContent(text) {
    await ensureAIReady();
    if (!textGenerator) return "⏳ Loading...";
    try {
        const result = await textGenerator(`Summary: ${text.substring(0, 200)}\n`, {
            max_length: 80, temperature: 0.5, pad_token_id: 50256
        });
        return result[0]?.generated_text?.replace(`Summary: ${text.substring(0, 200)}\n`, '').trim() || "Summarized!";
    } catch(e) { return "Quick summary: " + text.substring(0, 100) + "..."; }
}

async function getAIAdvice(topic) {
    await ensureAIReady();
    if (!textGenerator) return "⏳ Loading...";
    try {
        const result = await textGenerator(`Advice for ${topic}:`, {
            max_length: 80, temperature: 0.7, pad_token_id: 50256
        });
        return result[0]?.generated_text?.replace(`Advice for ${topic}:`, '').trim() || "Keep going!";
    } catch(e) { return "💡 Stay consistent and engage with your audience!"; }
}

async function generateTitles(topic, keywords = []) {
    await ensureAIReady();
    if (!textGenerator) return null;
    try {
        const result = await textGenerator(`Titles for ${topic}:`, {
            max_length: 80, temperature: 0.9, pad_token_id: 50256
        });
        const generated = result[0]?.generated_text || '';
        const titles = generated.split('\n').filter(l => l.trim().length > 5).slice(0, 3)
            .map(l => l.replace(/^\d+\.\s*/, '').trim());
        return titles.length > 0 ? titles : [`${topic} - Amazing!`, `${topic} - Best Ever!`, `${topic} - Must Watch!`];
    } catch(e) { return [`${topic} - Best Video!`, `${topic} - Amazing!`, `${topic} - Must Watch!`]; }
}

async function generateDescription(topic, keywords = [], title = '') {
    await ensureAIReady();
    if (!textGenerator) return null;
    try {
        const result = await textGenerator(`Description for ${title}:`, {
            max_length: 100, temperature: 0.8, pad_token_id: 50256
        });
        return result[0]?.generated_text?.replace(`Description for ${title}:`, '').trim() || `Amazing ${topic} video! Watch now! 🔥`;
    } catch(e) { return `🔥 Amazing ${topic} video! Subscribe for more!`; }
}

async function generateTags(topic, keywords = []) {
    await ensureAIReady();
    if (!textGenerator) return null;
    try {
        const result = await textGenerator(`Tags for ${topic}:`, {
            max_length: 60, temperature: 0.7, pad_token_id: 50256
        });
        const generated = result[0]?.generated_text?.replace(`Tags for ${topic}:`, '').trim() || '';
        const tags = generated.split(/\s+/).filter(t => t.startsWith('#')).slice(0, 5);
        return tags.length > 0 ? tags : [`#${topic}`, `#${topic}Video`, `#Trending`];
    } catch(e) { return [`#${topic}`, `#${topic}Video`, `#Trending`, `#Viral`, `#Shorts`]; }
}

// ============ EXPRESS ROUTES ============

app.get('/', (req, res) => {
    res.send(`
        <html><head><title>YouTube Upload Bot</title></head>
        <body style="font-family:Arial;text-align:center;padding:50px;">
            <h1>🎬 YouTube Upload Bot</h1>
            <p>Users: ${userSessions.size} | AI: ${aiReady ? '✅' : '⏳'}</p>
            <p>Max file: ${MAX_FILE_SIZE_MB}MB</p>
            <p><a href="/auth">Login with YouTube</a></p>
            <p>Contact: ${DEVELOPER_CONTACT}</p>
        </body></html>
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
    res.json({
        status: 'ok',
        ai: aiReady ? 'ready' : 'loading',
        aiProgress: loadingProgress,
        sessions: userSessions.size,
        tempFiles: tempFiles.length,
        tempSizeMB: (totalSize / 1024 / 1024).toFixed(2),
        isUploading: isUploading,
        maxFileSizeMB: MAX_FILE_SIZE_MB
    });
});

// ============ AUTH ROUTES ============

app.get('/auth', (req, res) => {
    const userId = req.query.userId || req.session.userId || 'default';
    if (userId) req.session.userId = userId;
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube.readonly'],
        prompt: 'consent',
        state: userId
    });
    res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.send('❌ No code received');
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        const channelRes = await youtube.channels.list({ part: 'snippet', mine: true });
        if (!channelRes.data.items || channelRes.data.items.length === 0) {
            return res.send('❌ No YouTube channel found');
        }
        const channelId = channelRes.data.items[0].id;
        const channelName = channelRes.data.items[0].snippet.title;
        const userId = state || req.session.userId || 'default';
        
        if (!userSessions.has(userId)) {
            userSessions.set(userId, {
                mainAccount: { channelId, channelName, oauthClient: oauth2Client, youtube, tokens, authenticated: true },
                subscriptionVerified: false, uploadCount: 0, totalUploadsAllowed: MAX_UPLOADS,
                linkedAccounts: [], telegramVerified: false, aiMode: null, analysisMode: null, chatMode: null
            });
        } else {
            const session = userSessions.get(userId);
            session.mainAccount = { channelId, channelName, oauthClient: oauth2Client, youtube, tokens, authenticated: true };
            userSessions.set(userId, session);
        }
        
        try {
            await bot.telegram.sendMessage(userId, `✅ **YouTube Login Successful!**\n\n📺 Channel: ${channelName}\n📦 Max file: ${MAX_FILE_SIZE_MB}MB\n\nSend /start to see the menu.`, { parse_mode: 'Markdown' });
        } catch(e) { console.log('Could not send message:', e.message); }
        
        res.send(`
            <html><head><title>Login Successful</title></head>
            <body style="font-family:Arial;text-align:center;padding:50px;">
                <h1>✅ Login Successful!</h1>
                <p>Channel: <strong>${channelName}</strong></p>
                <p>Max file: ${MAX_FILE_SIZE_MB}MB</p>
                <p>Send <strong>/start</strong> to the bot.</p>
                <p><a href="/">Go Home</a></p>
            </body></html>
        `);
    } catch(error) {
        console.error('OAuth error:', error);
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
        if(now - keyReset[i] > ONE_DAY) { keyUsage[i] = 0; keyReset[i] = now; }
        if(keyUsage[i] < 9000) { currentKey = i; keyUsage[i]++; return API_KEYS[i]; }
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
    for (const file of files) {
        const filePath = path.join(TEMP_DIR, file);
        try { fs.unlinkSync(filePath); deleted++; } catch(e) {}
    }
    if (deleted > 0) console.log(`🗑️ Cleared ${deleted} temp files`);
}

function clearUserTempFiles(userId) {
    const files = fs.readdirSync(TEMP_DIR);
    let deleted = 0;
    for (const file of files) {
        if (file.startsWith(userId)) {
            const filePath = path.join(TEMP_DIR, file);
            try { fs.unlinkSync(filePath); deleted++; } catch(e) {}
        }
    }
    return deleted;
}

// ============ VERIFY FUNCTIONS ============

async function checkYouTubeSubscriptionWithApi(channelId) {
    try {
        const youtube = getYoutube();
        if (!youtube) return false;
        const response = await youtube.subscriptions.list({ part: 'snippet', channelId: channelId, forChannelId: REQUIRED_YOUTUBE_CHANNEL_ID });
        return response.data.items && response.data.items.length > 0;
    } catch(error) { return false; }
}

async function checkTelegramMembership(userId) {
    try {
        const chatMember = await bot.telegram.getChatMember(REQUIRED_TELEGRAM_CHANNEL, userId);
        return chatMember.status === 'member' || chatMember.status === 'administrator' || chatMember.status === 'creator';
    } catch(e) { return false; }
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

function parseDuration(duration) {
    const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
    const hours = (match[1] || '').replace('H', '') || 0;
    const minutes = (match[2] || '').replace('M', '') || 0;
    const seconds = (match[3] || '').replace('S', '') || 0;
    return `${hours}h ${minutes}m ${seconds}s`;
}

// ============ MENUS ============

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

// ============ BOT COMMANDS ============

bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            mainAccount: null, subscriptionVerified: false, uploadCount: 0,
            totalUploadsAllowed: MAX_UPLOADS, linkedAccounts: [], telegramVerified: false,
            aiMode: null, analysisMode: null, chatMode: null
        });
    }
    const session = userSessions.get(userId);
    const isTelegramMember = await checkTelegramMembership(ctx.from.id);
    if (!isTelegramMember) {
        return ctx.reply(`❌ *Join ${REQUIRED_TELEGRAM_CHANNEL} first!*`,
            Markup.inlineKeyboard([
                [Markup.button.url('📢 Join', `https://t.me/${REQUIRED_TELEGRAM_CHANNEL.replace('@', '')}`)],
                [Markup.button.callback('✅ Verify', 'verify_telegram')]
            ]), { parse_mode: 'Markdown' }
        );
    }
    session.telegramVerified = true;
    userSessions.set(userId, session);
    if (session.mainAccount && session.mainAccount.authenticated) {
        await showMainMenu(ctx, userId);
        return;
    }
    const authUrl = `${REDIRECT_URI.replace('/oauth2callback', '/auth')}?userId=${userId}`;
    await ctx.reply(`✅ Telegram verified!\n\nLogin with YouTube:`,
        Markup.inlineKeyboard([[Markup.button.url('🔑 Login with YouTube', authUrl)]])
    );
});

async function showMainMenu(ctx, userId) {
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount || !session.mainAccount.authenticated) {
        return ctx.reply('❌ Please login first.');
    }
    const remaining = getRemainingUploads(session);
    const inviteCount = inviteTracker.has(userId) ? inviteTracker.get(userId).invitedUsers.length : 0;
    
    let progressBar = '';
    let aiStatus = '';
    if (aiReady) {
        aiStatus = '✅ Fast';
    } else if (aiLoading) {
        const filled = Math.floor(loadingProgress / 10);
        const empty = 10 - filled;
        progressBar = '█'.repeat(filled) + '░'.repeat(empty);
        aiStatus = `⏳ ${progressBar} ${loadingProgress}%`;
    } else {
        aiStatus = '⚠️ Starting...';
    }
    
    let msg = `👋 *${session.mainAccount?.channelName || 'User'}*\n\n`;
    msg += `📤 Uploads: ${session.uploadCount || 0}/${session.totalUploadsAllowed}\n`;
    msg += `📊 Remaining: ${remaining}\n👥 Invites: ${inviteCount}\n`;
    msg += `📦 Max file: ${MAX_FILE_SIZE_MB}MB\n🤖 AI: ${aiStatus}\n\n💬 *Chat, Summarize, Get Advice!*`;
    
    try {
        await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...mainMenu });
    } catch(e) {
        await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
    }
}

// ============ AI ACTIONS ============

bot.action('chat_ai', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
    session.chatMode = 'chat';
    userSessions.set(userId, session);
    await ctx.editMessageText(`💬 *Chat with AI*\n\nAsk anything!\nType /cancel to exit.`, { parse_mode: 'Markdown' });
});

bot.action('summarize', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
    session.chatMode = 'summarize';
    userSessions.set(userId, session);
    await ctx.editMessageText(`📝 *Summarize*\n\nSend text to summarize.\nType /cancel to exit.`, { parse_mode: 'Markdown' });
});

bot.action('advice', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
    session.chatMode = 'advice';
    userSessions.set(userId, session);
    await ctx.editMessageText(`💡 *Get Advice*\n\nWhat do you need advice on?\nType /cancel to exit.`, { parse_mode: 'Markdown' });
});

bot.action('ai_menu', async (ctx) => {
    await ctx.editMessageText(`🤖 *AI Tools*\n\n🎯 Titles | 📝 Descriptions | 🏷️ Tags`, { parse_mode: 'Markdown', ...aiMenu });
});

bot.action('ai_title', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    session.aiMode = 'title';
    userSessions.set(userId, session);
    await ctx.editMessageText(`🎯 Send me a topic.\nType /cancel to exit.`);
});

bot.action('ai_desc', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    session.aiMode = 'description';
    userSessions.set(userId, session);
    await ctx.editMessageText(`📝 Send: Title | Topic | Keywords\nType /cancel to exit.`);
});

bot.action('ai_tags', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    session.aiMode = 'tags';
    userSessions.set(userId, session);
    await ctx.editMessageText(`🏷️ Send me a topic.\nType /cancel to exit.`);
});

// ============ OTHER ACTIONS ============

bot.action('contact_developer', async (ctx) => {
    await ctx.editMessageText(`🆘 *Contact Developer*\n\n👨‍💻 ${DEVELOPER_CONTACT}`,
        Markup.inlineKeyboard([
            [Markup.button.url('📩 Contact', `https://t.me/${DEVELOPER_CONTACT.replace('@', '')}`)],
            [Markup.button.callback('🔙 Back', 'back_to_menu')]
        ]), { parse_mode: 'Markdown' }
    );
});

bot.action('verify_telegram', async (ctx) => {
    const isMember = await checkTelegramMembership(ctx.from.id);
    const userId = ctx.from.id.toString();
    if (isMember) {
        const session = userSessions.get(userId);
        if (session) session.telegramVerified = true;
        await ctx.editMessageText(`✅ Verified! Login with YouTube.`,
            Markup.inlineKeyboard([[Markup.button.url('🔑 Login', `${REDIRECT_URI.replace('/oauth2callback', '/auth')}?userId=${userId}`)]])
        );
        await ctx.answerCbQuery('Verified!');
    } else {
        await ctx.answerCbQuery('❌ Not a member!', { show_alert: true });
    }
});

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
        await ctx.editMessageText(`❌ Subscribe to ${REQUIRED_YOUTUBE_CHANNEL_NAME}`,
            Markup.inlineKeyboard([
                [Markup.button.url('📺 Subscribe', `https://www.youtube.com/${REQUIRED_YOUTUBE_CHANNEL_NAME}`)],
                [Markup.button.callback('✅ Verify', 'verify_subscription')],
                [Markup.button.callback('🔙 Back', 'back_to_menu')]
            ])
        );
    }
});

bot.action('invite', async (ctx) => {
    const userId = ctx.from.id.toString();
    const botUsername = ctx.botInfo.username;
    const inviteLink = `https://t.me/${botUsername}?start=ref_${userId}`;
    const inviteCount = inviteTracker.has(userId) ? inviteTracker.get(userId).invitedUsers.length : 0;
    await ctx.editMessageText(`👥 *Invite Friends*\n\n+${INVITE_BONUS} upload per invite!\n📊 ${inviteCount}\n\n🔗 ${inviteLink}`,
        Markup.inlineKeyboard([
            [Markup.button.url('📤 Share', `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=Join this bot!`)],
            [Markup.button.callback('🔙 Back', 'back_to_menu')]
        ]), { parse_mode: 'Markdown' }
    );
});

bot.action('back_to_menu', async (ctx) => {
    const userId = ctx.from.id.toString();
    await showMainMenu(ctx, userId);
});

bot.action('status', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount) return ctx.reply('❌ Not logged in');
    try {
        const channelRes = await session.mainAccount.youtube.channels.list({ part: 'statistics', mine: true });
        const stats = channelRes.data.items[0]?.statistics || {};
        const remaining = getRemainingUploads(session);
        const inviteCount = inviteTracker.has(userId) ? inviteTracker.get(userId).invitedUsers.length : 0;
        
        let progressBar = '';
        let aiStatus = '';
        if (aiReady) {
            aiStatus = '✅ Fast';
        } else if (aiLoading) {
            const filled = Math.floor(loadingProgress / 10);
            const empty = 10 - filled;
            progressBar = '█'.repeat(filled) + '░'.repeat(empty);
            aiStatus = `⏳ ${progressBar} ${loadingProgress}%`;
        } else {
            aiStatus = '⚠️ Starting...';
        }
        
        let msg = `📊 *Status*\n\n📺 ${session.mainAccount.channelName}\n👥 ${formatNumber(parseInt(stats.subscriberCount || 0))}\n🎬 ${formatNumber(parseInt(stats.videoCount || 0))}\n👁️ ${formatNumber(parseInt(stats.viewCount || 0))}\n\n📤 ${session.uploadCount || 0}/${session.totalUploadsAllowed}\n📊 Remaining: ${remaining}\n👥 Invites: ${inviteCount}\n✅ ${session.subscriptionVerified ? 'Subscribed' : 'Not subscribed'}\n📦 Max: ${MAX_FILE_SIZE_MB}MB\n🤖 AI: ${aiStatus}`;
        
        await ctx.editMessageText(msg, { parse_mode: 'Markdown' });
        await ctx.answerCbQuery();
    } catch(error) {
        await ctx.reply(`❌ Error: ${error.message}`);
    }
});

bot.action('logout', async (ctx) => {
    const userId = ctx.from.id.toString();
    clearUserTempFiles(userId);
    userSessions.delete(userId);
    await ctx.editMessageText(`🚪 Logged out! Send /start to login.`);
    await ctx.answerCbQuery('Logged out');
});

bot.action('upload', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
    if (isUploading) return ctx.editMessageText(`⏳ Another upload in progress.`);
    if (!session.subscriptionVerified) {
        return ctx.editMessageText(`❌ Subscribe first!`, Markup.inlineKeyboard([[Markup.button.callback('✅ Verify', 'verify_subscription')]]));
    }
    const remaining = getRemainingUploads(session);
    if (remaining <= 0) {
        return ctx.editMessageText(`❌ No uploads remaining!`, Markup.inlineKeyboard([[Markup.button.callback('👥 Invite', 'invite')]]));
    }
    await ctx.editMessageText(`📤 Send a video.\n📊 Remaining: ${remaining}\n📦 Max: ${MAX_FILE_SIZE_MB}MB`);
});

bot.action('analyze_video', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    session.analysisMode = 'video';
    userSessions.set(userId, session);
    await ctx.editMessageText(`🔍 Send me a YouTube video link or ID.\nType /cancel to exit.`);
});

bot.action('analyze_channel', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    session.analysisMode = 'channel';
    userSessions.set(userId, session);
    await ctx.editMessageText(`📊 Send me a YouTube channel link or ID.\nType /cancel to exit.`);
});
// ============ TEXT HANDLERS ============

bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    const text = ctx.message.text;
    if (text === '/cancel') {
        if (session) { session.aiMode = null; session.analysisMode = null; session.chatMode = null; userSessions.set(userId, session); }
        return ctx.reply('✅ Cancelled.', mainMenu);
    }
    if (!session) return;
    if (session.chatMode === 'chat') await handleChat(ctx, text);
    else if (session.chatMode === 'summarize') await handleSummarize(ctx, text);
    else if (session.chatMode === 'advice') await handleAdvice(ctx, text);
    else if (session.aiMode === 'title') await handleAITitle(ctx, text);
    else if (session.aiMode === 'description') await handleAIDescription(ctx, text);
    else if (session.aiMode === 'tags') await handleAITags(ctx, text);
    else if (session.analysisMode === 'video') await handleVideoAnalysis(ctx, text);
    else if (session.analysisMode === 'channel') await handleChannelAnalysis(ctx, text);
});

// ============ HANDLERS ============

async function handleChat(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    const msg = await ctx.reply(`💬 Thinking...⏳`);
    const response = await chatWithAI(text);
    if (response && !response.includes('Loading')) {
        session.chatMode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `💬 *Response*\n\n${response}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    } else {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            response || `❌ Try again.`, mainMenu
        );
    }
}

async function handleSummarize(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    const msg = await ctx.reply(`📝 Summarizing...⏳`);
    const summary = await summarizeContent(text);
    if (summary && !summary.includes('Loading')) {
        session.chatMode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `📝 *Summary*\n\n${summary}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    } else {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ Failed. Try again.`, mainMenu
        );
    }
}

async function handleAdvice(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    const msg = await ctx.reply(`💡 Getting advice...⏳`);
    const advice = await getAIAdvice(text);
    if (advice && !advice.includes('Loading')) {
        session.chatMode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `💡 *Advice*\n\n${advice}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    } else {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ Failed. Try again.`, mainMenu
        );
    }
}

async function handleAITitle(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    const msg = await ctx.reply(`🎯 Generating titles...⏳`);
    const titles = await generateTitles(text);
    if (titles) {
        session.aiMode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `🎯 *Titles*\n\n${titles.join('\n')}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    } else {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ Failed. Try again.`, mainMenu
        );
    }
}

async function handleAIDescription(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
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
            `❌ Failed. Try again.`, mainMenu
        );
    }
}

async function handleAITags(ctx, text) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
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
            `❌ Failed. Try again.`, mainMenu
        );
    }
}

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
        const videoRes = await youtube.videos.list({ part: 'snippet,statistics,contentDetails', id: videoId });
        if (!videoRes.data.items || videoRes.data.items.length === 0) return ctx.reply('❌ Video not found.');
        const video = videoRes.data.items[0];
        const stats = video.statistics || {};
        let msgText = `🔍 *Video Analysis*\n\n📹 ${video.snippet.title}\n📺 ${video.snippet.channelTitle}\n📅 ${new Date(video.snippet.publishedAt).toLocaleString()}\n⏱️ ${parseDuration(video.contentDetails.duration)}\n👁️ ${formatNumber(parseInt(stats.viewCount || 0))}\n👍 ${formatNumber(parseInt(stats.likeCount || 0))}\n💬 ${formatNumber(parseInt(stats.commentCount || 0))}\n\n🔗 https://www.youtube.com/watch?v=${videoId}`;
        session.analysisMode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, msgText, { parse_mode: 'Markdown', ...mainMenu });
    } catch(error) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Error: ${error.message}`, mainMenu);
    }
}

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
        const channelRes = await youtube.channels.list({ part: 'snippet,statistics,contentDetails', id: channelId });
        if (!channelRes.data.items || channelRes.data.items.length === 0) return ctx.reply('❌ Channel not found.');
        const channel = channelRes.data.items[0];
        const stats = channel.statistics || {};
        let msgText = `📊 *Channel Analysis*\n\n📺 ${channel.snippet.title}\n👥 ${formatNumber(parseInt(stats.subscriberCount || 0))}\n🎬 ${formatNumber(parseInt(stats.videoCount || 0))}\n👁️ ${formatNumber(parseInt(stats.viewCount || 0))}\n📅 ${new Date(channel.snippet.publishedAt).toLocaleString()}\n🌍 ${channel.snippet.country || 'Unknown'}\n\n🔗 https://www.youtube.com/channel/${channelId}`;
        session.analysisMode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, msgText, { parse_mode: 'Markdown', ...mainMenu });
    } catch(error) {
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Error: ${error.message}`, mainMenu);
    }
}

// ============ AI STATUS COMMAND ============

bot.command('aistatus', async (ctx) => {
    let msg = `🤖 *AI Status*\n\n`;
    if (aiReady) {
        msg += `✅ Status: **Ready**\n⚡ Speed: **Fast**\n📦 Model: DistilGPT2 (82MB)\n`;
    } else if (aiLoading) {
        const filled = Math.floor(loadingProgress / 10);
        const empty = 10 - filled;
        const progressBar = '█'.repeat(filled) + '░'.repeat(empty);
        msg += `⏳ Status: **Loading...**\n📊 Progress: ${progressBar} ${loadingProgress}%\n📝 Message: ${loadingMessage}\n`;
    } else {
        msg += `⚠️ Status: **Not Loaded**\n🔄 Retrying...\n`;
    }
    msg += `\n🔄 AI will auto-retry if not ready.`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});
// ============ VIDEO UPLOAD ============

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
        return ctx.reply(`❌ *Video Too Large!*\n\n📦 Your: ${fileSizeMB.toFixed(2)}MB\n📦 Max: ${MAX_FILE_SIZE_MB}MB`);
    }
    
    clearUserTempFiles(userId);
    isUploading = true;
    currentUploader = userId;
    
    const caption = ctx.message.caption || '';
    const lines = caption.split('\n');
    let title = lines[0] || `Video ${Date.now()}`;
    let description = lines.slice(1).join('\n') || title;
    
    const msg = await ctx.reply(`📥 Downloading...\n\n📹 ${title}\n📦 ${fileSizeMB.toFixed(2)} MB\n📊 Remaining: ${remaining - 1}`);
    
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
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        
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
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Error: ${error.message}`);
    }
});

// ============ UPLOAD HANDLERS ============

bot.action('upload_public', async (ctx) => await handleUpload(ctx, 'public'));
bot.action('upload_private', async (ctx) => await handleUpload(ctx, 'private'));
bot.action('upload_schedule', async (ctx) => await handleUpload(ctx, 'scheduled'));

bot.action('upload_cancel', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (session && session.tempFile && fs.existsSync(session.tempFile)) { fs.unlinkSync(session.tempFile); }
    if (session) { session.tempFile = null; session.videoData = null; userSessions.set(userId, session); }
    isUploading = false;
    currentUploader = null;
    await ctx.editMessageText('❌ Cancelled');
    await ctx.answerCbQuery('Cancelled');
});

async function handleUpload(ctx, privacy) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session || !session.tempFile) { isUploading = false; currentUploader = null; return ctx.reply('❌ No video found.'); }
    await ctx.editMessageText(`📤 Uploading (${privacy})...⏳`);
    await ctx.answerCbQuery('Uploading...');
    try {
        const { title, description } = session.videoData;
        const requestBody = {
            snippet: { title: title.substring(0, 100), description: description.substring(0, 5000), categoryId: '22' },
            status: { privacyStatus: privacy === 'scheduled' ? 'private' : privacy, selfDeclaredMadeForKids: false }
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
        if (fs.existsSync(session.tempFile)) { fs.unlinkSync(session.tempFile); }
        session.tempFile = null;
        session.videoData = null;
        userSessions.set(userId, session);
        clearAllTempFiles();
        isUploading = false;
        currentUploader = null;
        const statusText = privacy === 'public' ? '🌐 Public' : privacy === 'private' ? '🔒 Private' : '📅 Scheduled';
        await ctx.editMessageText(`✅ **Upload Successful!**\n\n📹 ${title}\n🔗 https://www.youtube.com/watch?v=${response.data.id}\n📊 ${statusText}\n📤 Remaining: ${getRemainingUploads(session)}\n\nSend another video!`, { parse_mode: 'Markdown' });
    } catch(error) {
        if (session.tempFile && fs.existsSync(session.tempFile)) { fs.unlinkSync(session.tempFile); session.tempFile = null; session.videoData = null; userSessions.set(userId, session); }
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
    // Continue with normal start flow
    const isTelegramMember = await checkTelegramMembership(ctx.from.id);
    if (!isTelegramMember) {
        return ctx.reply(`❌ Join ${REQUIRED_TELEGRAM_CHANNEL} first!`,
            Markup.inlineKeyboard([
                [Markup.button.url('📢 Join', `https://t.me/${REQUIRED_TELEGRAM_CHANNEL.replace('@', '')}`)],
                [Markup.button.callback('✅ Verify', 'verify_telegram')]
            ])
        );
    }
    const session = userSessions.get(userId) || {
        mainAccount: null, subscriptionVerified: false, uploadCount: 0,
        totalUploadsAllowed: MAX_UPLOADS, linkedAccounts: [], telegramVerified: true,
        aiMode: null, analysisMode: null, chatMode: null
    };
    userSessions.set(userId, session);
    if (session.mainAccount && session.mainAccount.authenticated) {
        await showMainMenu(ctx, userId);
    } else {
        const authUrl = `${REDIRECT_URI.replace('/oauth2callback', '/auth')}?userId=${userId}`;
        await ctx.reply(`✅ Verified!\n\nLogin with YouTube:`,
            Markup.inlineKeyboard([[Markup.button.url('🔑 Login', authUrl)]])
        );
    }
});

// ============ START SERVER ============

async function startServer() {
    console.log('🚀 Starting YouTube Bot...');
    console.log('⏳ Loading AI...');
    
    const progressInterval = setInterval(() => {
        if (aiLoading) {
            const filled = Math.floor(loadingProgress / 10);
            const empty = 10 - filled;
            const bar = '█'.repeat(filled) + '░'.repeat(empty);
            console.log(`⏳ AI: ${bar} ${loadingProgress}% - ${loadingMessage}`);
        } else if (aiReady) {
            console.log('✅ AI Ready!');
            clearInterval(progressInterval);
        }
    }, 5000);
    
    let attempts = 0;
    while (!aiReady && attempts < 60) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
        if (attempts % 10 === 0 && !aiReady && !aiLoading) {
            console.log('⚠️ AI not loading, restarting...');
            loadAI();
        }
    }
    clearInterval(progressInterval);
    
    if (aiReady) {
        console.log('✅ AI is ready!');
    } else {
        console.log('⚠️ AI is loading in background...');
    }
    
    bot.launch().then(() => {
        console.log('🤖 Bot started!');
        console.log(`📦 Max file size: ${MAX_FILE_SIZE_MB}MB`);
    });
    
    app.listen(PORT, () => {
        console.log(`🌐 Server on port ${PORT}`);
        console.log(`🔗 OAuth: ${REDIRECT_URI}`);
        console.log(`🧠 AI Status: ${aiReady ? '✅ Ready' : '⏳ Loading...'}`);
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
    console.log(`🧠 AI: ${aiReady ? '✅ Fast & Ready' : '⏳ Loading in background'}`);
    console.log(`🆘 Contact: ${DEVELOPER_CONTACT}`);
}

// Start server
startServer().catch(error => {
    console.error('❌ Failed to start:', error);
    bot.launch().then(() => console.log('🤖 Bot started (without AI)'));
    app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));
});
