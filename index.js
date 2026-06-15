const Telegraf = require('telegraf');
const google = require('googleapis');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const cheerio = require('cheerio');

const BOT_TOKEN = process.env.BOT_TOKEN;
const YOUR_CHANNEL_ID = 'UCOyIZzz0KTwU2REuaji1Xuw';
const TARGET_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const TARGET_CHANNEL_HANDLE = '@Tewahdotube-21';
const CLIENT_ID = '635922113777-8c182r05vi5ve32nkqgqc2n5bbldhn18.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_TOKEN = '1//04F_QRLOYNyOdCgYIARAAGAQSNwF-L9IrWsT9K73DNxaQfqrmd6fgYUhdeQaFAvSJtB8y3eV6ZA3skvwUfUacaRTr53opx0mrn_k';

const API_KEYS = [
    'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg',
    'AIzaSyAXzQXd0AONNgSI8E6D5_BeweMqyz4iGTg',
    'AIzaSyDjLVpU8M9VFBAuj-_pvSyDW1BbUfCjyIY'
];

let currentKey = 0;
let keyUsage = [0,0,0];
let keyReset = [Date.now(), Date.now(), Date.now()];
let lastVideoId = null;
let isProcessing = false;
let scheduledCache = null;
let lastCache = 0;
let monitorCount = 0;
let consecutiveErrors = 0;
let publishedVideos = new Map();
let youtubeAuth = null;
let oauth2Client = null;

const PORT = process.env.PORT || 3000;
const app = express();

app.get('/', (req, res) => res.send('YouTube Bot Running'));
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        lastVideoId: lastVideoId,
        monitorCount: monitorCount,
        watching: publishedVideos.size,
        uptime: process.uptime()
    });
});
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

