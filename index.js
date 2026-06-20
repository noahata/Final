const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');
const { HfInference } = require('@huggingface/inference');

// ============ CREDENTIALS ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = '39782137338-leo8rmrpic812o2klvsrmgk84o10d4j4.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'https://final-boss-jnl3.onrender.com/oauth2callback';

// ============ HF TOKEN ============
const HF_TOKEN = process.env.HF_TOKEN || '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';
const hf = new HfInference(HF_TOKEN);

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

// ============ SPONSOR CONFIG ============
const SPONSOR_CHANNEL = 'SniAdsEarnBot';
const SPONSOR_LINK = 'https://t.me/SniAdsEarnBot/app?startapp=6596414316';

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

// ============ AI READY ============
let aiReady = true;
let loadingProgress = 100;
let loadingMessage = '✅ Ready (API)';

// ============ AI FUNCTIONS ============

async function chatWithAI(userMessage) {
    try {
        const result = await hf.textGeneration({
            model: 'distilgpt2',
            inputs: `User: ${userMessage}\nAssistant:`,
            parameters: { max_new_tokens: 100, temperature: 0.8, do_sample: true, top_k: 50 }
        });
        let response = result.generated_text || '';
        response = response.replace(`User: ${userMessage}\nAssistant:`, '').trim();
        return response || "Got it!";
    } catch(e) {
        console.error('Chat error:', e.message);
        return "⚠️ AI error. Try again.";
    }
}

async function summarizeContent(text) {
    try {
        const result = await hf.textGeneration({
            model: 'distilgpt2',
            inputs: `Summary: ${text.substring(0, 200)}\n`,
            parameters: { max_new_tokens: 80, temperature: 0.5 }
        });
        return result.generated_text?.replace(`Summary: ${text.substring(0, 200)}\n`, '').trim() || "Summarized!";
    } catch(e) {
        return "Quick summary: " + text.substring(0, 100) + "...";
    }
}

async function getAIAdvice(topic) {
    try {
        const result = await hf.textGeneration({
            model: 'distilgpt2',
            inputs: `Advice for ${topic}:`,
            parameters: { max_new_tokens: 80, temperature: 0.7 }
        });
        return result.generated_text?.replace(`Advice for ${topic}:`, '').trim() || "Keep going!";
    } catch(e) {
        return "💡 Stay consistent and engage with your audience!";
    }
}

async function generateTitles(topic, keywords = []) {
    try {
        const result = await hf.textGeneration({
            model: 'distilgpt2',
            inputs: `Titles for ${topic}:`,
            parameters: { max_new_tokens: 80, temperature: 0.9 }
        });
        const generated = result.generated_text || '';
        const titles = generated.split('\n')
            .filter(l => l.trim().length > 5)
            .slice(0, 3)
            .map(l => l.replace(/^\d+\.\s*/, '').trim());
        return titles.length > 0 ? titles : [`${topic} - Amazing!`, `${topic} - Best Ever!`, `${topic} - Must Watch!`];
    } catch(e) {
        return [`${topic} - Best Video!`, `${topic} - Amazing!`, `${topic} - Must Watch!`];
    }
}

async function generateDescription(topic, keywords = [], title = '') {
    try {
        const result = await hf.textGeneration({
            model: 'distilgpt2',
            inputs: `Description for ${title}:`,
            parameters: { max_new_tokens: 100, temperature: 0.8 }
        });
        return result.generated_text?.replace(`Description for ${title}:`, '').trim() || `Amazing ${topic} video! Watch now! 🔥`;
    } catch(e) {
        return `🔥 Amazing ${topic} video! Subscribe for more!`;
    }
}

async function generateTags(topic, keywords = []) {
    try {
        const result = await hf.textGeneration({
            model: 'distilgpt2',
            inputs: `Tags for ${topic}:`,
            parameters: { max_new_tokens: 60, temperature: 0.7 }
        });
        const generated = result.generated_text?.replace(`Tags for ${topic}:`, '').trim() || '';
        const tags = generated.split(/\s+/).filter(t => t.startsWith('#')).slice(0, 5);
        return tags.length > 0 ? tags : [`#${topic}`, `#${topic}Video`, `#Trending`];
    } catch(e) {
        return [`#${topic}`, `#${topic}Video`, `#Trending`, `#Viral`, `#Shorts`];
    }
}

