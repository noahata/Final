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

// ============ SPONSOR CONFIG (Green Apple) ============
const SPONSOR_NAME = 'Green Apple 🍏';
const SPONSOR_LINK = 'https://t.me/GreenAppletgBot/play?startapp=6596414316';
const SPONSOR_LOGO = 'https://via.placeholder.com/100x100/4CAF50/FFFFFF?text=🍏';
const SPONSOR_DESCRIPTION = 'Support our sponsor by trying Green Apple!';
const SPONSORS = [];
const BROADCAST_HISTORY = [];

// ============ GREEN APPLE CONFIG ============
const GREEN_APPLE_TOKENS = new Map();
const YOUR_BOT_USERNAME = process.env.BOT_USERNAME || 'final_boss_bot';

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

// ============ EXPRESS ROUTES ============

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>YouTube Upload Bot</title></head>
            <body style="font-family:Arial;text-align:center;padding:50px;background:#0d1117;color:#fff;">
                <h1 style="color:#58a6ff;">🎬 YouTube Upload Bot</h1>
                <p>Bot is running!</p>
                <p>Users: ${userSessions.size}</p>
                <p>AI: ${aiReady ? '✅ Ready' : '⏳ Loading'}</p>
                <p>Max file: ${MAX_FILE_SIZE_MB}MB</p>
                <p><a href="/auth" style="color:#58a6ff;">Login with YouTube</a></p>
                <p><a href="/sponsor" style="color:#58a6ff;">Support Us</a></p>
                <p><a href="/admin" style="color:#58a6ff;">Admin Panel</a></p>
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
                linkedAccounts: [], telegramVerified: false, aiMode: null, analysisMode: null, chatMode: null,
                greenAppleVerified: false, greenAppleToken: null, greenAppleTokenGeneratedAt: null
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

// ============ GREEN APPLE FUNCTIONS ============

function generateGreenAppleLink(userId) {
    const token = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    const session = userSessions.get(userId);
    if (session) {
        session.greenAppleToken = token;
        session.greenAppleTokenGeneratedAt = Date.now();
        userSessions.set(userId, session);
    }
    greenAppleTokens.set(token, {
        userId: userId,
        timestamp: Date.now(),
        verified: false
    });
    const callbackUrl = `https://final-boss-jnl3.onrender.com/api/greenapple/verify?token=${token}&user=${userId}`;
    const encodedCallback = encodeURIComponent(callbackUrl);
    return `https://t.me/GreenAppletgBot/play?startapp=${token}&callback=${encodedCallback}`;
}

