const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');
const https = require('https');
const dns = require('dns');

// Force IPv4 to avoid ENOTFOUND errors
dns.setDefaultResultOrder('ipv4first');

// ============ CREDENTIALS ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID || 'your_telegram_id'; // Replace with your numeric ID
const HF_TOKEN = process.env.HF_TOKEN || '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';

// ============ CONSTANTS ============
const PORT = process.env.PORT || 3000;
const DEVELOPER_CONTACT = '@Ace_spy';
const BOT_NAME = 'Ace AI';
const ADMIN_PASSWORD = 'Noah@1221';
const REQUIRED_CHANNEL = '@bot_Farming';

// Daily limits
const MAX_IMAGES_PER_DAY = 10;
const MAX_CHATS_PER_DAY = 50;

// ============ EXPRESS SETUP ============
const app = express();
app.use(cors());
app.use(session({
    secret: 'ace_ai_secret_2025',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ IN‑MEMORY STORES ============
const userSessions = new Map(); // userId -> { mode: null|'image'|'chat', chatHistory: [] }
const userMessages = new Map(); // userId -> array of { from, text, date }
const userDailyLimits = new Map(); // userId -> { date, imageCount, chatCount }

// ============ CUSTOM AXIOS INSTANCE (IPv4 + fallback) ============
const axiosInstance = axios.create({
    httpsAgent: new https.Agent({ family: 4 }),
    timeout: 60000
});

// ============ DAILY LIMITS ============
function checkUserLimit(userId, type) {
    const today = new Date().toISOString().split('T')[0];
    const record = userDailyLimits.get(userId) || { date: today, imageCount: 0, chatCount: 0 };
    if (record.date !== today) {
        record.date = today;
        record.imageCount = 0;
        record.chatCount = 0;
    }
    const limits = { image: MAX_IMAGES_PER_DAY, chat: MAX_CHATS_PER_DAY };
    const key = type + 'Count';
    if (record[key] >= limits[type]) return false;
    record[key]++;
    userDailyLimits.set(userId, record);
    return true;
}

// ============ ADMIN CHAT SYSTEM ============
function addMessage(userId, text, from = 'user') {
    if (!userMessages.has(userId)) userMessages.set(userId, []);
    const history = userMessages.get(userId);
    history.push({ from, text, date: new Date().toISOString() });
    if (history.length > 50) history.shift();
}

// ============ TELEGRAM BOT ============
const bot = new Telegraf(BOT_TOKEN);

// ============ HF TOKEN ROTATION ============
const HF_TOKENS = [HF_TOKEN];
// Add more tokens here if you have multiple accounts:
// const HF_TOKENS = [process.env.HF_TOKEN_1, process.env.HF_TOKEN_2, ...];
let tokenIndex = 0;
let tokenUsage = HF_TOKENS.map(() => 0);
let tokenReset = HF_TOKENS.map(() => Date.now());

function getHfToken() {
    const now = Date.now();
    const ONE_MINUTE = 60000;
    for (let i = 0; i < HF_TOKENS.length; i++) {
        if (now - tokenReset[i] > ONE_MINUTE) {
            tokenUsage[i] = 0;
            tokenReset[i] = now;
        }
        if (tokenUsage[i] < 25) { // leave buffer
            tokenIndex = i;
            tokenUsage[i]++;
            return HF_TOKENS[i];
        }
    }
    return null; // all tokens exhausted for this minute
}

// ============ CHANNEL CHECK ============
async function checkChannelMembership(userId) {
    try {
        const chatMember = await bot.telegram.getChatMember(REQUIRED_CHANNEL, userId);
        return chatMember.status === 'member' || chatMember.status === 'administrator' || chatMember.status === 'creator';
    } catch { return false; }
}

// ============ MAIN MENU ============
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('🎨 Generate Image', 'image')],
    [Markup.button.callback('💬 Chat with AI', 'chat')],
    [Markup.button.callback('📊 Status', 'status')],
    [Markup.button.callback('🆘 Contact', 'contact')]
]);

