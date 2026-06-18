‎const { Telegraf, Markup } = require('telegraf');
‎const { google } = require('googleapis');
‎const express = require('express');
‎const fs = require('fs');
‎const path = require('path');
‎const axios = require('axios');
‎const session = require('express-session');
‎const cors = require('cors');
‎const { HfInference } = require('@huggingface/inference');
‎
‎
‎const BOT_TOKEN = process.env.BOT_TOKEN;
‎const CLIENT_ID = '39782137338-leo8rmrpic812o2klvsrmgk84o10d4j4.apps.googleusercontent.com';
‎const CLIENT_SECRET = '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';
‎const REDIRECT_URI = 'https://final-boss-jnl3.onrender.com/oauth2callback';
‎
‎
‎const HF_TOKEN = process.env.HF_TOKEN || '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';
‎const hf = new HfInference(HF_TOKEN);
‎
‎
‎const API_KEYS = [
‎    'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg',
‎    'AIzaSyAXzQXd0AONNgSI8E6D5_BeweMqyz4iGTg',
‎    'AIzaSyDjLVpU8M9VFBAuj-_pvSyDW1BbUfCjyIY'
‎];
‎
‎
‎const REQUIRED_TELEGRAM_CHANNEL = '@bot_Farming';
‎const REQUIRED_YOUTUBE_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
‎const REQUIRED_YOUTUBE_CHANNEL_NAME = '@Noah_Technical';
‎const MAX_UPLOADS = 10;
‎const INVITE_BONUS = 1;
‎const INVITES_TO_ADD_ACCOUNT = 5;
‎const DEVELOPER_CONTACT = '@Ace_spy';
‎const MAX_FILE_SIZE_MB = 300;
‎
‎
‎
‎const SPONSOR_NAME = 'Green Apple';
‎const SPONSOR_LINK = 'https://t.me/GreenAppletgBot/play?startapp=6596414316';
‎const SPONSORS = [];
‎const BROADCAST_HISTORY = [];
‎
‎
‎const GREEN_APPLE_TOKENS = new Map();
‎const YOUR_BOT_USERNAME = process.env.BOT_USERNAME || 'final_boss_bot';
‎
‎
‎const PORT = process.env.PORT || 3000;
‎const app = express();
‎
‎app.use(cors());
‎app.use(session({
‎    secret: 'youtube_upload_secret_2024',
‎    resave: false,
‎    saveUninitialized: true,
‎    cookie: { secure: false }
‎}));
‎app.use(express.json());
‎app.use(express.urlencoded({ extended: true }));
‎
‎
‎const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
‎const userSessions = new Map();
‎const inviteTracker = new Map();
‎let isUploading = false;
‎let currentUploader = null;
‎
‎const TEMP_DIR = '/tmp/youtube_uploads';
‎if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
‎
‎
‎let aiReady = true;
‎let loadingProgress = 100;
‎let loadingMessage = '✅ Ready (API)';
‎
‎
‎
‎async function chatWithAI(userMessage) {
‎    try {
‎        const result = await hf.textGeneration({
‎            model: 'distilgpt2',
‎            inputs: `User: ${userMessage}\nAssistant:`,
‎            parameters: { max_new_tokens: 100, temperature: 0.8, do_sample: true, top_k: 50 }
‎        });
‎        let response = result.generated_text || '';
‎        response = response.replace(`User: ${userMessage}\nAssistant:`, '').trim();
‎        return response || "Got it!";
‎    } catch(e) {
‎        console.error('Chat error:', e.message);
‎        return "⚠️ AI error. Try again.";
‎    }
‎}
‎
‎async function summarizeContent(text) {
‎    try {
‎        const result = await hf.textGeneration({
‎            model: 'distilgpt2',
‎            inputs: `Summary: ${text.substring(0, 200)}\n`,
‎            parameters: { max_new_tokens: 80, temperature: 0.5 }
‎        });
‎        return result.generated_text?.replace(`Summary: ${text.substring(0, 200)}\n`, '').trim() || "Summarized!";
‎    } catch(e) {
‎        return "Quick summary: " + text.substring(0, 100) + "...";
‎    }
‎}
‎
‎async function getAIAdvice(topic) {
‎    try {
‎        const result = await hf.textGeneration({
‎            model: 'distilgpt2',
‎            inputs: `Advice for ${topic}:`,
‎            parameters: { max_new_tokens: 80, temperature: 0.7 }
‎        });
‎        return result.generated_text?.replace(`Advice for ${topic}:`, '').trim() || "Keep going!";
‎    } catch(e) {
‎        return "💡 Stay consistent and engage with your audience!";
‎    }
‎}
‎
‎async function generateTitles(topic, keywords = []) {
‎    try {
‎        const result = await hf.textGeneration({
‎            model: 'distilgpt2',
‎            inputs: `Titles for ${topic}:`,
‎            parameters: { max_new_tokens: 80, temperature: 0.9 }
‎        });
‎        const generated = result.generated_text || '';
‎        const titles = generated.split('\n')
‎            .filter(l => l.trim().length > 5)
‎            .slice(0, 3)
‎            .map(l => l.replace(/^\d+\.\s*/, '').trim());
‎        return titles.length > 0 ? titles : [`${topic} - Amazing!`, `${topic} - Best Ever!`, `${topic} - Must Watch!`];
‎    } catch(e) {
‎        return [`${topic} - Best Video!`, `${topic} - Amazing!`, `${topic} - Must Watch!`];
‎    }
‎}
‎
‎async function generateDescription(topic, keywords = [], title = '') {
‎    try {
‎        const result = await hf.textGeneration({
‎            model: 'distilgpt2',
‎            inputs: `Description for ${title}:`,
‎            parameters: { max_new_tokens: 100, temperature: 0.8 }
‎        });
‎        return result.generated_text?.replace(`Description for ${title}:`, '').trim() || `Amazing ${topic} video! Watch now! 🔥`;
‎    } catch(e) {
‎        return `🔥 Amazing ${topic} video! Subscribe for more!`;
‎    }
‎}
‎
‎async function generateTags(topic, keywords = []) {
‎    try {
‎        const result = await hf.textGeneration({
‎            model: 'distilgpt2',
‎            inputs: `Tags for ${topic}:`,
‎            parameters: { max_new_tokens: 60, temperature: 0.7 }
‎        });
‎        const generated = result.generated_text?.replace(`Tags for ${topic}:`, '').trim() || '';
‎        const tags = generated.split(/\s+/).filter(t => t.startsWith('#')).slice(0, 5);
‎        return tags.length > 0 ? tags : [`#${topic}`, `#${topic}Video`, `#Trending`];
‎    } catch(e) {
‎        return [`#${topic}`, `#${topic}Video`, `#Trending`, `#Viral`, `#Shorts`];
‎    }
‎}
‎
‎
‎
‎app.get('/', (req, res) => {
‎    res.send(`
‎        <html>
‎            <head><title>YouTube Upload Bot</title></head>
‎            <body style="font-family:Arial;text-align:center;padding:50px;background:#0d1117;color:#fff;">
‎                <h1 style="color:#58a6ff;">🎬 YouTube Upload Bot</h1>
‎                <p>Bot is running!</p>
‎                <p>Users: ${userSessions.size}</p>
‎                <p>AI: ${aiReady ? '✅ Ready' : '⏳ Loading'}</p>
‎                <p>Max file: ${MAX_FILE_SIZE_MB}MB</p>
‎                <p><a href="/auth" style="color:#58a6ff;">Login with YouTube</a></p>
‎                <p><a href="/sponsor" style="color:#58a6ff;">Support Us</a></p>
‎                <p><a href="/admin" style="color:#58a6ff;">Admin Panel</a></p>
‎                <p>Contact: ${DEVELOPER_CONTACT}</p>
‎            </body>
‎        </html>
‎    `);
‎});
‎
‎app.get('/health', (req, res) => {
‎    const tempFiles = fs.readdirSync(TEMP_DIR);
‎    let totalSize = 0;
‎    for (const file of tempFiles) {
‎        const filePath = path.join(TEMP_DIR, file);
‎        const stats = fs.statSync(filePath);
‎        totalSize += stats.size;
‎    }
‎    res.json({
‎        status: 'ok',
‎        ai: aiReady ? 'ready' : 'loading',
‎        sessions: userSessions.size,
‎        tempFiles: tempFiles.length,
‎        tempSizeMB: (totalSize / 1024 / 1024).toFixed(2),
‎        isUploading: isUploading,
‎        maxFileSizeMB: MAX_FILE_SIZE_MB
‎    });
‎});
‎
‎
‎
‎app.get('/auth', (req, res) => {
‎    const userId = req.query.userId || req.session.userId || 'default';
‎    if (userId) req.session.userId = userId;
‎    const authUrl = oauth2Client.generateAuthUrl({
‎        access_type: 'offline',
‎        scope: [
‎            'https://www.googleapis.com/auth/youtube.upload',
‎            'https://www.googleapis.com/auth/youtube',
‎            'https://www.googleapis.com/auth/youtube.readonly'
‎        ],
‎        prompt: 'consent',
‎        state: userId
‎    });
‎    res.redirect(authUrl);
‎});
‎
‎app.get('/oauth2callback', async (req, res) => {
‎    const { code, state } = req.query;
‎    if (!code) return res.send('❌ No code received');
‎    try {
‎        const { tokens } = await oauth2Client.getToken(code);
‎        oauth2Client.setCredentials(tokens);
‎        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
‎        const channelRes = await youtube.channels.list({ part: 'snippet', mine: true });
‎        if (!channelRes.data.items || channelRes.data.items.length === 0) {
‎            return res.send('❌ No YouTube channel found');
‎        }
‎        const channelId = channelRes.data.items[0].id;
‎        const channelName = channelRes.data.items[0].snippet.title;
‎        const userId = state || req.session.userId || 'default';
‎        
‎        if (!userSessions.has(userId)) {
‎            userSessions.set(userId, {
‎                mainAccount: { channelId, channelName, oauthClient: oauth2Client, youtube, tokens, authenticated: true },
‎                subscriptionVerified: false, uploadCount: 0, totalUploadsAllowed: MAX_UPLOADS,
‎                linkedAccounts: [], telegramVerified: false, aiMode: null, analysisMode: null, chatMode: null,
‎                greenAppleVerified: false, greenAppleToken: null, greenAppleTokenGeneratedAt: null
‎            });
‎        } else {
‎            const session = userSessions.get(userId);
‎            session.mainAccount = { channelId, channelName, oauthClient: oauth2Client, youtube, tokens, authenticated: true };
‎            userSessions.set(userId, session);
‎        }
‎        
‎        try {
‎            await bot.telegram.sendMessage(userId, `✅ **YouTube Login Successful!**\n\n📺 Channel: ${channelName}\n📦 Max file: ${MAX_FILE_SIZE_MB}MB\n\nSend /start to see the menu.`, { parse_mode: 'Markdown' });
‎        } catch(e) { console.log('Could not send message:', e.message); }
‎        
‎        res.send(`
‎            <html>
‎                <head><title>Login Successful</title></head>
‎                <body style="font-family:Arial;text-align:center;padding:50px;background:#0d1117;color:#fff;">
‎                    <h1 style="color:#58a6ff;">✅ Login Successful!</h1>
‎                    <p>Channel: <strong>${channelName}</strong></p>
‎                    <p>Max file: ${MAX_FILE_SIZE_MB}MB</p>
‎                    <p>Send <strong>/start</strong> to the bot.</p>
‎                    <p><a href="/" style="color:#58a6ff;">Go Home</a> | <a href="/sponsor" style="color:#58a6ff;">Support Us</a></p>
‎                </body>
‎            </html>
‎        `);
‎    } catch(error) {
‎        console.error('OAuth error:', error);
‎        res.send(`❌ Login failed: ${error.message}`);
‎    }
‎});
‎
‎
‎const bot = new Telegraf(BOT_TOKEN);
‎
‎
‎let currentKey = 0;
‎let keyUsage = [0, 0, 0];
‎let keyReset = [Date.now(), Date.now(), Date.now()];
‎
‎function getApiKey() {
‎    const now = Date.now();
‎    const ONE_DAY = 86400000;
‎    for(let i = 0; i < API_KEYS.length; i++) {
‎        if(now - keyReset[i] > ONE_DAY) { keyUsage[i] = 0; keyReset[i] = now; }
‎        if(keyUsage[i] < 9000) { currentKey = i; keyUsage[i]++; return API_KEYS[i]; }
‎    }
‎    return null;
‎}
‎
‎function getYoutube() {
‎    const key = getApiKey();
‎    if (!key) return null;
‎    return google.youtube({ version: 'v3', auth: key });
‎}
‎
‎
‎
‎function clearAllTempFiles() {
‎    const files = fs.readdirSync(TEMP_DIR);
‎    let deleted = 0;
‎    for (const file of files) {
‎        const filePath = path.join(TEMP_DIR, file);
‎        try { fs.unlinkSync(filePath); deleted++; } catch(e) {}
‎    }
‎    if (deleted > 0) console.log(`🗑️ Cleared ${deleted} temp files`);
‎}
‎
‎function clearUserTempFiles(userId) {
‎    const files = fs.readdirSync(TEMP_DIR);
‎    let deleted = 0;
‎    for (const file of files) {
‎        if (file.startsWith(userId)) {
‎            const filePath = path.join(TEMP_DIR, file);
‎            try { fs.unlinkSync(filePath); deleted++; } catch(e) {}
‎        }
‎    }
‎    return deleted;
‎}
‎
‎
‎
‎async function checkYouTubeSubscriptionWithApi(channelId) {
‎    try {
‎        const youtube = getYoutube();
‎        if (!youtube) return false;
‎        const response = await youtube.subscriptions.list({ part: 'snippet', channelId: channelId, forChannelId: REQUIRED_YOUTUBE_CHANNEL_ID });
‎        return response.data.items && response.data.items.length > 0;
‎    } catch(error) { return false; }
‎}
‎
‎async function checkTelegramMembership(userId) {
‎    try {
‎        const chatMember = await bot.telegram.getChatMember(REQUIRED_TELEGRAM_CHANNEL, userId);
‎        return chatMember.status === 'member' || chatMember.status === 'administrator' || chatMember.status === 'creator';
‎    } catch(e) { return false; }
‎}
‎
‎function trackInvite(inviterId, inviteeId) {
‎    if (!inviteTracker.has(inviterId)) {
‎        inviteTracker.set(inviterId, { invitedBy: null, invitedUsers: [] });
‎    }
‎    const inviterData = inviteTracker.get(inviterId);
‎    if (!inviterData.invitedUsers.includes(inviteeId)) {
‎        inviterData.invitedUsers.push(inviteeId);
‎        inviteTracker.set(inviterId, inviterData);
‎        return true;
‎    }
‎    return false;
‎}
‎
‎function getRemainingUploads(session) {
‎    const totalAllowed = session.totalUploadsAllowed || MAX_UPLOADS;
‎    const used = session.uploadCount || 0;
‎    return Math.max(0, totalAllowed - used);
‎}
‎
‎function formatNumber(num) {
‎    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
‎}
‎
‎function parseDuration(duration) {
‎    const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
‎    const hours = (match[1] || '').replace('H', '') || 0;
‎    const minutes = (match[2] || '').replace('M', '') || 0;
‎    const seconds = (match[3] || '').replace('S', '') || 0;
‎    return `${hours}h ${minutes}m ${seconds}s`;
‎}
‎
‎
‎
‎class Sponsor {
‎    constructor(name, link, logo, description, tier, price) {
‎        this.id = Date.now() + Math.random() * 1000;
‎        this.name = name;
‎        this.link = link;
‎        this.logo = logo || 'https://via.placeholder.com/100x100?text=Logo';
‎        this.description = description || 'Sponsor';
‎        this.tier = tier || 'Basic';
‎        this.price = price || 0;
‎        this.addedAt = new Date();
‎        this.active = true;
‎    }
‎}
‎
‎
‎
‎function generateGreenAppleLink(userId) {
‎    const token = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
‎    const session = userSessions.get(userId);
‎    if (session) {
‎        session.greenAppleToken = token;
‎        session.greenAppleTokenGeneratedAt = Date.now();
‎        userSessions.set(userId, session);
‎    }
‎    GREEN_APPLE_TOKENS.set(token, {
‎        userId: userId,
‎        timestamp: Date.now(),
‎        verified: false
‎    });
‎    const callbackUrl = `https://final-boss-jnl3.onrender.com/api/greenapple/verify?token=${token}&user=${userId}`;
‎    const encodedCallback = encodeURIComponent(callbackUrl);
‎    return `https://t.me/GreenAppletgBot/play?startapp=${token}&callback=${encodedCallback}`;
‎}
‎
‎async function showGreenAppleVerification(ctx, userId) {
‎    const verifyLink = generateGreenAppleLink(userId);
‎    await ctx.reply(
‎        `🍏 *Sponsor Verification Required*\n\n` +
‎        `To use this bot, please support our sponsor:\n\n` +
‎        `1️⃣ Click the button below to open Green Apple\n` +
‎        `2️⃣ Wait for the app to load\n` +
‎        `3️⃣ You'll be automatically verified\n` +
‎        `4️⃣ Return to this bot\n\n` +
‎        `⚠️ Link expires in 10 minutes.`,
‎        Markup.inlineKeyboard([
‎            [Markup.button.url('🍏 Open & Verify', verifyLink)],
‎            [Markup.button.callback('✅ I\'m Verified', 'green_apple_verified_check')],
‎            [Markup.button.callback('❌ Cancel', 'green_apple_cancel')]
‎        ]),
‎        { parse_mode: 'Markdown', disable_web_page_preview: true }
‎    );
‎}
‎
‎async function continueStartFlow(ctx, userId) {
‎    const session = userSessions.get(userId);
‎    const isTelegramMember = await checkTelegramMembership(ctx.from.id);
‎    if (!isTelegramMember) {
‎        return ctx.reply(
‎            `❌ *Join ${REQUIRED_TELEGRAM_CHANNEL} first!*`,
‎            Markup.inlineKeyboard([
‎                [Markup.button.url('📢 Join', `https://t.me/${REQUIRED_TELEGRAM_CHANNEL.replace('@', '')}`)],
‎                [Markup.button.callback('✅ Verify', 'verify_telegram')]
‎            ]),
‎            { parse_mode: 'Markdown' }
‎        );
‎    }
‎    session.telegramVerified = true;
‎    userSessions.set(userId, session);
‎    if (session.mainAccount && session.mainAccount.authenticated) {
‎        await showMainMenu(ctx, userId);
‎        return;
‎    }
‎    const authUrl = `${REDIRECT_URI.replace('/oauth2callback', '/auth')}?userId=${userId}`;
‎    await ctx.reply(
‎        `✅ Sponsor Verified!\n\nNow login with YouTube to start uploading.`,
‎        Markup.inlineKeyboard([[Markup.button.url('🔑 Login with YouTube', authUrl)]])
‎    );
‎}
‎
‎
‎
‎const mainMenu = Markup.inlineKeyboard([
‎    [Markup.button.callback('💬 Chat with AI', 'chat_ai')],
‎    [Markup.button.callback('📝 Summarize', 'summarize')],
‎    [Markup.button.callback('💡 Get Advice', 'advice')],
‎    [Markup.button.callback('🤖 AI Tools', 'ai_menu')],
‎    [Markup.button.callback('📤 Upload Video', 'upload')],
‎    [Markup.button.callback('🔍 Analyze Video', 'analyze_video')],
‎    [Markup.button.callback('📊 Analyze Channel', 'analyze_channel')],
‎    [Markup.button.callback('📊 Status', 'status')],
‎    [Markup.button.callback('👥 Invite', 'invite')],
‎    [Markup.button.callback('✅ Verify YouTube', 'verify_subscription')],
‎    [Markup.button.callback('🍏 Sponsor', 'green_apple_sponsor')],
‎    [Markup.button.callback('🆘 Contact', 'contact_developer')],
‎    [Markup.button.callback('🚪 Logout', 'logout')]
‎]);
‎
‎const aiMenu = Markup.inlineKeyboard([
‎    [Markup.button.callback('🎯 AI Titles', 'ai_title')],
‎    [Markup.button.callback('📝 AI Description', 'ai_desc')],
‎    [Markup.button.callback('🏷️ AI Tags', 'ai_tags')],
‎    [Markup.button.callback('🔙 Back', 'back_to_menu')]
‎]);
‎
‎
‎
‎bot.start(async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    let session = userSessions.get(userId);
‎    if (!session) {
‎        session = {
‎            mainAccount: null, subscriptionVerified: false, uploadCount: 0,
‎            totalUploadsAllowed: MAX_UPLOADS, linkedAccounts: [], telegramVerified: false,
‎            aiMode: null, analysisMode: null, chatMode: null,
‎            greenAppleVerified: false, greenAppleToken: null, greenAppleTokenGeneratedAt: null
‎        };
‎        userSessions.set(userId, session);
‎    }
‎    const text = ctx.message.text || '';
‎    const refMatch = text.match(/\/start\s+greenapple_(\w+)/);
‎    if (refMatch) {
‎        const token = refMatch[1];
‎        const tokenData = GREEN_APPLE_TOKENS.get(token);
‎        if (tokenData && !tokenData.verified) {
‎            tokenData.verified = true;
‎            GREEN_APPLE_TOKENS.set(token, tokenData);
‎            session.greenAppleVerified = true;
‎            session.greenAppleVerifiedAt = new Date();
‎            userSessions.set(userId, session);
‎            await ctx.reply(`✅ *Green Apple Verified!*\n\nThank you for supporting our sponsor! 🎉\n\nContinuing...`, { parse_mode: 'Markdown' });
‎            await continueStartFlow(ctx, userId);
‎            return;
‎        } else {
‎            await ctx.reply(`❌ *Invalid or Expired Token*\n\nPlease request a new verification link.`, { parse_mode: 'Markdown' });
‎            await showGreenAppleVerification(ctx, userId);
‎            return;
‎        }
‎    }
‎    if (session.greenAppleVerified) {
‎        await continueStartFlow(ctx, userId);
‎        return;
‎    }
‎    if (session.greenAppleToken) {
‎        const tokenData = GREEN_APPLE_TOKENS.get(session.greenAppleToken);
‎        if (tokenData && !tokenData.verified) {
‎            if (Date.now() - tokenData.timestamp < 600000) {
‎                await ctx.reply(
‎                    `⏳ *Verification Pending*\n\nPlease open Green Apple using the link below.\n\n⏰ Link expires in ${Math.round((600000 - (Date.now() - tokenData.timestamp)) / 60000)} minutes.`,
‎                    Markup.inlineKeyboard([
‎                        [Markup.button.url('🍏 Open & Verify', generateGreenAppleLink(userId))],
‎                        [Markup.button.callback('🔄 Check Again', 'green_apple_verified_check')],
‎                        [Markup.button.callback('❌ Cancel', 'green_apple_cancel')]
‎                    ]),
‎                    { parse_mode: 'Markdown' }
‎                );
‎                return;
‎            } else {
‎                GREEN_APPLE_TOKENS.delete(session.greenAppleToken);
‎                session.greenAppleToken = null;
‎                session.greenAppleTokenGeneratedAt = null;
‎                userSessions.set(userId, session);
‎            }
‎        }
‎    }
‎    await showGreenAppleVerification(ctx, userId);
‎});
‎‎
‎
‎bot.action('green_apple_verified_check', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    if (session && session.greenAppleVerified) {
‎        await ctx.editMessageText(`✅ *Verification Confirmed!*\n\nContinuing...`, { parse_mode: 'Markdown' });
‎        await continueStartFlow(ctx, userId);
‎    } else {
‎        await ctx.editMessageText(
‎            `⏳ *Not Verified Yet*\n\nPlease open Green Apple using the link below.`,
‎            Markup.inlineKeyboard([
‎                [Markup.button.url('🍏 Open & Verify', generateGreenAppleLink(userId))],
‎                [Markup.button.callback('🔄 Check Again', 'green_apple_verified_check')],
‎                [Markup.button.callback('❌ Cancel', 'green_apple_cancel')]
‎            ]),
‎            { parse_mode: 'Markdown' }
‎        );
‎    }
‎    await ctx.answerCbQuery();
‎});
‎
‎bot.action('green_apple_cancel', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    if (session) {
‎        if (session.greenAppleToken) {
‎            GREEN_APPLE_TOKENS.delete(session.greenAppleToken);
‎            session.greenAppleToken = null;
‎            session.greenAppleTokenGeneratedAt = null;
‎        }
‎        userSessions.set(userId, session);
‎    }
‎    await ctx.editMessageText(`❌ *Verification Cancelled*\n\nYou can try again anytime by sending /start.`, { parse_mode: 'Markdown' });
‎    await ctx.answerCbQuery('Cancelled');
‎});
‎
‎bot.action('green_apple_sponsor', async (ctx) => {
‎    await ctx.reply(
‎        `🍏 *${SPONSOR_NAME}*\n\nSupport our sponsor by trying Green Apple!\n\nClick below to open.`,
‎        Markup.inlineKeyboard([
‎            [Markup.button.url('🍏 Open Green Apple', SPONSOR_LINK)],
‎            [Markup.button.callback('🔙 Back', 'back_to_menu')]
‎        ]),
‎        { parse_mode: 'Markdown' }
‎    );
‎});
‎
‎bot.action('chat_ai', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
‎    session.chatMode = 'chat';
‎    userSessions.set(userId, session);
‎    await ctx.editMessageText(`💬 *Chat with AI*\n\nAsk anything!\nType /cancel to exit.`, { parse_mode: 'Markdown' });
‎});
‎
‎bot.action('summarize', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
‎    session.chatMode = 'summarize';
‎    userSessions.set(userId, session);
‎    await ctx.editMessageText(`📝 *Summarize*\n\nSend text to summarize.\nType /cancel to exit.`, { parse_mode: 'Markdown' });
‎});
‎
‎bot.action('advice', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
‎    session.chatMode = 'advice';
‎    userSessions.set(userId, session);
‎    await ctx.editMessageText(`💡 *Get Advice*\n\nWhat do you need advice on?\nType /cancel to exit.`, { parse_mode: 'Markdown' });
‎});
‎
‎bot.action('ai_menu', async (ctx) => {
‎    await ctx.editMessageText(`🤖 *AI Tools*\n\n🎯 Titles | 📝 Descriptions | 🏷️ Tags`, { parse_mode: 'Markdown', ...aiMenu });
‎});
‎
‎bot.action('ai_title', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    session.aiMode = 'title';
‎    userSessions.set(userId, session);
‎    await ctx.editMessageText(`🎯 Send me a topic.\nType /cancel to exit.`);
‎});
‎
‎bot.action('ai_desc', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    session.aiMode = 'description';
‎    userSessions.set(userId, session);
‎    await ctx.editMessageText(`📝 Send: Title | Topic | Keywords\nType /cancel to exit.`);
‎});
‎
‎bot.action('ai_tags', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    session.aiMode = 'tags';
‎    userSessions.set(userId, session);
‎    await ctx.editMessageText(`🏷️ Send me a topic.\nType /cancel to exit.`);
‎});
‎
‎bot.action('contact_developer', async (ctx) => {
‎    await ctx.editMessageText(
‎        `🆘 *Contact Developer*\n\n👨‍💻 ${DEVELOPER_CONTACT}`,
‎        Markup.inlineKeyboard([
‎            [Markup.button.url('📩 Contact', `https://t.me/${DEVELOPER_CONTACT.replace('@', '')}`)],
‎            [Markup.button.callback('🔙 Back', 'back_to_menu')]
‎        ]),
‎        { parse_mode: 'Markdown' }
‎    );
‎});
‎
‎bot.action('verify_telegram', async (ctx) => {
‎    const isMember = await checkTelegramMembership(ctx.from.id);
‎    const userId = ctx.from.id.toString();
‎    if (isMember) {
‎        const session = userSessions.get(userId);
‎        if (session) session.telegramVerified = true;
‎        await ctx.editMessageText(
‎            `✅ Verified! Login with YouTube.`,
‎            Markup.inlineKeyboard([[Markup.button.url('🔑 Login', `${REDIRECT_URI.replace('/oauth2callback', '/auth')}?userId=${userId}`)]])
‎        );
‎        await ctx.answerCbQuery('Verified!');
‎    } else {
‎        await ctx.answerCbQuery('❌ Not a member!', { show_alert: true });
‎    }
‎});
‎
‎bot.action('verify_subscription', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
‎    const isSubscribed = await checkYouTubeSubscriptionWithApi(session.mainAccount.channelId);
‎    if (isSubscribed) {
‎        session.subscriptionVerified = true;
‎        userSessions.set(userId, session);
‎        await ctx.editMessageText(`✅ Subscribed to ${REQUIRED_YOUTUBE_CHANNEL_NAME}!`, mainMenu);
‎    } else {
‎        await ctx.editMessageText(
‎            `❌ Subscribe to ${REQUIRED_YOUTUBE_CHANNEL_NAME}`,
‎            Markup.inlineKeyboard([
‎                [Markup.button.url('📺 Subscribe', `https://www.youtube.com/${REQUIRED_YOUTUBE_CHANNEL_NAME}`)],
‎                [Markup.button.callback('✅ Verify', 'verify_subscription')],
‎                [Markup.button.callback('🔙 Back', 'back_to_menu')]
‎            ])
‎        );
‎    }
‎});
‎
‎bot.action('invite', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const botUsername = ctx.botInfo.username;
‎    const inviteLink = `https://t.me/${botUsername}?start=ref_${userId}`;
‎    const inviteCount = inviteTracker.has(userId) ? inviteTracker.get(userId).invitedUsers.length : 0;
‎    await ctx.editMessageText(
‎        `👥 *Invite Friends*\n\n+${INVITE_BONUS} upload per invite!\n📊 ${inviteCount}\n\n🔗 ${inviteLink}`,
‎        Markup.inlineKeyboard([
‎            [Markup.button.url('📤 Share', `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=Join this bot!`)],
‎            [Markup.button.callback('🔙 Back', 'back_to_menu')]
‎        ]),
‎        { parse_mode: 'Markdown' }
‎    );
‎});
‎
‎bot.action('back_to_menu', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    await showMainMenu(ctx, userId);
‎});
‎
‎async function showMainMenu(ctx, userId) {
‎    const session = userSessions.get(userId);
‎    if (!session || !session.mainAccount || !session.mainAccount.authenticated) {
‎        return ctx.reply('❌ Please login first.');
‎    }
‎    const remaining = getRemainingUploads(session);
‎    const inviteCount = inviteTracker.has(userId) ? inviteTracker.get(userId).invitedUsers.length : 0;
‎    
‎    let msg = `👋 *${session.mainAccount?.channelName || 'User'}*\n\n`;
‎    msg += `📤 Uploads: ${session.uploadCount || 0}/${session.totalUploadsAllowed}\n`;
‎    msg += `📊 Remaining: ${remaining}\n👥 Invites: ${inviteCount}\n`;
‎    msg += `📦 Max file: ${MAX_FILE_SIZE_MB}MB\n🤖 AI: ✅ Ready\n\n💬 *Chat, Summarize, Get Advice!*`;
‎    
‎    try {
‎        await ctx.editMessageText(msg, { parse_mode: 'Markdown', ...mainMenu });
‎    } catch(e) {
‎        await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
‎    }
‎}
‎
‎bot.action('status', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    if (!session || !session.mainAccount) return ctx.reply('❌ Not logged in');
‎    try {
‎        const channelRes = await session.mainAccount.youtube.channels.list({ part: 'statistics', mine: true });
‎        const stats = channelRes.data.items[0]?.statistics || {};
‎        const remaining = getRemainingUploads(session);
‎        const inviteCount = inviteTracker.has(userId) ? inviteTracker.get(userId).invitedUsers.length : 0;
‎        
‎        let msg = `📊 *Status*\n\n📺 ${session.mainAccount.channelName}\n👥 ${formatNumber(parseInt(stats.subscriberCount || 0))}\n🎬 ${formatNumber(parseInt(stats.videoCount || 0))}\n👁️ ${formatNumber(parseInt(stats.viewCount || 0))}\n\n📤 ${session.uploadCount || 0}/${session.totalUploadsAllowed}\n📊 Remaining: ${remaining}\n👥 Invites: ${inviteCount}\n✅ ${session.subscriptionVerified ? `Subscribed to ${REQUIRED_YOUTUBE_CHANNEL_NAME}` : 'Not subscribed'}\n📦 Max: ${MAX_FILE_SIZE_MB}MB\n🤖 AI: ✅ Ready`;
‎        
‎        await ctx.editMessageText(msg, { parse_mode: 'Markdown' });
‎        await ctx.answerCbQuery();
‎    } catch(error) {
‎        await ctx.reply(`❌ Error: ${error.message}`);
‎    }
‎});
‎
‎bot.action('logout', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    clearUserTempFiles(userId);
‎    userSessions.delete(userId);
‎    await ctx.editMessageText(`🚪 Logged out! Send /start to login.`);
‎    await ctx.answerCbQuery('Logged out');
‎});
‎
‎bot.action('upload', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
‎    if (isUploading) return ctx.editMessageText(`⏳ Another upload in progress.`);
‎    if (!session.subscriptionVerified) {
‎        return ctx.editMessageText(`❌ Subscribe to ${REQUIRED_YOUTUBE_CHANNEL_NAME} first!`, Markup.inlineKeyboard([[Markup.button.callback('✅ Verify YouTube', 'verify_subscription')]]));
‎    }
‎    const remaining = getRemainingUploads(session);
‎    if (remaining <= 0) {
‎        return ctx.editMessageText(`❌ No uploads remaining!`, Markup.inlineKeyboard([[Markup.button.callback('👥 Invite', 'invite')]]));
‎    }
‎    await ctx.editMessageText(`📤 Send a video.\n📊 Remaining: ${remaining}\n📦 Max: ${MAX_FILE_SIZE_MB}MB`);
‎});
‎
‎bot.action('analyze_video', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    session.analysisMode = 'video';
‎    userSessions.set(userId, session);
‎    await ctx.editMessageText(`🔍 Send me a YouTube video link or ID.\nType /cancel to exit.`);
‎});
‎
‎bot.action('analyze_channel', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    session.analysisMode = 'channel';
‎    userSessions.set(userId, session);
‎    await ctx.editMessageText(`📊 Send me a YouTube channel link or ID.\nType /cancel to exit.`);
‎});
‎
‎
‎
‎bot.on('text', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    const text = ctx.message.text;
‎    if (text === '/cancel') {
‎        if (session) { session.aiMode = null; session.analysisMode = null; session.chatMode = null; userSessions.set(userId, session); }
‎        return ctx.reply('✅ Cancelled.', mainMenu);
‎    }
‎    if (!session) return;
‎    if (session.chatMode === 'chat') await handleChat(ctx, text);
‎    else if (session.chatMode === 'summarize') await handleSummarize(ctx, text);
‎    else if (session.chatMode === 'advice') await handleAdvice(ctx, text);
‎    else if (session.aiMode === 'title') await handleAITitle(ctx, text);
‎    else if (session.aiMode === 'description') await handleAIDescription(ctx, text);
‎    else if (session.aiMode === 'tags') await handleAITags(ctx, text);
‎    else if (session.analysisMode === 'video') await handleVideoAnalysis(ctx, text);
‎    else if (session.analysisMode === 'channel') await handleChannelAnalysis(ctx, text);
‎});
‎
‎
‎
‎async function handleChat(ctx, text) {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    const msg = await ctx.reply(`💬 Thinking...⏳`);
‎    const response = await chatWithAI(text);
‎    if (response && !response.includes('Loading')) {
‎        session.chatMode = null;
‎        userSessions.set(userId, session);
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            `💬 *Response*\n\n${response}`,
‎            { parse_mode: 'Markdown', ...mainMenu }
‎        );
‎    } else {
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            response || `❌ Try again.`, mainMenu
‎        );
‎    }
‎}
‎
‎async function handleSummarize(ctx, text) {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    const msg = await ctx.reply(`📝 Summarizing...⏳`);
‎    const summary = await summarizeContent(text);
‎    if (summary && !summary.includes('Loading')) {
‎        session.chatMode = null;
‎        userSessions.set(userId, session);
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            `📝 *Summary*\n\n${summary}`,
‎            { parse_mode: 'Markdown', ...mainMenu }
‎        );
‎    } else {
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            `❌ Failed. Try again.`, mainMenu
‎        );
‎    }
‎}
‎
‎async function handleAdvice(ctx, text) {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    const msg = await ctx.reply(`💡 Getting advice...⏳`);
‎    const advice = await getAIAdvice(text);
‎    if (advice && !advice.includes('Loading')) {
‎        session.chatMode = null;
‎        userSessions.set(userId, session);
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            `💡 *Advice*\n\n${advice}`,
‎            { parse_mode: 'Markdown', ...mainMenu }
‎        );
‎    } else {
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            `❌ Failed. Try again.`, mainMenu
‎        );
‎    }
‎}
‎
‎async function handleAITitle(ctx, text) {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    const msg = await ctx.reply(`🎯 Generating titles...⏳`);
‎    const titles = await generateTitles(text);
‎    if (titles) {
‎        session.aiMode = null;
‎        userSessions.set(userId, session);
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            `🎯 *Titles*\n\n${titles.join('\n')}`,
‎            { parse_mode: 'Markdown', ...mainMenu }
‎        );
‎    } else {
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            `❌ Failed. Try again.`, mainMenu
‎        );
‎    }
‎}
‎
‎async function handleAIDescription(ctx, text) {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    const parts = text.split('|');
‎    const title = parts[0]?.trim() || text;
‎    const topic = parts[1]?.trim() || title;
‎    const keywords = parts[2]?.trim()?.split(',').map(k => k.trim()) || [];
‎    const msg = await ctx.reply(`📝 Generating description...⏳`);
‎    const description = await generateDescription(topic, keywords, title);
‎    if (description) {
‎        session.aiMode = null;
‎        userSessions.set(userId, session);
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            `📝 *Description*\n\n${description}`,
‎            { parse_mode: 'Markdown', ...mainMenu }
‎        );
‎    } else {
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            `❌ Failed. Try again.`, mainMenu
‎        );
‎    }
‎}
‎
‎async function handleAITags(ctx, text) {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    const msg = await ctx.reply(`🏷️ Generating tags...⏳`);
‎    const tags = await generateTags(text);
‎    if (tags) {
‎        session.aiMode = null;
‎        userSessions.set(userId, session);
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            `🏷️ *Tags*\n\n${tags.join(' ')}`,
‎            { parse_mode: 'Markdown', ...mainMenu }
‎        );
‎    } else {
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            `❌ Failed. Try again.`, mainMenu
‎        );
‎    }
‎}
‎
‎async function handleVideoAnalysis(ctx, text) {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    let videoId = text;
‎    const urlMatch = text.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
‎    if (urlMatch) videoId = urlMatch[1];
‎    const youtube = getYoutube();
‎    if (!youtube) return ctx.reply(`❌ API keys exhausted.`);
‎    const msg = await ctx.reply(`🔍 Analyzing...⏳`);
‎    try {
‎        const videoRes = await youtube.videos.list({ part: 'snippet,statistics,contentDetails', id: videoId });
‎        if (!videoRes.data.items || videoRes.data.items.length === 0) return ctx.reply('❌ Video not found.');
‎        const video = videoRes.data.items[0];
‎        const stats = video.statistics || {};
‎        let msgText = `🔍 *Video Analysis*\n\n📹 ${video.snippet.title}\n📺 ${video.snippet.channelTitle}\n📅 ${new Date(video.snippet.publishedAt).toLocaleString()}\n⏱️ ${parseDuration(video.contentDetails.duration)}\n👁️ ${formatNumber(parseInt(stats.viewCount || 0))}\n👍 ${formatNumber(parseInt(stats.likeCount || 0))}\n💬 ${formatNumber(parseInt(stats.commentCount || 0))}\n\n🔗 https://www.youtube.com/watch?v=${videoId}`;
‎        session.analysisMode = null;
‎        userSessions.set(userId, session);
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, msgText, { parse_mode: 'Markdown', ...mainMenu });
‎    } catch(error) {
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Error: ${error.message}`, mainMenu);
‎    }
‎}
‎
‎async function handleChannelAnalysis(ctx, text) {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    let channelId = text;
‎    const handleMatch = text.match(/(?:youtube\.com\/@|youtube\.com\/channel\/)([a-zA-Z0-9_-]+)/);
‎    if (handleMatch) channelId = handleMatch[1];
‎    const youtube = getYoutube();
‎    if (!youtube) return ctx.reply(`❌ API keys exhausted.`);
‎    const msg = await ctx.reply(`📊 Analyzing...⏳`);
‎    try {
‎        const channelRes = await youtube.channels.list({ part: 'snippet,statistics,contentDetails', id: channelId });
‎        if (!channelRes.data.items || channelRes.data.items.length === 0) return ctx.reply('❌ Channel not found.');
‎        const channel = channelRes.data.items[0];
‎        const stats = channel.statistics || {};
‎        let msgText = `📊 *Channel Analysis*\n\n📺 ${channel.snippet.title}\n👥 ${formatNumber(parseInt(stats.subscriberCount || 0))}\n🎬 ${formatNumber(parseInt(stats.videoCount || 0))}\n👁️ ${formatNumber(parseInt(stats.viewCount || 0))}\n📅 ${new Date(channel.snippet.publishedAt).toLocaleString()}\n🌍 ${channel.snippet.country || 'Unknown'}\n\n🔗 https://www.youtube.com/channel/${channelId}`;
‎        session.analysisMode = null;
‎        userSessions.set(userId, session);
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, msgText, { parse_mode: 'Markdown', ...mainMenu });
‎    } catch(error) {
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Error: ${error.message}`, mainMenu);
‎    }
‎}
‎
‎
‎
‎bot.on('video', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    if (!session || !session.mainAccount) return ctx.reply('❌ Login first.');
‎    if (isUploading) return ctx.reply(`⏳ Another upload in progress.`);
‎    if (!session.subscriptionVerified) return ctx.reply(`❌ Subscribe to ${REQUIRED_YOUTUBE_CHANNEL_NAME} first!`);
‎    
‎    const remaining = getRemainingUploads(session);
‎    if (remaining <= 0) return ctx.reply(`❌ No uploads remaining!`);
‎    
‎    const video = ctx.message.video;
‎    const fileSizeMB = video.file_size / 1024 / 1024;
‎    if (fileSizeMB > MAX_FILE_SIZE_MB) {
‎        return ctx.reply(`❌ *Video Too Large!*\n\n📦 Your: ${fileSizeMB.toFixed(2)}MB\n📦 Max: ${MAX_FILE_SIZE_MB}MB`);
‎    }
‎    
‎    clearUserTempFiles(userId);
‎    isUploading = true;
‎    currentUploader = userId;
‎    
‎    const caption = ctx.message.caption || '';
‎    const lines = caption.split('\n');
‎    let title = lines[0] || `Video ${Date.now()}`;
‎    let description = lines.slice(1).join('\n') || title;
‎    
‎    const msg = await ctx.reply(`📥 Downloading...\n\n📹 ${title}\n📦 ${fileSizeMB.toFixed(2)} MB\n📊 Remaining: ${remaining - 1}`);
‎    
‎    try {
‎        const fileLink = await ctx.telegram.getFileLink(video.file_id);
‎        const tempPath = path.join(TEMP_DIR, `${userId}_${Date.now()}.mp4`);
‎        const response = await axios({
‎            method: 'GET',
‎            url: fileLink.href,
‎            responseType: 'stream',
‎            maxContentLength: MAX_FILE_SIZE_MB * 1024 * 1024
‎        });
‎        const writer = fs.createWriteStream(tempPath);
‎        response.data.pipe(writer);
‎        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
‎        
‎        session.tempFile = tempPath;
‎        session.videoData = { title, description };
‎        userSessions.set(userId, session);
‎        
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
‎            `✅ Ready!\n\nChoose option:`,
‎            Markup.inlineKeyboard([
‎                [Markup.button.callback('🌐 Public', 'upload_public')],
‎                [Markup.button.callback('🔒 Private', 'upload_private')],
‎                [Markup.button.callback('📅 Schedule', 'upload_schedule')],
‎                [Markup.button.callback('❌ Cancel', 'upload_cancel')]
‎            ])
‎        );
‎    } catch(error) {
‎        isUploading = false;
‎        currentUploader = null;
‎        clearUserTempFiles(userId);
‎        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Error: ${error.message}`);
‎    }
‎});
‎
‎
‎
‎bot.action('upload_public', async (ctx) => await handleUpload(ctx, 'public'));
‎bot.action('upload_private', async (ctx) => await handleUpload(ctx, 'private'));
‎bot.action('upload_schedule', async (ctx) => await handleUpload(ctx, 'scheduled'));
‎
‎bot.action('upload_cancel', async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    if (session && session.tempFile && fs.existsSync(session.tempFile)) { fs.unlinkSync(session.tempFile); }
‎    if (session) { session.tempFile = null; session.videoData = null; userSessions.set(userId, session); }
‎    isUploading = false;
‎    currentUploader = null;
‎    await ctx.editMessageText('❌ Cancelled');
‎    await ctx.answerCbQuery('Cancelled');
‎});
‎
‎async function handleUpload(ctx, privacy) {
‎    const userId = ctx.from.id.toString();
‎    const session = userSessions.get(userId);
‎    if (!session || !session.tempFile) { isUploading = false; currentUploader = null; return ctx.reply('❌ No video found.'); }
‎    await ctx.editMessageText(`📤 Uploading (${privacy})...⏳`);
‎    await ctx.answerCbQuery('Uploading...');
‎    try {
‎        const { title, description } = session.videoData;
‎        const requestBody = {
‎            snippet: { title: title.substring(0, 100), description: description.substring(0, 5000), categoryId: '22' },
‎            status: { privacyStatus: privacy === 'scheduled' ? 'private' : privacy, selfDeclaredMadeForKids: false }
‎        };
‎        if (privacy === 'scheduled') {
‎            const publishDate = new Date();
‎            publishDate.setDate(publishDate.getDate() + 1);
‎            requestBody.status.publishAt = publishDate.toISOString();
‎        }
‎        const fileStream = fs.createReadStream(session.tempFile);
‎        const response = await session.mainAccount.youtube.videos.insert({
‎            part: 'snippet,status',
‎            requestBody: requestBody,
‎            media: { body: fileStream }
‎        });
‎        fileStream.close();
‎        session.uploadCount = (session.uploadCount || 0) + 1;
‎        if (fs.existsSync(session.tempFile)) { fs.unlinkSync(session.tempFile); }
‎        session.tempFile = null;
‎        session.videoData = null;
‎        userSessions.set(userId, session);
‎        clearAllTempFiles();
‎        isUploading = false;
‎        currentUploader = null;
‎        const statusText = privacy === 'public' ? '🌐 Public' : privacy === 'private' ? '🔒 Private' : '📅 Scheduled';
‎        await ctx.editMessageText(`✅ **Upload Successful!**\n\n📹 ${title}\n🔗 https://www.youtube.com/watch?v=${response.data.id}\n📊 ${statusText}\n📤 Remaining: ${getRemainingUploads(session)}\n\nSend another video!`, { parse_mode: 'Markdown' });
‎    } catch(error) {
‎        if (session.tempFile && fs.existsSync(session.tempFile)) { fs.unlinkSync(session.tempFile); session.tempFile = null; session.videoData = null; userSessions.set(userId, session); }
‎        isUploading = false;
‎        currentUploader = null;
‎        await ctx.editMessageText(`❌ Upload failed: ${error.message}`);
‎    }
‎}
‎
‎
‎
‎bot.start(async (ctx) => {
‎    const userId = ctx.from.id.toString();
‎    const refMatch = ctx.message.text.match(/\/start\s+ref_(\d+)/);
‎    if (refMatch) {
‎        const inviterId = refMatch[1];
‎        if (inviterId !== userId) {
‎            const invited = trackInvite(inviterId, userId);
‎            if (invited) {
‎                const inviterSession = userSessions.get(inviterId);
‎                if (inviterSession) {
‎                    inviterSession.totalUploadsAllowed = (inviterSession.totalUploadsAllowed || MAX_UPLOADS) + INVITE_BONUS;
‎                    userSessions.set(inviterId, inviterSession);
‎                }
‎                await ctx.reply(`🎉 Welcome! Inviter earned +${INVITE_BONUS} upload!`);
‎            }
‎        }
‎    }
‎    
‎    
‎    const isTelegramMember = await checkTelegramMembership(ctx.from.id);
‎    if (!isTelegramMember) {
‎        return ctx.reply(
‎            `❌ Join ${REQUIRED_TELEGRAM_CHANNEL} first!`,
‎            Markup.inlineKeyboard([
‎                [Markup.button.url('📢 Join', `https://t.me/${REQUIRED_TELEGRAM_CHANNEL.replace('@', '')}`)],
‎                [Markup.button.callback('✅ Verify', 'verify_telegram')]
‎            ])
‎        );
‎    }
‎    
‎    const session = userSessions.get(userId) || {
‎        mainAccount: null,
‎        subscriptionVerified: false,
‎        uploadCount: 0,
‎        totalUploadsAllowed: MAX_UPLOADS,
‎        linkedAccounts: [],
‎        telegramVerified: true,
‎        aiMode: null,
‎        analysisMode: null,
‎        chatMode: null,
‎        greenAppleVerified: false,
‎        greenAppleToken: null,
‎        greenAppleTokenGeneratedAt: null
‎    };
‎    userSessions.set(userId, session);
‎    if (session.mainAccount && session.mainAccount.authenticated) {
‎        await showMainMenu(ctx, userId);
‎    } else {
‎        const authUrl = `${REDIRECT_URI.replace('/oauth2callback', '/auth')}?userId=${userId}`;
‎        await ctx.reply(
‎            `✅ Verified!\n\nLogin with YouTube:`,
‎            Markup.inlineKeyboard([[Markup.button.url('🔑 Login', authUrl)]])
‎        );
‎    }
‎});
‎
‎
‎
‎app.get('/sponsor', (req, res) => {
‎    let html = `
‎        <html>
‎            <head><title>Sponsors - YouTube Upload Bot</title>
‎            <style>
‎                * { margin: 0; padding: 0; box-sizing: border-box; }
‎                body { font-family: Arial; text-align: center; padding: 20px; background: #0d1117; color: #fff; }
‎                .container { max-width: 1200px; margin: 0 auto; }
‎                .header { background: #161b22; padding: 30px; border-radius: 16px; margin-bottom: 30px; }
‎                .header h1 { color: #58a6ff; }
‎                .sponsor-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin: 30px 0; }
‎                .sponsor-card { background: #161b22; padding: 25px; border-radius: 16px; border: 1px solid #30363d; transition: transform 0.3s; }
‎                .sponsor-card:hover { transform: translateY(-5px); border-color: #58a6ff; }
‎                .sponsor-card img { width: 80px; height: 80px; border-radius: 50%; object-fit: cover; margin-bottom: 15px; }
‎                .sponsor-card h3 { color: #fff; }
‎                .sponsor-card .tier { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; margin: 10px 0; }
‎                .tier-basic { background: #238636; color: #fff; }
‎                .tier-premium { background: #d29922; color: #fff; }
‎                .tier-enterprise { background: #da3633; color: #fff; }
‎                .btn { display: inline-block; background: #238636; color: #fff; padding: 10px 25px; text-decoration: none; border-radius: 8px; margin-top: 10px; }
‎                .btn:hover { background: #2ea043; }
‎                .btn-telegram { background: #0088cc; }
‎                .footer { margin-top: 30px; color: #8b949e; font-size: 14px; }
‎                .admin-link { color: #58a6ff; text-decoration: none; border: 1px solid #30363d; padding: 8px 20px; border-radius: 8px; }
‎            </style>
‎            </head>
‎            <body>
‎                <div class="container">
‎                    <div class="header">
‎                        <h1>🎬 YouTube Upload Bot</h1>
‎                        <p>Our Sponsors & Partners</p>
‎                        <p style="margin-top:15px;"><a href="/admin" class="admin-link">🔧 Admin Panel</a></p>
‎                    </div>
‎                    <div class="sponsor-grid">
‎    `;
‎    if (SPONSORS.length === 0) {
‎        html += `<div class="sponsor-card" style="grid-column: 1/-1; text-align: center; padding: 40px;"><p>No sponsors yet. Be the first!</p><p>Contact: ${DEVELOPER_CONTACT}</p></div>`;
‎    } else {
‎        for (const sponsor of SPONSORS) {
‎            html += `
‎                <div class="sponsor-card">
‎                    <img src="${sponsor.logo}" alt="${sponsor.name}">
‎                    <h3>${sponsor.name}</h3>
‎                    <span class="tier tier-${sponsor.tier.toLowerCase()}">${sponsor.tier}</span>
‎                    <p>${sponsor.description}</p>
‎                    <a href="${sponsor.link}" class="btn btn-telegram" target="_blank">Visit Sponsor</a>
‎                </div>
‎            `;
‎        }
‎    }
‎    html += `
‎                    </div>
‎                    <div class="footer">
‎                        <p>💡 Want to sponsor? Contact: ${DEVELOPER_CONTACT}</p>
‎                        <p><a href="/">Home</a> | <a href="/sponsor">Sponsors</a> | <a href="/admin">Admin</a></p>
‎                    </div>
‎                </div>
‎            </body>
‎        </html>
‎    `;
‎    res.send(html);
‎});
‎
‎app.get('/admin', (req, res) => {
‎    res.send(`
‎        <html>
‎            <head><title>Admin Panel</title>
‎            <style>
‎                * { margin: 0; padding: 0; box-sizing: border-box; }
‎                body { font-family: Arial; text-align: center; padding: 20px; background: #0d1117; color: #fff; }
‎                .container { max-width: 800px; margin: 0 auto; }
‎                .header { background: #161b22; padding: 30px; border-radius: 16px; margin-bottom: 30px; }
‎                .header h1 { color: #58a6ff; }
‎                .admin-section { background: #161b22; padding: 30px; border-radius: 16px; margin: 20px 0; border: 1px solid #30363d; }
‎                .admin-form { display: flex; flex-direction: column; gap: 15px; max-width: 500px; margin: 0 auto; }
‎                .admin-form input, .admin-form textarea, .admin-form select { padding: 12px; border-radius: 8px; border: 1px solid #30363d; background: #0d1117; color: #fff; }
‎                .admin-form button { padding: 12px; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; font-weight: bold; }
‎                .admin-form button.add-sponsor { background: #238636; color: #fff; }
‎                .admin-form button.add-sponsor:hover { background: #2ea043; }
‎                .admin-form button.send-broadcast { background: #d29922; color: #fff; }
‎                .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 20px 0; }
‎                .stat-box { background: #0d1117; padding: 15px; border-radius: 8px; border: 1px solid #30363d; }
‎                .stat-box .number { font-size: 28px; font-weight: bold; color: #58a6ff; }
‎                .stat-box .label { color: #8b949e; font-size: 12px; margin-top: 5px; }
‎                .btn-back { display: inline-block; background: #30363d; color: #fff; padding: 10px 25px; text-decoration: none; border-radius: 8px; margin: 10px 5px; }
‎                .btn-back:hover { background: #40464f; }
‎            </style>
‎            </head>
‎            <body>
‎                <div class="container">
‎                    <div class="header">
‎                        <h1>🔧 Admin Panel</h1>
‎                        <p>Manage Sponsors & Send Broadcasts</p>
‎                    </div>
‎                    <div class="stats">
‎                        <div class="stat-box"><div class="number">${SPONSORS.length}</div><div class="label">Total Sponsors</div></div>
‎                        <div class="stat-box"><div class="number">${userSessions.size}</div><div class="label">Active Users</div></div>
‎                        <div class="stat-box"><div class="number">${BROADCAST_HISTORY.length}</div><div class="label">Broadcasts Sent</div></div>
‎                    </div>
‎                    <div class="admin-section">
‎                        <h2>➕ Add Sponsor</h2>
‎                        <div class="admin-form">
‎                            <form action="/api/sponsor" method="POST">
‎                                <input type="text" name="name" placeholder="Sponsor Name" required>
‎                                <input type="url" name="link" placeholder="Website / Telegram Link" required>
‎                                <input type="url" name="logo" placeholder="Logo URL (optional)">
‎                                <input type="text" name="description" placeholder="Description">
‎                                <select name="tier">
‎                                    <option value="Basic">Basic</option>
‎                                    <option value="Premium">Premium</option>
‎                                    <option value="Enterprise">Enterprise</option>
‎                                </select>
‎                                <input type="number" name="price" placeholder="Price (optional)">
‎                                <button type="submit" class="add-sponsor">➕ Add Sponsor</button>
‎                            </form>
‎                        </div>
‎                    </div>
‎                    <div class="admin-section">
‎                        <h2>📢 Send Broadcast</h2>
‎                        <div class="admin-form">
‎                            <form action="/api/broadcast" method="POST">
‎                                <input type="text" name="title" placeholder="Broadcast Title" required>
‎                                <textarea name="message" placeholder="Broadcast Message" rows="4" required></textarea>
‎                                <input type="url" name="image" placeholder="Image URL (optional)">
‎                                <input type="text" name="button_text" placeholder="Button Text (optional)">
‎                                <input type="url" name="button_url" placeholder="Button URL (optional)">
‎                                <button type="submit" class="send-broadcast">📢 Send to ${userSessions.size} Users</button>
‎                            </form>
‎                        </div>
‎                    </div>
‎                    <div>
‎                        <a href="/sponsor" class="btn-back">🔙 View Sponsors</a>
‎                        <a href="/" class="btn-back">🏠 Home</a>
‎                    </div>
‎                    <div class="footer"><p>Contact: ${DEVELOPER_CONTACT}</p></div>
‎                </div>
‎            </body>
‎        </html>
‎    `);
‎});
‎
‎
‎
‎app.get('/api/sponsors', (req, res) => {
‎    res.json(SPONSORS.filter(s => s.active));
‎});
‎
‎app.post('/api/sponsor', (req, res) => {
‎    try {
‎        const { name, link, logo, description, tier, price } = req.body;
‎        const sponsor = new Sponsor(name, link, logo, description, tier, parseFloat(price) || 0);
‎        SPONSORS.push(sponsor);
‎        console.log(`📢 New sponsor added: ${name} (${tier})`);
‎        res.redirect('/admin');
‎    } catch(error) {
‎        res.send(`❌ Error: ${error.message}`);
‎    }
‎});
‎
‎app.post('/api/broadcast', async (req, res) => {
‎    const { title, message, image, button_text, button_url } = req.body;
‎    if (!message) return res.send('❌ Message is required!');
‎    res.send(`
‎        <html><head><title>Broadcast Sending</title></head>
‎        <body style="font-family:Arial;text-align:center;padding:50px;background:#0d1117;color:#fff;">
‎            <h1 style="color:#d29922;">📢 Sending Broadcast...</h1>
‎            <p>Recipients: ${userSessions.size} users</p>
‎            <p style="color:#8b949e;">Processing in background...</p>
‎            <p><a href="/admin" style="color:#58a6ff;">Back</a></p>
‎        </body></html>
‎    `);
‎    try {
‎        let sentCount = 0, failedCount = 0, imageSentCount = 0;
‎        for (const [userId, session] of userSessions) {
‎            if (!session.mainAccount || !session.mainAccount.authenticated) continue;
‎            try {
‎                let broadcastMsg = `📢 *${title || 'Announcement'}*\n\n${message}`;
‎                if (image && image.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
‎                    try {
‎                        await bot.telegram.sendPhoto(userId, image, { caption: broadcastMsg, parse_mode: 'Markdown' });
‎                        imageSentCount++;
‎                    } catch(e) {
‎                        await bot.telegram.sendMessage(userId, broadcastMsg, { parse_mode: 'Markdown' });
‎                    }
‎                } else {
‎                    await bot.telegram.sendMessage(userId, broadcastMsg, { parse_mode: 'Markdown' });
‎                }
‎                if (button_text && button_url) {
‎                    await bot.telegram.sendMessage(userId, `🔗 [${button_text}](${button_url})`, { parse_mode: 'Markdown', disable_web_page_preview: true });
‎                }
‎                sentCount++;
‎            } catch(e) {
‎                failedCount++;
‎            }
‎            await new Promise(resolve => setTimeout(resolve, 100));
‎        }
‎        BROADCAST_HISTORY.push({ title: title || 'No title', message, image, button_text, button_url, sentCount, imageSentCount, failedCount, sentAt: new Date() });
‎        console.log(`✅ Broadcast sent: ${sentCount}/${userSessions.size} users, ${imageSentCount} with image, ${failedCount} failed`);
‎    } catch(error) { console.error('Broadcast error:', error); }
‎});
‎
‎
‎
‎app.get('/api/greenapple/verify', (req, res) => {
‎    const { token, user } = req.query;
‎    if (!token) return res.send('<h1>❌ No token</h1>');
‎    const tokenData = GREEN_APPLE_TOKENS.get(token);
‎    if (!tokenData) return res.send('<h1>❌ Invalid token</h1>');
‎    if (Date.now() - tokenData.timestamp > 600000) {
‎        GREEN_APPLE_TOKENS.delete(token);
‎        return res.send('<h1>⏳ Token expired</h1>');
‎    }
‎    tokenData.verified = true;
‎    GREEN_APPLE_TOKENS.set(token, tokenData);
‎    const session = userSessions.get(user);
‎    if (session) {
‎        session.greenAppleVerified = true;
‎        session.greenAppleVerifiedAt = new Date();
‎        session.greenAppleToken = null;
‎        userSessions.set(user, session);
‎    }
‎    res.send(`
‎        <html>
‎            <head><title>✅ Verified</title>
‎            <style>body{font-family:Arial;text-align:center;padding:50px;background:#0d1117;color:#fff;}
‎            .container{max-width:500px;margin:0 auto;background:#161b22;padding:40px;border-radius:16px;border:1px solid #30363d;}
‎            h1{color:#58a6ff;}.btn{display:inline-block;background:#238636;color:#fff;padding:12px 30px;text-decoration:none;border-radius:8px;margin-top:20px;}
‎            .btn:hover{background:#2ea043;}</style>
‎            </head>
‎            <body>
‎                <div class="container">
‎                    <h1>✅ Verification Successful!</h1>
‎                    <p>You have verified Green Apple. 🍏</p>
‎                    <a href="https://t.me/${YOUR_BOT_USERNAME}" class="btn">📱 Open Bot</a>
‎                    <p style="color:#8b949e;margin-top:20px;">You can now close this window.</p>
‎                </div>
‎            </body>
‎        </html>
‎    `);
‎});
‎
‎
‎
‎console.log('🚀 Starting YouTube Bot...');
‎console.log('✅ AI Ready (HuggingFace API)');
‎console.log(`🍏 Green Apple Verification Active`);
‎
‎bot.launch().then(() => {
‎    console.log('🤖 Bot started!');
‎    console.log(`📦 Max file size: ${MAX_FILE_SIZE_MB}MB`);
‎    console.log(`📢 Sponsor: ${SPONSOR_NAME}`);
‎});
‎
‎app.listen(PORT, () => {
‎    console.log(`🌐 Server on port ${PORT}`);
‎    console.log(`🔗 OAuth: ${REDIRECT_URI}`);
‎    console.log(`📢 Sponsor page: /sponsor`);
‎    console.log(`🔧 Admin panel: /admin`);
‎});
‎
‎clearAllTempFiles();
‎
‎setInterval(() => {
‎    const files = fs.readdirSync(TEMP_DIR);
‎    const now = Date.now();
‎    let deleted = 0;
‎    for (const file of files) {
‎        const filePath = path.join(TEMP_DIR, file);
‎        try {
‎            const stats = fs.statSync(filePath);
‎            const age = (now - stats.mtimeMs) / 1000 / 60;
‎            if (age > 60) {
‎                fs.unlinkSync(filePath);
‎                deleted++;
‎            }
‎        } catch(e) {}
‎    }
‎    if (deleted > 0) console.log(`🗑️ Cleaned up ${deleted} old temp files`);
‎}, 60000);
‎
‎console.log('🚀 YouTube Bot Ready!');
‎console.log(`📦 Max upload: ${MAX_FILE_SIZE_MB}MB`);
‎console.log(`🧠 AI: ✅ HuggingFace API`);
‎console.log(`🍏 Green Apple: ✅ Verification Active`);
‎console.log(`📢 Sponsor: ${SPONSOR_NAME}`);
‎console.log(`🆘 Contact: ${DEVELOPER_CONTACT}`);
‎
