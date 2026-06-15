const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ============ CREDENTIALS ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const TARGET_CHANNEL_HANDLE = '@Tewahdotube-21';
const CLIENT_ID = '635922113777-8c182r05vi5ve32nkqgqc2n5bbldhn18.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04F_QRLOYNyOdCgYIARAAGAQSNwF-L9IrWsT9K73DNxaQfqrmd6fgYUhdeQaFAvSJtB8y3eV6ZA3skvwUfUacaRTr53opx0mrn_k';

// ============ API KEYS ============
const API_KEYS = [
    'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg',
    'AIzaSyAXzQXd0AONNgSI8E6D5_BeweMqyz4iGTg',
    'AIzaSyDjLVpU8M9VFBAuj-_pvSyDW1BbUfCjyIY'
];

let currentKey = 0, keyUsage = [0,0,0];
let keyReset = [Date.now(), Date.now(), Date.now()];
let lastVideoId = null;
let isProcessing = false;
let scheduledCache = null;
let lastCache = 0;
let monitorCount = 0;
let consecutiveErrors = 0;

let downloadQueue = [];
let isDownloading = false;

const TEMP_DIR = '/tmp/youtube_bot';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
const app = express();

app.get('/', (req, res) => res.send('Bot Running'));
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        queueSize: downloadQueue.length,
        monitorCount
    });
});

app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

// Setup OAuth
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
let youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });

function getApiKey() {
    const now = Date.now();
    const ONE_DAY = 86400000;
    
    for(let i = 0; i < API_KEYS.length; i++) {
        if(now - keyReset[i] > ONE_DAY) { 
            keyUsage[i] = 0; 
            keyReset[i] = now; 
        }
        
        if(keyUsage[i] < 50) {
            currentKey = i;
            keyUsage[i]++;
            return API_KEYS[i];
        }
    }
    return null;
}

function getYoutube() { 
    const key = getApiKey();
    return key ? google.youtube({ version: 'v3', auth: key }) : null;
}

// Extract title and hashtags from caption
function extractVideoInfo(caption) {
    let title = '';
    let hashtags = [];
    
    if (!caption) return { title: `Video ${Date.now()}`, hashtags: [] };
    
    const lines = caption.split('\n');
    
    for (let line of lines) {
        line = line.trim();
        if (line && !line.startsWith('http') && !line.includes('@')) {
            const hashtagRegex = /#[\w\u00c0-\u00ff]+/g;
            const foundHashtags = line.match(hashtagRegex);
            if (foundHashtags) {
                hashtags.push(...foundHashtags);
            }
            
            if (!title && !line.startsWith('#')) {
                title = line.replace(hashtagRegex, '').trim();
            }
        }
    }
    
    return {
        title: title || `Video ${Date.now()}`,
        hashtags: hashtags,
        description: caption
    };
}

// Download video from Telegram
async function downloadFromTelegram(fileId, bot, tempPath) {
    const fileLink = await bot.telegram.getFileLink(fileId);
    const response = await axios({
        method: 'GET',
        url: fileLink.href,
        responseType: 'stream'
    });
    
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(tempPath));
        writer.on('error', reject);
    });
}

// Upload to YouTube and auto-delete
async function uploadToYouTube(filePath, title, description, hashtags) {
    let fileStream = null;
    
    try {
        const tags = hashtags.map(tag => tag.replace('#', ''));
        
        const requestBody = {
            snippet: {
                title: title.substring(0, 100),
                description: description.substring(0, 5000),
                tags: tags,
                categoryId: '22'
            },
            status: {
                privacyStatus: 'public',
                selfDeclaredMadeForKids: false
            }
        };
        
        fileStream = fs.createReadStream(filePath);
        
        const response = await youtubeAuth.videos.insert({
            part: 'snippet,status',
            requestBody: requestBody,
            media: { body: fileStream }
        });
        
        if (fileStream) fileStream.close();
        fs.unlinkSync(filePath);
        
        return response.data;
        
    } catch(error) {
        if (fileStream) fileStream.close();
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        throw error;
    }
                }