// ============ EXPRESS ROUTES ============
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>${BOT_NAME}</title></head>
            <body style="font-family:Arial;text-align:center;padding:50px;background:#0d1117;color:#fff;">
                <h1>🤖 ${BOT_NAME}</h1>
                <p>Bot is running!</p>
                <p><a href="/admin" style="color:#58a6ff;">Admin Panel</a></p>
                <p>Contact: ${DEVELOPER_CONTACT}</p>
            </body>
        </html>
    `);
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', sessions: userSessions.size, messages: userMessages.size });
});

// ============ WEB ADMIN PANEL ============
app.get('/admin/login', (req, res) => {
    if (req.session.adminLoggedIn) return res.redirect('/admin');
    res.send(`
        <html>
            <head><title>Admin Login</title>
            <style>
                body { font-family: Arial; background: #0d1117; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .login-box { background: #161b22; padding: 40px; border-radius: 12px; width: 300px; }
                input, button { width: 100%; padding: 10px; margin: 8px 0; border-radius: 6px; border: none; }
                input { background: #0d1117; color: #fff; border: 1px solid #30363d; }
                button { background: #238636; color: #fff; font-weight: bold; cursor: pointer; }
                button:hover { background: #2ea043; }
                .error { color: #f85149; }
            </style>
            </head>
            <body>
                <div class="login-box">
                    <h2>🔐 Admin Login</h2>
                    <form method="POST" action="/admin/login">
                        <input type="password" name="password" placeholder="Enter password" required>
                        <button type="submit">Login</button>
                    </form>
                    ${req.query.error ? '<p class="error">❌ Invalid password</p>' : ''}
                </div>
            </body>
        </html>
    `);
});

app.post('/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        req.session.adminLoggedIn = true;
        return res.redirect('/admin');
    }
    res.redirect('/admin/login?error=1');
});

app.get('/admin/logout', (req, res) => {
    req.session.adminLoggedIn = false;
    res.redirect('/admin/login');
});

app.get('/admin', (req, res) => {
    if (!req.session.adminLoggedIn) return res.redirect('/admin/login');
    const users = Array.from(userMessages.keys());
    let html = `
        <html>
            <head><title>Admin Dashboard</title>
            <style>
                body { font-family: Arial; background: #0d1117; color: #fff; padding: 30px; }
                .container { max-width: 1200px; margin: 0 auto; }
                .card { background: #161b22; padding: 20px; border-radius: 10px; margin: 20px 0; border: 1px solid #30363d; }
                .stats { display: flex; gap: 20px; flex-wrap: wrap; }
                .stat { background: #1c2333; padding: 15px; border-radius: 8px; flex: 1; min-width: 150px; }
                .stat h3 { margin: 0; color: #58a6ff; }
                .stat p { font-size: 24px; margin: 5px 0; }
                table { width: 100%; border-collapse: collapse; margin-top: 15px; }
                th, td { text-align: left; padding: 8px; border-bottom: 1px solid #30363d; }
                th { color: #58a6ff; }
                .logout { float: right; color: #f85149; text-decoration: none; }
                .logout:hover { text-decoration: underline; }
                .msg-preview { font-size: 12px; color: #8b949e; }
                .broadcast-box { background: #1c2333; padding: 15px; border-radius: 8px; margin: 15px 0; }
                .broadcast-box textarea { width: 100%; background: #0d1117; color: #fff; border: 1px solid #30363d; border-radius: 6px; padding: 8px; }
                .broadcast-box button { background: #238636; color: #fff; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; }
            </style>
            </head>
            <body>
                <div class="container">
                    <h1>📊 Admin Dashboard <a href="/admin/logout" class="logout">Logout</a></h1>
                    <div class="stats">
                        <div class="stat"><h3>Total Users</h3><p>${userSessions.size}</p></div>
                        <div class="stat"><h3>Messages Stored</h3><p>${users.reduce((acc, uid) => acc + userMessages.get(uid).length, 0)}</p></div>
                    </div>
                    <div class="card">
                        <h2>📣 Broadcast</h2>
                        <div class="broadcast-box">
                            <form action="/admin/broadcast" method="POST">
                                <textarea name="message" rows="4" placeholder="Type your broadcast message..." required></textarea>
                                <button type="submit">Send to All Users</button>
                            </form>
                        </div>
                    </div>
                    <div class="card">
                        <h2>👥 Users</h2>
                        <table>
                            <tr><th>User ID</th><th>Last Message</th><th>Messages</th></tr>
    `;
    for (const uid of users) {
        const history = userMessages.get(uid);
        const last = history[history.length-1];
        html += `<tr><td>${uid}</td><td class="msg-preview">${last.text.substring(0,50)}...</td><td>${history.length}</td></tr>`;
    }
    html += `
                        </table>
                    </div>
                    <div class="card">
                        <h2>📩 Recent Messages</h2>
                        <ul>
    `;
    let recent = [];
    for (const uid of users) {
        for (const entry of userMessages.get(uid).slice(-5)) {
            recent.push({ uid, ...entry });
        }
    }
    recent.sort((a,b) => new Date(b.date) - new Date(a.date));
    for (const msg of recent.slice(0,20)) {
        const who = msg.from === 'user' ? '👤' : '🤖';
        html += `<li><strong>${msg.uid}</strong> ${who} ${msg.date}: ${msg.text}</li>`;
    }
    html += `
                        </ul>
                    </div>
                    <div class="card">
                        <p>💡 Use Telegram commands <code>/list</code>, <code>/chat &lt;id&gt;</code>, <code>/reply &lt;id&gt; message</code>.</p>
                        <p><a href="/" style="color:#58a6ff;">← Back to Home</a></p>
                    </div>
                </div>
            </body>
        </html>
    `;
    res.send(html);
});

// ============ BROADCAST ENDPOINT ============
app.post('/admin/broadcast', async (req, res) => {
    if (!req.session.adminLoggedIn) return res.redirect('/admin/login');
    const message = req.body.message;
    if (!message) return res.redirect('/admin');
    const users = Array.from(userSessions.keys());
    let sent = 0, failed = 0;
    for (const uid of users) {
        try {
            await bot.telegram.sendMessage(uid, `📢 *Broadcast from Admin:*\n\n${message}`, { parse_mode: 'Markdown' });
            sent++;
        } catch (e) {
            failed++;
        }
    }
    res.send(`
        <html>
            <head><title>Broadcast Result</title></head>
            <body style="font-family:Arial;text-align:center;padding:50px;background:#0d1117;color:#fff;">
                <h1>✅ Broadcast Sent</h1>
                <p>Sent to ${sent} users, failed: ${failed}</p>
                <a href="/admin" style="color:#58a6ff;">← Back to Dashboard</a>
            </body>
        </html>
    `);
});
// ============ AI FUNCTIONS WITH FALLBACK & RETRY ============
const IMAGE_MODELS = [
    'stabilityai/stable-diffusion-2-1',
    'runwayml/stable-diffusion-v1-5',
    'prompthero/openjourney-v4'
];

const CHAT_MODELS = [
    'deepseek-ai/DeepSeek-V3',
    'meta-llama/Llama-3.2-3B-Instruct',
    'mistralai/Mistral-7B-Instruct-v0.3'
];

// Helper: call HF with retry on ENOTFOUND
async function callHuggingFace(url, model, token, data, responseType = 'arraybuffer', timeoutMs = 60000) {
    const maxRetries = 3;
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            console.log(`🌐 Calling: ${url}/${model} (attempt ${attempt+1})`);
            const response = await axiosInstance({
                method: 'post',
                url: `${url}/${model}`,
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                data,
                responseType,
                timeout: timeoutMs
            });
            return response.data;
        } catch (error) {
            if ((error.code === 'ENOTFOUND' || error.code === 'ECONNRESET') && attempt < maxRetries - 1) {
                console.log(`🔄 DNS/connection error, retrying (${attempt+1}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
                attempt++;
                continue;
            }
            console.log(`❌ Attempt ${attempt+1} failed:`, error.message);
            if (attempt === 0 && url.includes('api-inference')) {
                console.log(`🔄 Switching to fallback endpoint...`);
                return callHuggingFace('https://huggingface.co/api/inference', model, token, data, responseType, timeoutMs);
            }
            throw error;
        }
    }
    throw new Error(`Failed after ${maxRetries} attempts`);
}

async function generateImage(prompt) {
    const token = getHfToken();
    if (!token) throw new Error('All tokens rate-limited. Try again in a minute.');
    let lastError;
    for (const model of IMAGE_MODELS) {
        try {
            console.log(`🎨 Trying image model: ${model}`);
            const data = await callHuggingFace('https://api-inference.huggingface.co/models', model, token, { inputs: prompt }, 'arraybuffer', 60000);
            return data;
        } catch (e) {
            console.log(`❌ ${model} failed:`, e.message);
            lastError = e;
        }
    }
    throw new Error(`All image models failed: ${lastError?.message || 'unknown error'}`);
}

async function chatWithDeepSeek(userId, prompt) {
    const session = userSessions.get(userId);
    const history = session?.chatHistory || [];
    let lastError;
    for (const model of CHAT_MODELS) {
        try {
            console.log(`💬 Trying chat model: ${model}`);
            const data = await callHuggingFace(
                'https://api-inference.huggingface.co/models',
                model,
                HF_TOKEN,
                {
                    inputs: prompt,
                    parameters: { max_new_tokens: 500, temperature: 0.7, return_full_text: false }
                },
                'json',
                30000
            );
            let reply = data?.generated_text || data?.[0]?.generated_text || '';
            if (reply) {
                // Update history
                if (session) {
                    session.chatHistory = session.chatHistory || [];
                    session.chatHistory.push({ role: 'user', content: prompt });
                    session.chatHistory.push({ role: 'assistant', content: reply });
                    if (session.chatHistory.length > 20) session.chatHistory = session.chatHistory.slice(-20);
                    userSessions.set(userId, session);
                }
                return reply;
            }
        } catch (e) {
            console.log(`❌ ${model} failed:`, e.message);
            lastError = e;
        }
    }
    return `Sorry, I'm having trouble thinking. Please try again later. (All models failed)`;
}

// ============ BOT START ============
bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!userSessions.has(userId)) {
        userSessions.set(userId, { mode: null, chatHistory: [] });
    }
    const isMember = await checkChannelMembership(ctx.from.id);
    if (!isMember) {
        return ctx.reply(
            `❌ *Join ${REQUIRED_CHANNEL} first!*`,
            Markup.inlineKeyboard([
                [Markup.button.url('📢 Join Channel', `https://t.me/${REQUIRED_CHANNEL.replace('@', '')}`)],
                [Markup.button.callback('✅ I\'ve joined', 'verify_channel')]
            ]),
            { parse_mode: 'Markdown' }
        );
    }
    await ctx.reply(
        `🤖 *${BOT_NAME}*\n\nSend /generate or tap a button below.\n\n📌 You are in the channel.`,
        { parse_mode: 'Markdown', ...mainMenu }
    );
});

bot.action('verify_channel', async (ctx) => {
    const userId = ctx.from.id.toString();
    const isMember = await checkChannelMembership(ctx.from.id);
    if (!isMember) {
        return ctx.answerCbQuery('❌ Not a member yet! Join first.', { show_alert: true });
    }
    await ctx.editMessageText(
        `✅ Verified! You are a member of ${REQUIRED_CHANNEL}.\n\n🤖 *${BOT_NAME}*\n\nSend /generate or tap a button below.`,
        { parse_mode: 'Markdown', ...mainMenu }
    );
    await ctx.answerCbQuery('Verified!');
});

// ============ COMMANDS ============
bot.command('generate', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session) return ctx.reply('Please send /start first.');
    const isMember = await checkChannelMembership(ctx.from.id);
    if (!isMember) return ctx.reply(`❌ Join ${REQUIRED_CHANNEL} first.`);
    await ctx.reply(
        `🎨 *Choose what to generate:*`,
        Markup.inlineKeyboard([
            [Markup.button.callback('🖼️ Image', 'image')],
            [Markup.button.callback('💬 Chat', 'chat')],
            [Markup.button.callback('🔙 Back', 'back_to_menu')]
        ]),
        { parse_mode: 'Markdown' }
    );
});

bot.command('cancel', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (session) { session.mode = null; userSessions.set(userId, session); }
    await ctx.reply('✅ Cancelled. Send /generate to start again.', { ...mainMenu });
});

// ============ ACTIONS ============
bot.action('image', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session) return ctx.reply('Send /start first.');
    session.mode = 'image';
    userSessions.set(userId, session);
    await ctx.editMessageText(
        `🎨 *Describe your image*\n\nSend a detailed prompt.\nType /cancel to stop.`,
        { parse_mode: 'Markdown' }
    );
});

bot.action('chat', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!session) return ctx.reply('Send /start first.');
    session.mode = 'chat';
    userSessions.set(userId, session);
    await ctx.editMessageText(
        `💬 *Chat with AI*\n\nSend me your message.\nType /cancel to stop.`,
        { parse_mode: 'Markdown' }
    );
});

bot.action('back_to_menu', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (session) { session.mode = null; userSessions.set(userId, session); }
    await ctx.editMessageText(
        `🤖 *${BOT_NAME}*\n\nSend /generate or tap a button below.`,
        { parse_mode: 'Markdown', ...mainMenu }
    );
});

bot.action('status', async (ctx) => {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    const mode = session?.mode || 'idle';
    const limits = userDailyLimits.get(userId) || { imageCount: 0, chatCount: 0 };
    await ctx.editMessageText(
        `📊 *Status*\n\nMode: ${mode}\nImages today: ${limits.imageCount}/${MAX_IMAGES_PER_DAY}\nChats today: ${limits.chatCount}/${MAX_CHATS_PER_DAY}`,
        { parse_mode: 'Markdown', ...mainMenu }
    );
});

bot.action('contact', async (ctx) => {
    await ctx.editMessageText(
        `🆘 *Contact*\n\n👨‍💻 ${DEVELOPER_CONTACT}`,
        Markup.inlineKeyboard([
            [Markup.button.url('📩 Contact', `https://t.me/${DEVELOPER_CONTACT.replace('@', '')}`)],
            [Markup.button.callback('🔙 Back', 'back_to_menu')]
        ]),
        { parse_mode: 'Markdown' }
    );
});
// ============ IMAGE GENERATION HANDLER ============
async function handleImage(ctx, prompt) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!checkUserLimit(userId, 'image')) {
        return ctx.reply(`❌ Daily image limit (${MAX_IMAGES_PER_DAY}) reached. Try again tomorrow.`);
    }
    const msg = await ctx.reply(`🎨 Generating image... (may take 20–60 seconds)`);
    try {
        const imageBuffer = await generateImage(prompt);
        session.mode = null;
        userSessions.set(userId, session);
        await ctx.telegram.sendPhoto(ctx.chat.id, { source: imageBuffer }, {
            caption: `🖼️ *Generated from:*\n${prompt}`,
            parse_mode: 'Markdown',
            ...mainMenu
        });
        await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
    } catch (error) {
        console.error('Image error:', error.message);
        session.mode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ *Image generation failed after trying all models.*\n\nError: ${error.message}\n\nPlease try again later.`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    }
}

// ============ CHAT HANDLER ============
async function handleChat(ctx, prompt) {
    const userId = ctx.from.id.toString();
    const session = userSessions.get(userId);
    if (!checkUserLimit(userId, 'chat')) {
        return ctx.reply(`❌ Daily chat limit (${MAX_CHATS_PER_DAY}) reached. Try again tomorrow.`);
    }
    const msg = await ctx.reply(`💬 Thinking...`);
    try {
        const reply = await chatWithDeepSeek(userId, prompt);
        session.mode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `💬 *AI reply:*\n\n${reply}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    } catch (error) {
        console.error('Chat error:', error.message);
        session.mode = null;
        userSessions.set(userId, session);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null,
            `❌ *Chat error:*\n${error.message}`,
            { parse_mode: 'Markdown', ...mainMenu }
        );
    }
}

