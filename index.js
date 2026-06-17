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
