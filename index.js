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

// ============ AI SETUP ============
let textGenerator = null;
let aiReady = false;

async function loadAI() {
    try {
        console.log('🧠 Loading DistilGPT2...');
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

async function chatWithAI(msg) {
    if (!textGenerator) return null;
    try {
        const prompt = `You are a helpful YouTube assistant. Answer: ${msg}\nAssistant:`;
        const result = await textGenerator(prompt, { max_length: 300, temperature: 0.8, pad_token_id: 50256 });
        return result[0]?.generated_text?.replace(prompt, '').trim() || null;
    } catch(e) { return null; }
}

async function summarizeContent(text) {
    if (!textGenerator) return null;
    try {
        const prompt = `Summarize:\n${text}\nSummary:`;
        const result = await textGenerator(prompt, { max_length: 150, temperature: 0.5, pad_token_id: 50256 });
        return result[0]?.generated_text?.replace(prompt, '').trim() || null;
    } catch(e) { return null; }
}

async function getAIAdvice(topic) {
    if (!textGenerator) return null;
    try {
        const prompt = `Advice about "${topic}" for YouTube creators:\nAdvice:`;
        const result = await textGenerator(prompt, { max_length: 200, temperature: 0.7, pad_token_id: 50256 });
        return result[0]?.generated_text?.replace(prompt, '').trim() || null;
    } catch(e) { return null; }
}

async function generateTitles(topic, keywords = []) {
    if (!textGenerator) return null;
    try {
        const prompt = `3 YouTube titles about "${topic}" keywords: ${keywords.join(', ')}.\n1.`;
        const result = await textGenerator(prompt, { max_length: 150, temperature: 0.9, pad_token_id: 50256 });
        const generated = result[0]?.generated_text || '';
        const titles = generated.split('\n').filter(l => l.match(/^\d+\./)).map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(t => t.length > 5);
        return titles.length > 0 ? titles : null;
    } catch(e) { return null; }
}

async function generateDescription(topic, keywords = [], title = '') {
    if (!textGenerator) return null;
    try {
        const prompt = `Description for "${title}" about "${topic}". Keywords: ${keywords.join(', ')}.\nDescription:`;
        const result = await textGenerator(prompt, { max_length: 200, temperature: 0.8, pad_token_id: 50256 });
        return result[0]?.generated_text?.replace(prompt, '').trim() || null;
    } catch(e) { return null; }
}

async function generateTags(topic, keywords = []) {
    if (!textGenerator) return null;
    try {
        const prompt = `10 hashtags for "${topic}". Keywords: ${keywords.join(', ')}.\nHashtags:`;
        const result = await textGenerator(prompt, { max_length: 100, temperature: 0.7, pad_token_id: 50256 });
        const generated = result[0]?.generated_text?.replace(prompt, '').trim() || '';
        const tags = generated.split(/\s+/).filter(t => t.startsWith('#')).slice(0, 10);
        return tags.length > 0 ? tags : null;
    } catch(e) { return null; }
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
                subscriptionVerified: false,
                uploadCount: 0,
                totalUploadsAllowed: MAX_UPLOADS,
                linkedAccounts: [],
                telegramVerified: false,
                aiMode: null,
                analysisMode: null,
                chatMode: null
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

// ============ CLEANUP ============
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