// ============ SPONSOR HTML PAGE ============
app.get('/sponsor', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Sponsor - YouTube Upload Bot</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; background: #0d1117; color: #fff; }
                    .container { max-width: 600px; margin: 0 auto; background: #161b22; padding: 40px; border-radius: 16px; }
                    h1 { color: #58a6ff; }
                    .sponsor-box { background: #1c2333; padding: 20px; border-radius: 12px; margin: 20px 0; border: 1px solid #30363d; }
                    .btn { display: inline-block; background: #238636; color: #fff; padding: 12px 30px; text-decoration: none; border-radius: 8px; margin: 10px; }
                    .btn:hover { background: #2ea043; }
                    .btn-telegram { background: #0088cc; }
                    .btn-telegram:hover { background: #0099dd; }
                    .btn-youtube { background: #ff0000; }
                    .btn-youtube:hover { background: #cc0000; }
                    .footer { margin-top: 30px; color: #8b949e; font-size: 14px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🎬 YouTube Upload Bot</h1>
                    <p>Support the bot by joining our channels!</p>
                    
                    <div class="sponsor-box">
                        <h2>📢 Join Telegram Channel</h2>
                        <p>Get updates, tips, and support</p>
                        <a href="https://t.me/${SPONSOR_CHANNEL.replace('@', '')}" class="btn btn-telegram" target="_blank">Join Telegram</a>
                    </div>
                    
                    <div class="sponsor-box">
                        <h2>📺 Subscribe to YouTube</h2>
                        <p>Watch tutorials and content</p>
                        <a href="https://www.youtube.com/${REQUIRED_YOUTUBE_CHANNEL_NAME}" class="btn btn-youtube" target="_blank">Subscribe</a>
                    </div>
                    
                    <div class="sponsor-box">
                        <h2>👥 Invite Friends</h2>
                        <p>Share the bot with your friends!</p>
                        <a href="https://t.me/share/url?url=https://t.me/${process.env.BOT_USERNAME || 'your_bot'}&text=Join this bot to upload videos to YouTube!" class="btn" target="_blank">Share Bot</a>
                    </div>
                    
                    <div class="footer">
                        <p>💡 After joining, send /start to the bot</p>
                        <p>Contact: ${DEVELOPER_CONTACT}</p>
                    </div>
                </div>
            </html>
        `);
});

// ============ EXPRESS ROUTES ============

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>YouTube Upload Bot</title></head>
            <body style="font-family:Arial;text-align:center;padding:50px;background:#0d1117;color:#fff;">
                <h1>🎬 YouTube Upload Bot</h1>
                <p>Bot is running!</p>
                <p>Users: ${userSessions.size}</p>
                <p>AI: ${aiReady ? '✅ Ready' : '⏳ Loading'}</p>
                <p>Max file: ${MAX_FILE_SIZE_MB}MB</p>
                <p><a href="/auth" style="color:#58a6ff;">Login with YouTube</a></p>
                <p><a href="/sponsor" style="color:#58a6ff;">Support Us</a></p>
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
    res.json({
        status: 'ok',
        ai: aiReady ? 'ready' : 'loading',
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
        scope: [
            'https://www.googleapis.com/auth/youtube.upload',
            'https://www.googleapis.com/auth/youtube',
            'https://www.googleapis.com/auth/youtube.readonly'
        ],
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
            <html>
                <head><title>Login Successful</title></head>
                <body style="font-family:Arial;text-align:center;padding:50px;background:#0d1117;color:#fff;">
                    <h1 style="color:#58a6ff;">✅ Login Successful!</h1>
                    <p>Channel: <strong>${channelName}</strong></p>
                    <p>Max file: ${MAX_FILE_SIZE_MB}MB</p>
                    <p>Send <strong>/start</strong> to the bot.</p>
                    <p><a href="/" style="color:#58a6ff;">Go Home</a> | <a href="/sponsor" style="color:#58a6ff;">Support Us</a></p>
                </body>
            </html>
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
            aiMode: null, analysisMode: null, chatMode: null, sponsorVerified: false
        });
    }
    const session = userSessions.get(userId);
    
    // Check sponsor (mini-app)
    if (!session.sponsorVerified) {
        return ctx.reply(
            `❌ *Please open our sponsor app first!*\n\n` +
            `📱 ${SPONSOR_CHANNEL}\n\n` +
            `Tap the button below to open the mini‑app, then click "I've opened it" to verify.`,
            Markup.inlineKeyboard([
                [Markup.button.url('📱 Open Sponsor App', SPONSOR_LINK)],
                [Markup.button.callback('✅ I\'ve opened it', 'verify_sponsor')]
            ]),
            { parse_mode: 'Markdown' }
        );
    }
    
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
    
    if (session.mainAccount && session.mainAccount.authenticated) {
        await showMainMenu(ctx, userId);
        return;
    }
    const authUrl = `${REDIRECT_URI.replace('/oauth2callback', '/auth')}?userId=${userId}`;
    await ctx.reply(
        `✅ Verified!\n\nLogin with YouTube:`,
        Markup.inlineKeyboard([[Markup.button.url('🔑 Login with YouTube', authUrl)]])
    );
});

// ============ SHOW MAIN MENU ============

async function showMainMenu(ctx, userId) {
    const session = userSessions.get(userId);
    if (!session || !session.mainAccount || !session.mainAccount.authenticated) {
        return ctx.reply('❌ Please login first.');
    }
    const remaining = getRemainingUploads(session);
    const inviteCount = inviteTracker.has(userId) ? inviteTracker.get(userId).invitedUsers.length : 0;
    
    let msg = `👋 *${session.mainAccount?.channelName || 'User'}*\n\n`;
    msg += `📤 Uploads: ${session.uploadCount || 0}/${session.totalUploadsAllowed}\n`;
    msg += `📊 Remaining: ${remaining}\n👥 Invites: ${inviteCount}\n`;
    msg += `📦 Max file: ${MAX_FILE_SIZE_MB}MB\n🤖 AI: ✅ Ready\n\n💬 *Chat, Summarize, Get Advice!*`;
    
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
    await ctx.editMessageText(
        `🆘 *Contact Developer*\n\n👨‍💻 ${DEVELOPER_CONTACT}`,
        Markup.inlineKeyboard([
            [Markup.button.url('📩 Contact', `https://t.me/${DEVELOPER_CONTACT.replace('@', '')}`)],
            [Markup.button.callback('🔙 Back', 'back_to_menu')]
        ]),
        { parse_mode: 'Markdown' }
    );
});

bot.action('verify_telegram', async (ctx) => {
    const isMember = await checkTelegramMembership(ctx.from.id);
    const userId = ctx.from.id.toString();
    if (isMember) {
        const session = userSessions.get(userId);
        if (session) session.telegramVerified = true;
        await ctx.editMessageText(
            `✅ Verified! Login with YouTube.`,
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

bot.action('invite', async (ctx) => {
    const userId = ctx.from.id.toString();
    const botUsername = ctx.botInfo.username;
    const inviteLink = `https://t.me/${botUsername}?start=ref_${userId}`;
    const inviteCount = inviteTracker.has(userId) ? inviteTracker.get(userId).invitedUsers.length : 0;
    await ctx.editMessageText(
        `👥 *Invite Friends*\n\n+${INVITE_BONUS} upload per invite!\n📊 ${inviteCount}\n\n🔗 ${inviteLink}`,
        Markup.inlineKeyboard([
            [Markup.button.url('📤 Share', `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=Join this bot!`)],
            [Markup.button.callback('🔙 Back', 'back_to_menu')]
        ]),
        { parse_mode: 'Markdown' }
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
        
        let msg = `📊 *Status*\n\n📺 ${session.mainAccount.channelName}\n👥 ${formatNumber(parseInt(stats.subscriberCount || 0))}\n🎬 ${formatNumber(parseInt(stats.videoCount || 0))}\n👁️ ${formatNumber(parseInt(stats.viewCount || 0))}\n\n📤 ${session.uploadCount || 0}/${session.totalUploadsAllowed}\n📊 Remaining: ${remaining}\n👥 Invites: ${inviteCount}\n✅ ${session.subscriptionVerified ? 'Subscribed' : 'Not subscribed'}\n📦 Max: ${MAX_FILE_SIZE_MB}MB\n🤖 AI: ✅ Ready`;
        
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
