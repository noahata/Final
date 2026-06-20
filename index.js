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
const YOUR_REFERRAL_LINK = 'https://t.me/GreenAppletgBot/play?startapp=6596414316';
const YOUR_REFERRAL_CODE = '6596414316';
const SPONSOR_NAME = 'Green Apple App';

let sponsors = [
    {
        id: 'sponsor_1',
        name: 'Green Apple App',
        referralLink: 'https://t.me/GreenAppletgBot/play?startapp=6596414316',
        referralCode: '6596414316',
        type: 'referral',
        active: true,
        requiresVerification: true,
        verificationType: 'referral',
        createdAt: new Date().toISOString()
    }
];

const ADMIN_IDS = ['6596414316', '123456789'];
const userSponsorVerifications = new Map();

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

// ============ VERIFICATION FUNCTIONS ============

async function checkTelegramChannelMembership(userId, channelUsername) {
    try {
        const cleanChannel = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`;
        const chatMember = await bot.telegram.getChatMember(cleanChannel, userId);
        return chatMember.status === 'member' || 
               chatMember.status === 'administrator' || 
               chatMember.status === 'creator';
    } catch(e) {
        console.log(`Channel check failed for ${cleanChannel}:`, e.message);
        return false;
    }
}

async function checkReferralVerification(userId, sponsorId) {
    const key = `${userId}_${sponsorId}`;
    return userSponsorVerifications.get(key) || false;
}

function markReferralVerified(userId, sponsorId) {
    const key = `${userId}_${sponsorId}`;
    userSponsorVerifications.set(key, {
        verified: true,
        timestamp: new Date().toISOString(),
        sponsorId: sponsorId,
        verifiedVia: 'referral'
    });
    return true;
        }
