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
const SPONSOR_CHANNEL = '@GreenAppletgBot'; // Green Apple Sponsor
const SPONSOR_LINK = 'https://t.me/GreenAppletgBot/play?startapp=6596414316';
const SPONSOR_NAME = 'Green Apple 🍏';
const SPONSORS = [];
const BROADCAST_HISTORY = [];

// ============ GREEN APPLE CONFIG ============
const GREEN_APPLE_TOKENS = new Map();
const YOUR_BOT_USERNAME = process.env.BOT_USERNAME || 'final_boss_bot';
const GREEN_APPLE_BOT_URL = 'https://t.me/GreenAppletgBot/play?startapp=6596414316';

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
