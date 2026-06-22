const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('❌ BOT_TOKEN is missing.');
    process.exit(1);
}

// ─── Hardcoded values ────────────────────────────────
const BUTTON_URL = 'https://t.me/SniAdsEarnBot/app?startapp=6596414316';
// The image is in the repo – we use a local path
const IMAGE_PATH = path.join(__dirname, 'Ad.png');
// ──────────────────────────────────────────────────────

const bot = new TelegramBot(token);
const app = express();
app.use(bodyParser.json());

// ─── Webhook endpoint ────────────────────────────────
app.post('/webhook', (req, res) => {
    try {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    } catch (err) {
        console.error('Webhook error:', err);
        res.sendStatus(500);
    }
});

// ─── Health check ─────────────────────────────────────
app.get('/health', (req, res) => res.send('OK'));

// ─── Command handler ──────────────────────────────────
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;

    const options = {
        caption: 'Click the button below to start earning!',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Earn Now', url: BUTTON_URL }]
            ]
        }
    };

    // Send the local image file
    bot.sendPhoto(chatId, IMAGE_PATH, options)
        .then(() => console.log(`✅ Sent to ${chatId}`))
        .catch((err) => console.error('❌ Send error:', err));
});

// ─── Set webhook & start server ──────────────────────
const PORT = process.env.PORT || 3000;
// Render automatically provides RENDER_EXTERNAL_URL
const WEBHOOK_URL = `${process.env.RENDER_EXTERNAL_URL || 'https://your-app.onrender.com'}/webhook`;

bot.setWebHook(WEBHOOK_URL)
    .then(() => {
        console.log(`✅ Webhook set to ${WEBHOOK_URL}`);
        app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
    })
    .catch((err) => {
        console.error('❌ Failed to set webhook:', err);
        process.exit(1);
    });