async function showGreenAppleVerification(ctx, userId) {
    const verifyLink = generateGreenAppleLink(userId);
    await ctx.reply(
        `🍏 *Sponsor Verification Required*\n\n` +
        `To use this bot, please support our sponsor:\n\n` +
        `1️⃣ Click the button below to open Green Apple\n` +
        `2️⃣ Wait for the app to load\n` +
        `3️⃣ You'll be automatically verified\n` +
        `4️⃣ Return to this bot\n\n` +
        `⚠️ Link expires in 10 minutes.`,
        Markup.inlineKeyboard([
            [Markup.button.url('🍏 Open & Verify', verifyLink)],
            [Markup.button.callback('✅ I\'m Verified', 'green_apple_verified_check')],
            [Markup.button.callback('❌ Cancel', 'green_apple_cancel')]
        ]),
        { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
}

async function continueStartFlow(ctx, userId) {
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
    if (session.mainAccount && session.mainAccount.authenticated) {
        await showMainMenu(ctx, userId);
        return;
    }
    const authUrl = `${REDIRECT_URI.replace('/oauth2callback', '/auth')}?userId=${userId}`;
    await ctx.reply(
        `✅ Sponsor Verified!\n\nNow login with YouTube to start uploading.`,
        Markup.inlineKeyboard([[Markup.button.url('🔑 Login with YouTube', authUrl)]])
    );
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
    [Markup.button.callback('✅ Verify Subscription', 'verify_subscription')],
    [Markup.button.callback('🍏 Sponsor', 'green_apple_sponsor')],
    [Markup.button.callback('🆘 Contact', 'contact_developer')],
    [Markup.button.callback('🚪 Logout', 'logout')]
]);

const aiMenu = Markup.inlineKeyboard([
    [Markup.button.callback('🎯 AI Titles', 'ai_title')],
    [Markup.button.callback('📝 AI Description', 'ai_desc')],
    [Markup.button.callback('🏷️ AI Tags', 'ai_tags')],
    [Markup.button.callback('🔙 Back', 'back_to_menu')]
]);

// ============ BOT START ============

bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    let session = userSessions.get(userId);
    if (!session) {
        session = {
            mainAccount: null, subscriptionVerified: false, uploadCount: 0,
            totalUploadsAllowed: MAX_UPLOADS, linkedAccounts: [], telegramVerified: false,
            aiMode: null, analysisMode: null, chatMode: null,
            greenAppleVerified: false, greenAppleToken: null, greenAppleTokenGeneratedAt: null
        };
        userSessions.set(userId, session);
    }
    const text = ctx.message.text || '';
    const refMatch = text.match(/\/start\s+greenapple_(\w+)/);
    if (refMatch) {
        const token = refMatch[1];
        const tokenData = greenAppleTokens.get(token);
        if (tokenData && !tokenData.verified) {
            tokenData.verified = true;
            greenAppleTokens.set(token, tokenData);
            session.greenAppleVerified = true;
            session.greenAppleVerifiedAt = new Date();
            userSessions.set(userId, session);
            await ctx.reply(`✅ *Green Apple Verified!*\n\nThank you for supporting our sponsor! 🎉\n\nContinuing...`, { parse_mode: 'Markdown' });
            await continueStartFlow(ctx, userId);
            return;
        } else {
            await ctx.reply(`❌ *Invalid or Expired Token*\n\nPlease request a new verification link.`, { parse_mode: 'Markdown' });
            await showGreenAppleVerification(ctx, userId);
            return;
        }
    }
    if (session.greenAppleVerified) {
        await continueStartFlow(ctx, userId);
        return;
    }
    if (session.greenAppleToken) {
        const tokenData = greenAppleTokens.get(session.greenAppleToken);
        if (tokenData && !tokenData.verified) {
            if (Date.now() - tokenData.timestamp < 600000) {
                await ctx.reply(
                    `⏳ *Verification Pending*\n\nPlease open Green Apple using the link below.\n\n⏰ Link expires in ${Math.round((600000 - (Date.now() - tokenData.timestamp)) / 60000)} minutes.`,
                    Markup.inlineKeyboard([
                        [Markup.button.url('🍏 Open & Verify', generateGreenAppleLink(userId))],
                        [Markup.button.callback('🔄 Check Again', 'green_apple_verified_check')],
                        [Markup.button.callback('❌ Cancel', 'green_apple_cancel')]
                    ]),
                    { parse_mode: 'Markdown' }
                );
                return;
            } else {
                greenAppleTokens.delete(session.greenAppleToken);
                session.greenAppleToken = null;
                session.greenAppleTokenGeneratedAt = null;
                userSessions.set(userId, session);
            }
        }
    }
    await showGreenAppleVerification(ctx, userId);
});

// ============ GREEN APPLE BUTTON HANDLERS ============

bot.action('green_apple_verified_check', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (session && session.greenAppleVerified) {
        await ctx.editMessageText(`✅ *Verification Confirmed!*\n\nContinuing...`, { parse_mode: 'Markdown' });
        await continueStartFlow(ctx, userId);
    } else {
        await ctx.editMessageText(
            `⏳ *Not Verified Yet*\n\nPlease open Green Apple using the link below.`,
            Markup.inlineKeyboard([
                [Markup.button.url('🍏 Open & Verify', generateGreenAppleLink(userId))],
                [Markup.button.callback('🔄 Check Again', 'green_apple_verified_check')],
                [Markup.button.callback('❌ Cancel', 'green_apple_cancel')]
            ]),
            { parse_mode: 'Markdown' }
        );
    }
    await ctx.answerCbQuery();
});

bot.action('green_apple_cancel', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (session) {
        if (session.greenAppleToken) {
            greenAppleTokens.delete(session.greenAppleToken);
            session.greenAppleToken = null;
            session.greenAppleTokenGeneratedAt = null;
        }
        userSessions.set(userId, session);
    }
    await ctx.editMessageText(`❌ *Verification Cancelled*\n\nYou can try again anytime by sending /start.`, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery('Cancelled');
});

bot.action('green_apple_sponsor', async (ctx) => {
    await ctx.reply(
        `🍏 *${SPONSOR_NAME}*\n\nSupport our sponsor by trying Green Apple!\n\nClick below to open.`,
        Markup.inlineKeyboard([
            [Markup.button.url('🍏 Open Green Apple', SPONSOR_LINK)],
            [Markup.button.callback('🔙 Back', 'back_to_menu')]
        ]),
        { parse_mode: 'Markdown' }
    );
});