// ============ TEXT HANDLER ============
bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    const session = userSessions.get(userId);
    if (!session) {
        addMessage(userId, text, 'user');
        try {
            await bot.telegram.sendMessage(ADMIN_ID, `📩 *New from* @${ctx.from.username || 'user'} (ID: ${userId})\n\n${text}`, { parse_mode: 'Markdown' });
        } catch {}
        return ctx.reply('Please send /start to use the bot.');
    }

    // If not in a mode, forward to admin
    if (!session.mode) {
        addMessage(userId, text, 'user');
        try {
            await bot.telegram.sendMessage(ADMIN_ID, `📩 *New from* @${ctx.from.username || 'user'} (ID: ${userId})\n\n${text}`, { parse_mode: 'Markdown' });
        } catch {}
        return ctx.reply('Send /generate to start.');
    }

    // Handle modes
    if (session.mode === 'image') await handleImage(ctx, text);
    else if (session.mode === 'chat') await handleChat(ctx, text);
    else {
        session.mode = null;
        userSessions.set(userId, session);
        ctx.reply('Unknown mode. Send /generate.');
    }
});

// ============ ADMIN COMMANDS (Telegram) ============
bot.command('list', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('⛔ Admin only.');
    const users = Array.from(userMessages.keys());
    if (users.length === 0) return ctx.reply('No messages.');
    let msg = '*Recent users:*\n\n';
    for (const uid of users) {
        const history = userMessages.get(uid);
        const last = history[history.length-1];
        msg += `👤 \`${uid}\` – last: ${last.text.substring(0,30)}...\n`;
    }
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('chat', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('⛔ Admin only.');
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /chat <user_id>');
    const uid = args[1];
    const history = userMessages.get(uid);
    if (!history || history.length === 0) return ctx.reply('No messages.');
    let msg = `*Chat with ${uid}:*\n\n`;
    for (const entry of history.slice(-20)) {
        const who = entry.from === 'user' ? '👤 User' : '🤖 Admin';
        msg += `${who} (${entry.date}): ${entry.text}\n`;
    }
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('reply', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('⛔ Admin only.');
    const args = ctx.message.text.split(' ');
    if (args.length < 3) return ctx.reply('Usage: /reply <user_id> <message>');
    const uid = args[1];
    const message = args.slice(2).join(' ');
    try {
        await bot.telegram.sendMessage(uid, `🤖 *Admin reply:*\n\n${message}`, { parse_mode: 'Markdown' });
        addMessage(uid, message, 'admin');
        await ctx.reply(`✅ Replied to ${uid}`);
    } catch(e) {
        await ctx.reply(`❌ Failed: ${e.message}`);
    }
});

bot.command('broadcast', async (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('⛔ Admin only.');
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('Usage: /broadcast <message>');
    const message = args.slice(1).join(' ');
    const users = Array.from(userSessions.keys());
    let sent = 0, failed = 0;
    for (const uid of users) {
        try {
            await bot.telegram.sendMessage(uid, `📢 *Broadcast:*\n\n${message}`, { parse_mode: 'Markdown' });
            sent++;
        } catch { failed++; }
    }
    await ctx.reply(`✅ Broadcast sent to ${sent} users. Failed: ${failed}`);
});