function getApiKey() {
    const now = Date.now();
    for(let i = 0; i < API_KEYS.length; i++) {
        if(now - keyReset[i] > 86400000) {
            keyUsage[i] = 0;
            keyReset[i] = now;
        }
        if(keyUsage[i] < 50) {
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

async function initAuth() {
    oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'https://developers.google.com/oauthplayground');
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    youtubeAuth = google.youtube({ version: 'v3', auth: oauth2Client });
    console.log('Auth initialized');
}

async function refreshToken() {
    try {
        await oauth2Client.refreshAccessToken();
        console.log('Token refreshed');
    } catch(e) {
        console.error('Token refresh failed:', e.message);
    }
}

async function getUploadsPlaylistId(channelId) {
    try {
        const youtube = getYoutube();
        if(!youtube) return null;
        const res = await youtube.channels.list({ part: 'contentDetails', id: channelId });
        return res.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
    } catch(e) {
        return null;
    }
}

async function getYourUploadsPlaylistId() {
    try {
        const res = await youtubeAuth.channels.list({ part: 'contentDetails', id: YOUR_CHANNEL_ID });
        return res.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
    } catch(e) {
        return null;
    }
}

async function getLatestPost() {
    try {
        const youtube = getYoutube();
        if(!youtube) return null;
        const playlistId = await getUploadsPlaylistId(TARGET_CHANNEL_ID);
        if(!playlistId) return null;
        const res = await youtube.playlistItems.list({ part: 'snippet', playlistId, maxResults: 1 });
        if(!res.data.items?.length) return null;
        const latest = res.data.items[0];
        return {
            id: latest.snippet.resourceId.videoId,
            title: latest.snippet.title,
            publishedAt: latest.snippet.publishedAt,
            url: `https://www.youtube.com/watch?v=${latest.snippet.resourceId.videoId}`
        };
    } catch(e) {
        return null;
    }
}

async function getScheduledShorts(force = false) {
    const now = Date.now();
    if(!force && scheduledCache && (now - lastCache) < 60000) return scheduledCache;
    try {
        const playlistId = await getYourUploadsPlaylistId();
        if(!playlistId) return [];
        const res = await youtubeAuth.playlistItems.list({ part: 'snippet', playlistId, maxResults: 50 });
        const scheduled = [];
        for(let i = 0; i < (res.data.items || []).length; i += 10) {
            const batch = res.data.items.slice(i, i + 10);
            const videoIds = batch.map(item => item.snippet.resourceId.videoId);
            const videoRes = await youtubeAuth.videos.list({ part: 'status,snippet', id: videoIds.join(',') });
            for(const video of videoRes.data.items || []) {
                const status = video?.status;
                if(status?.privacyStatus === 'private' && status?.publishAt && new Date(status.publishAt) > new Date()) {
                    scheduled.push({
                        id: video.id,
                        title: video.snippet.title,
                        time: new Date(status.publishAt)
                    });
                }
            }
        }
        scheduled.sort((a,b) => a.time - b.time);
        scheduledCache = scheduled;
        lastCache = now;
        return scheduled;
    } catch(e) {
        return [];
    }
}

async function publishVideo(id, title) {
    try {
        console.log(`Publishing: ${title}`);
        await youtubeAuth.videos.update({
            part: 'status',
            requestBody: {
                id: id,
                status: { privacyStatus: 'public' }
            }
        });
        console.log(`Published: ${title}`);
        publishedVideos.set(id, {
            publishTime: Date.now(),
            title: title,
            status: 'checking'
        });
        scheduledCache = null;
        return true;
    } catch(e) {
        console.error(`Failed to publish: ${e.message}`);
        return false;
    }
}
async function scrapeYtDown(videoUrl, outputPath) {
    try {
        console.log(`Scraping ytdown.to: ${videoUrl}`);
        
        const submitUrl = 'https://ytdown.to/api/ajax/search/cta';
        const formData = new FormData();
        formData.append('q', videoUrl);
        formData.append('vt', 'mp4');
        
        const submitResponse = await axios.post(submitUrl, formData, {
            headers: {
                ...formData.getHeaders(),
                'Origin': 'https://ytdown.to',
                'Referer': 'https://ytdown.to/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 30000
        });
        
        if (!submitResponse.data || !submitResponse.data.url) {
            throw new Error('No video info received');
        }
        
        const infoUrl = submitResponse.data.url;
        const infoResponse = await axios.get(infoUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 30000
        });
        
        const $ = cheerio.load(infoResponse.data);
        const downloadLinks = [];
        
        $('a').each((i, elem) => {
            const href = $(elem).attr('href');
            const text = $(elem).text().toLowerCase();
            if (href && (href.includes('download') || href.includes('get'))) {
                let quality = 'unknown';
                if (text.includes('720') || text.includes('hd')) quality = '720';
                else if (text.includes('480')) quality = '480';
                else if (text.includes('360')) quality = '360';
                downloadLinks.push({ url: href, text: text, quality: quality });
            }
        });
        
        $('[onclick]').each((i, elem) => {
            const onclick = $(elem).attr('onclick');
            if (onclick && onclick.includes('download')) {
                const match = onclick.match(/['"](https?:\/\/[^'"]+)['"]/);
                if (match && match[1]) {
                    downloadLinks.push({ url: match[1], text: 'onclick', quality: 'unknown' });
                }
            }
        });
        
        const scripts = $('script').toArray();
        for (const script of scripts) {
            const content = $(script).html();
            if (content) {
                const matches = content.match(/https?:\/\/[^\s"'<>]+\.(mp4|zip)[^\s"'<>]*/gi);
                if (matches) {
                    matches.forEach(url => {
                        downloadLinks.push({ url: url, text: 'js', quality: 'unknown' });
                    });
                }
            }
        }
        
        const uniqueLinks = [];
        const seen = new Set();
        for (const link of downloadLinks) {
            if (!seen.has(link.url)) {
                seen.add(link.url);
                uniqueLinks.push(link);
            }
        }
        
        console.log(`Found ${uniqueLinks.length} download links`);
        
        if (uniqueLinks.length === 0) {
            throw new Error('No download links found');
        }
        
        let selectedLink = uniqueLinks[0];
        for (const q of ['720', '480', '360']) {
            const link = uniqueLinks.find(l => l.quality === q || l.text.includes(q));
            if (link) {
                selectedLink = link;
                break;
            }
        }
        
        console.log(`Selected quality: ${selectedLink.quality}`);
        
        const downloadResponse = await axios({
            method: 'GET',
            url: selectedLink.url,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': infoUrl
            },
            timeout: 120000
        });
        
        const writer = fs.createWriteStream(outputPath);
        downloadResponse.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                const stats = fs.statSync(outputPath);
                console.log(`Downloaded: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                resolve(true);
            });
            writer.on('error', reject);
            setTimeout(() => reject(new Error('Download timeout')), 180000);
        });
        
    } catch(e) {
        console.error(`Scraping error:`, e.message);
        return false;
    }
}

async function simpleReschedule(videoId, title) {
    try {
        console.log(`Simple reschedule: ${title}`);
        const newDate = new Date();
        newDate.setDate(newDate.getDate() + 3);
        await youtubeAuth.videos.update({
            part: 'status',
            requestBody: {
                id: videoId,
                status: {
                    privacyStatus: 'private',
                    publishAt: newDate.toISOString()
                }
            }
        });
        console.log(`Rescheduled for ${newDate.toLocaleString()}`);
        scheduledCache = null;
        return true;
    } catch(e) {
        console.error(`Simple reschedule failed:`, e.message);
        return false;
    }
}

async function rescheduleVideo(videoId, title) {
    try {
        console.log(`Full reschedule with reupload: ${title}`);
        const tempPath = `/tmp/video_${videoId}.mp4`;
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        let downloaded = await scrapeYtDown(videoUrl, tempPath);
        
        if (!downloaded) {
            console.log(`Download failed, using simple reschedule`);
            return await simpleReschedule(videoId, title);
        }
        
        const newDate = new Date();
        newDate.setDate(newDate.getDate() + 2);
        
        const uploadResponse = await youtubeAuth.videos.insert({
            part: 'snippet,status',
            requestBody: {
                snippet: {
                    title: title,
                    description: `Auto reuploaded due to low views on ${new Date().toLocaleString()}`
                },
                status: {
                    privacyStatus: 'private',
                    publishAt: newDate.toISOString()
                }
            },
            media: {
                body: fs.createReadStream(tempPath),
                mimeType: 'video/mp4'
            }
        });
        
        console.log(`Reuploaded, new ID: ${uploadResponse.data.id}`);
        
        await youtubeAuth.videos.update({
            part: 'status',
            requestBody: {
                id: videoId,
                status: { privacyStatus: 'private' }
            }
        });
        
        fs.unlinkSync(tempPath);
        scheduledCache = null;
        
        return true;
        
    } catch(e) {
        console.error(`Full reschedule failed:`, e.message);
        return await simpleReschedule(videoId, title);
    }
}

async function checkVideoViews() {
    for (const [videoId, data] of publishedVideos.entries()) {
        const hoursSince = (Date.now() - data.publishTime) / (1000 * 60 * 60);
        if (hoursSince >= 2 && data.status === 'checking') {
            try {
                const res = await youtubeAuth.videos.list({ part: 'statistics', id: videoId });
                const views = parseInt(res.data.items?.[0]?.statistics?.viewCount || 0);
                console.log(`Video "${data.title}" has ${views} views after 2 hours`);
                
                if (views < 2) {
                    console.log(`Low views, rescheduling...`);
                    await rescheduleVideo(videoId, data.title);
                    publishedVideos.set(videoId, { ...data, status: 'rescheduled' });
                    setTimeout(() => publishedVideos.delete(videoId), 3600000);
                } else {
                    publishedVideos.set(videoId, { ...data, status: 'success' });
                    setTimeout(() => publishedVideos.delete(videoId), 3600000);
                }
            } catch(e) {
                console.error(`View check error: ${e.message}`);
            }
        }
    }
}

async function monitor() {
    if(isProcessing) return;
    if(consecutiveErrors > 10) {
        await new Promise(resolve => setTimeout(resolve, 300000));
        consecutiveErrors = 0;
    }
    
    isProcessing = true;
    monitorCount++;
    
    try {
        await checkVideoViews();
        const latestPost = await getLatestPost();
        if(!latestPost) return;
        
        if(latestPost.id !== lastVideoId && lastVideoId !== null) {
            console.log(`NEW VIDEO DETECTED: "${latestPost.title}"`);
            const scheduled = await getScheduledShorts(true);
            if(scheduled.length > 0) {
                await publishVideo(scheduled[0].id, scheduled[0].title);
            }
            lastVideoId = latestPost.id;
        } else if(lastVideoId === null) {
            lastVideoId = latestPost.id;
            console.log(`First run, tracking: ${latestPost.id}`);
        }
        consecutiveErrors = 0;
    } catch(e) {
        consecutiveErrors++;
    } finally {
        isProcessing = false;
    }
}

async function getPublicCount() {
    try {
        let count = 0;
        let page = null;
        do {
            const res = await youtubeAuth.search.list({
                part: 'snippet',
                channelId: YOUR_CHANNEL_ID,
                type: 'video',
                maxResults: 50,
                pageToken: page
            });
            const ids = (res.data.items || []).map(i => i.id.videoId).filter(id => id);
            if(ids.length) {
                const videos = await youtubeAuth.videos.list({ part: 'status', id: ids.join(',') });
                count += (videos.data.items || []).filter(v => v?.status?.privacyStatus === 'public').length;
            }
            page = res.data.nextPageToken;
        } while(page);
        return count;
    } catch(e) {
        return 0;
    }
}

function getTimeAgo(dateString) {
    const mins = Math.floor((Date.now() - new Date(dateString)) / 60000);
    if(mins < 1) return 'Just now';
    if(mins < 60) return `${mins} minutes ago`;
    if(mins < 1440) return `${Math.floor(mins/60)} hours ago`;
    return `${Math.floor(mins/1440)} days ago`;
}

const bot = new Telegraf(BOT_TOKEN);
const menu = {
    reply_markup: {
        keyboard: [['STATUS', 'SUPPLY'], ['REFRESH', 'LATEST POST'], ['VIEW STATUS']],
        resize_keyboard: true
    }
};

bot.command('start', async (ctx) => {
    const scheduled = await getScheduledShorts();
    const publicCount = await getPublicCount();
    const latestPost = await getLatestPost();
    let msg = `YouTube Bot\n\n`;
    msg += `Your videos: ${publicCount}\n`;
    msg += `Scheduled: ${scheduled.length}\n`;
    msg += `Watching: ${publishedVideos.size}\n`;
    msg += `Target: ${TARGET_CHANNEL_HANDLE}\n\n`;
    if(latestPost) {
        msg += `Latest from target:\n`;
        msg += `${latestPost.title}\n`;
        msg += `${getTimeAgo(latestPost.publishedAt)}\n\n`;
    }
    if(scheduled[0]) {
        msg += `Your next scheduled:\n${scheduled[0].title}\n${scheduled[0].time.toLocaleString()}`;
    } else {
        msg += `No scheduled shorts`;
    }
    ctx.reply(msg, { ...menu });
});

bot.hears('STATUS', async (ctx) => {
    const scheduled = await getScheduledShorts();
    const latestPost = await getLatestPost();
    let msg = `STATUS\n\n`;
    msg += `Scheduled: ${scheduled.length}\n`;
    msg += `Watching: ${publishedVideos.size}\n`;
    msg += `Checks: ${monitorCount}\n`;
    msg += `Last ID: ${lastVideoId?.substring(0,12)}...\n\n`;
    if(latestPost) {
        msg += `Latest from target:\n${latestPost.title}\n${getTimeAgo(latestPost.publishedAt)}`;
    }
    ctx.reply(msg, { ...menu });
});

bot.hears('VIEW STATUS', async (ctx) => {
    if(publishedVideos.size === 0) {
        return ctx.reply('No videos being monitored', menu);
    }
    let msg = `VIEW STATUS\n\n`;
    for (const [id, data] of publishedVideos.entries()) {
        const hours = ((Date.now() - data.publishTime) / (1000 * 60 * 60)).toFixed(1);
        const statusIcon = data.status === 'checking' ? 'WAITING' : 'DONE';
        msg += `${statusIcon} ${data.title.substring(0, 30)}\n`;
        msg += `   ID: ${id.substring(0,8)}...\n`;
        msg += `   Time: ${hours} hours ago\n\n`;
    }
    msg += `Videos with less than 2 views in 2 hours will be auto rescheduled`;
    ctx.reply(msg, { ...menu });
});

bot.hears('LATEST POST', async (ctx) => {
    const latest = await getLatestPost();
    if(!latest) return ctx.reply('Cannot fetch latest post', menu);
    let msg = `Latest from ${TARGET_CHANNEL_HANDLE}\n\n`;
    msg += `${latest.title}\n`;
    msg += `${getTimeAgo(latest.publishedAt)}\n`;
    msg += `${latest.url}`;
    ctx.reply(msg, { ...menu });
});

bot.hears('SUPPLY', async (ctx) => {
    const scheduled = await getScheduledShorts();
    if(!scheduled.length) return ctx.reply('No scheduled shorts', menu);
    let msg = `SUPPLY (${scheduled.length})\n\n`;
    scheduled.slice(0, 5).forEach((s, i) => {
        msg += `${i+1}. ${s.title}\n`;
        msg += `   Time: ${s.time.toLocaleString()}\n\n`;
    });
    ctx.reply(msg, { ...menu });
});

bot.hears('REFRESH', async (ctx) => {
    scheduledCache = null;
    await ctx.reply('Refreshing data...');
    const scheduled = await getScheduledShorts(true);
    ctx.reply(`Refreshed\nScheduled: ${scheduled.length}`, menu);
});

async function start() {
    await initAuth();
    setInterval(refreshToken, 45 * 60 * 1000);
    bot.launch();
    console.log(`Bot Started | Target: ${TARGET_CHANNEL_HANDLE}`);
    console.log(`Auto reschedule: Videos with less than 2 views in 2 hours\n`);
    
    setTimeout(async () => {
        const latest = await getLatestPost();
        if(latest) {
            lastVideoId = latest.id;
            console.log(`Tracking: ${latest.title}`);
        }
        console.log(`Scheduled: ${(await getScheduledShorts()).length} videos\n`);
    }, 2000);
    
    setInterval(monitor, 30000);
    monitor();
}

process.on('SIGINT', () => {
    console.log('Shutting down...');
    bot.stop('SIGINT');
    process.exit();
});

start();
