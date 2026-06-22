const { Telegraf, session, Markup } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ==================== CONFIG ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN environment variable missing.');

// ⚠️ CHANGE THIS IF 6596414316 IS NOT YOUR TELEGRAM ID
const ADMIN_ID = 6596414316;

const TELEBIRR_NUMBER = '0986179505';

// ==================== CONFIG FILE (payment toggle) ====================
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ payment_paused: false }, null, 2));
        return { payment_paused: false };
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        return { payment_paused: false };
    }
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function isPaymentPaused() {
    return loadConfig().payment_paused === true;
}

function togglePaymentPaused() {
    const config = loadConfig();
    config.payment_paused = !config.payment_paused;
    saveConfig(config);
    return config.payment_paused;
}

// ==================== BALANCE STORAGE ====================
const BALANCE_FILE = path.join(__dirname, 'balances.json');

function loadBalances() {
    if (!fs.existsSync(BALANCE_FILE)) {
        fs.writeFileSync(BALANCE_FILE, JSON.stringify({}));
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(BALANCE_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveBalances(balances) {
    fs.writeFileSync(BALANCE_FILE, JSON.stringify(balances, null, 2));
}

function getBalance(userId) {
    const balances = loadBalances();
    return balances[userId] || 0;
}

function setBalance(userId, amount) {
    const balances = loadBalances();
    balances[userId] = Math.round(amount * 100) / 100;
    saveBalances(balances);
}

function addBalance(userId, amount) {
    const current = getBalance(userId);
    const newBalance = current + amount;
    setBalance(userId, newBalance);
    return newBalance;
}

// ==================== BOT SETUP ====================
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// ==================== KEYBOARDS ====================
const mainKeyboard = Markup.keyboard([
    ['💰Wallet', '🤖Get Bot Start'],
    ['📢Get Channel Subscribe', '👑Get Group Join'],
    ['💲Earn']
]).resize();

const walletKeyboard = Markup.keyboard([
    ['📥Deposit', '📥Withdraw'],
    ['🔙Back']
]).resize();

// ==================== LINK CONVERTER ====================
function convertBotLink(link) {
    const match = link.match(/^(https?:\/\/t\.me\/[^\/?]+)\/app\?startapp=(.+)$/);
    return match ? `${match[1]}?start=${match[2]}` : link;
}

// ==================== SCENES ====================
const { Stage, WizardScene } = Scenes;

// ---------- Deposit Scene ----------
const depositScene = new WizardScene(
    'deposit',
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Payments are paused. Try later.');
            return ctx.scene.leave();
        }
        await ctx.reply('Enter amount in Birr to deposit:');
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Payments paused. Cancelled.');
            return ctx.scene.leave();
        }
        const amount = parseFloat(ctx.message.text);
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('Enter a valid positive number.');
            return;
        }
        ctx.wizard.state.amount = amount;
        await ctx.reply(
            `💳 Send exactly **${amount} Birr** to Telebirr:\n` +
            `\`${TELEBIRR_NUMBER}\`\n\n` +
            `Then send a screenshot here.`
        );
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Payments paused. Cancelled.');
            return ctx.scene.leave();
        }
        const photo = ctx.message.photo;
        if (!photo) {
            await ctx.reply('Please send a photo (screenshot).');
            return;
        }
        const userId = ctx.from.id;
        const amount = ctx.wizard.state.amount;
        const caption =
            `📥 Deposit Screenshot\nUser: ${userId} (${ctx.from.first_name || ''})\nAmount: ${amount} Birr\n` +
            `Use /addbalance ${userId} ${amount} to credit.`;
        await ctx.telegram.sendPhoto(ADMIN_ID, photo[photo.length - 1].file_id, { caption });
        await ctx.reply('✅ Screenshot sent to admin for verification.', walletKeyboard);
        return ctx.scene.leave();
    }
);

// ---------- Withdraw Scene ----------
const withdrawScene = new WizardScene(
    'withdraw',
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Withdrawals paused.');
            return ctx.scene.leave();
        }
        await ctx.reply('Amount (min 5, max 25, fee 1 Birr):');
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Paused. Cancelled.');
            return ctx.scene.leave();
        }
        const amount = parseFloat(ctx.message.text);
        if (isNaN(amount) || amount < 5 || amount > 25) {
            await ctx.reply('Enter between 5 and 25.');
            return;
        }
        const userId = ctx.from.id;
        const balance = getBalance(userId);
        if (balance < amount + 1) {
            await ctx.reply(`Insufficient balance. You have ${balance}, need ${amount + 1}.`);
            return ctx.scene.leave();
        }
        ctx.wizard.state.amount = amount;
        await ctx.reply('Enter Telebirr phone (09XXXXXXXX):');
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Paused. Cancelled.');
            return ctx.scene.leave();
        }
        const phone = ctx.message.text.trim();
        if (!phone.match(/^09\d{8}$/)) {
            await ctx.reply('Invalid. Enter 09XXXXXXXX.');
            return;
        }
        const userId = ctx.from.id;
        const { amount } = ctx.wizard.state;
        const netAmount = amount - 1;
        const newBalance = addBalance(userId, -(amount + 1));
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `📤 Withdrawal\nUser: ${userId}\nAmount: ${amount}\nNet: ${netAmount}\nPhone: ${phone}\nNew balance: ${newBalance}`
        );
        await ctx.reply(`✅ Request sent. You'll receive ${netAmount} Birr after admin approval.`, walletKeyboard);
        return ctx.scene.leave();
    }
);

// ---------- Get Bot Start Scene ----------
const botStartScene = new WizardScene(
    'botstart',
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Purchases paused.');
            return ctx.scene.leave();
        }
        await ctx.reply('Send bot link (e.g., https://t.me/SomeBot):');
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Paused. Cancelled.');
            return ctx.scene.leave();
        }
        const link = ctx.message.text.trim();
        if (!link.includes('t.me/')) {
            await ctx.reply('Invalid. Must contain t.me/');
            return;
        }
        ctx.wizard.state.link = convertBotLink(link);
        await ctx.reply('How many starts? (1‑10)');
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Paused. Cancelled.');
            return ctx.scene.leave();
        }
        const qty = parseInt(ctx.message.text);
        if (isNaN(qty) || qty < 1 || qty > 10) {
            await ctx.reply('Enter 1‑10.');
            return;
        }
        const userId = ctx.from.id;
        const totalCost = qty * 1;
        const balance = getBalance(userId);
        if (balance < totalCost) {
            await ctx.reply(`Insufficient balance. You have ${balance}, need ${totalCost}.`);
            return ctx.scene.leave();
        }
        addBalance(userId, -totalCost);
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `🤖 Bot Start Order\nUser: ${userId}\nLink: ${ctx.wizard.state.link}\nQty: ${qty}\nCost: ${totalCost} Birr\nBalance: ${getBalance(userId)}`
        );
        await ctx.reply(`✅ Order placed. ${totalCost} Birr deducted. Admin will process.`);
        return ctx.scene.leave();
    }
);

// ---------- Get Channel Subscribe Scene ----------
const channelScene = new WizardScene(
    'channel',
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Purchases paused.');
            return ctx.scene.leave();
        }
        await ctx.reply('⚠️ Bot must be admin in the channel.\nSend channel link:');
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Paused. Cancelled.');
            return ctx.scene.leave();
        }
        const link = ctx.message.text.trim();
        if (!link.includes('t.me/')) {
            await ctx.reply('Invalid.');
            return;
        }
        ctx.wizard.state.link = link;
        await ctx.reply('How many members? (1‑10)');
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Paused. Cancelled.');
            return ctx.scene.leave();
        }
        const qty = parseInt(ctx.message.text);
        if (isNaN(qty) || qty < 1 || qty > 10) {
            await ctx.reply('Enter 1‑10.');
            return;
        }
        const userId = ctx.from.id;
        const totalCost = qty * 1;
        const balance = getBalance(userId);
        if (balance < totalCost) {
            await ctx.reply(`Insufficient balance. You have ${balance}, need ${totalCost}.`);
            return ctx.scene.leave();
        }
        addBalance(userId, -totalCost);
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `📢 Channel Subscribe\nUser: ${userId}\nChannel: ${ctx.wizard.state.link}\nQty: ${qty}\nCost: ${totalCost} Birr\nBalance: ${getBalance(userId)}`
        );
        await ctx.reply(`✅ Order placed. ${totalCost} Birr deducted. Admin will process.`);
        return ctx.scene.leave();
    }
);

// ---------- Get Group Join Scene ----------
const groupScene = new WizardScene(
    'group',
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Purchases paused.');
            return ctx.scene.leave();
        }
        await ctx.reply('⚠️ Bot must be admin in the group.\nSend group link:');
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Paused. Cancelled.');
            return ctx.scene.leave();
        }
        const link = ctx.message.text.trim();
        if (!link.includes('t.me/')) {
            await ctx.reply('Invalid.');
            return;
        }
        ctx.wizard.state.link = link;
        await ctx.reply('How many members? (1‑10)');
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (isPaymentPaused()) {
            await ctx.reply('🛑 Paused. Cancelled.');
            return ctx.scene.leave();
        }
        const qty = parseInt(ctx.message.text);
        if (isNaN(qty) || qty < 1 || qty > 10) {
            await ctx.reply('Enter 1‑10.');
            return;
        }
        const userId = ctx.from.id;
        const totalCost = qty * 1;
        const balance = getBalance(userId);
        if (balance < totalCost) {
            await ctx.reply(`Insufficient balance. You have ${balance}, need ${totalCost}.`);
            return ctx.scene.leave();
        }
        addBalance(userId, -totalCost);
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `👑 Group Join\nUser: ${userId}\nGroup: ${ctx.wizard.state.link}\nQty: ${qty}\nCost: ${totalCost} Birr\nBalance: ${getBalance(userId)}`
        );
        await ctx.reply(`✅ Order placed. ${totalCost} Birr deducted. Admin will process.`);
        return ctx.scene.leave();
    }
);

// ==================== EARN HANDLER ====================
bot.hears('💲Earn', async (ctx) => {
    await ctx.reply(
        '📌 To earn, you can complete tasks provided by admin.\n' +
        'Click the button below to request available tasks.',
        Markup.inlineKeyboard([
            Markup.button.callback('📋 Request Tasks', 'request_tasks')
        ])
    );
});

bot.action('request_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const name = ctx.from.first_name || '';
    await ctx.telegram.sendMessage(
        ADMIN_ID,
        `📋 Task Request\nUser: ${userId} (${name}) wants tasks.`
    );
    await ctx.reply('✅ Request sent to admin. They will contact you with available tasks.');
    await ctx.reply('Main menu', mainKeyboard);
});

// ==================== COMMAND HANDLERS ====================
bot.start(async (ctx) => {
    await ctx.reply('Welcome to SniAdsEarnBot!\nUse the buttons below.', mainKeyboard);
});

bot.hears('💰Wallet', async (ctx) => {
    const balance = getBalance(ctx.from.id);
    await ctx.reply(`Your balance: ${balance} Birr`, walletKeyboard);
});

bot.hears('🤖Get Bot Start', async (ctx) => {
    await ctx.scene.enter('botstart');
});

bot.hears('📢Get Channel Subscribe', async (ctx) => {
    await ctx.scene.enter('channel');
});

bot.hears('👑Get Group Join', async (ctx) => {
    await ctx.scene.enter('group');
});

bot.hears('📥Deposit', async (ctx) => {
    await ctx.scene.enter('deposit');
});

bot.hears('📥Withdraw', async (ctx) => {
    await ctx.scene.enter('withdraw');
});

bot.hears('🔙Back', async (ctx) => {
    await ctx.reply('Main menu', mainKeyboard);
});

// ==================== ADMIN COMMANDS ====================
function isAdmin(ctx) {
    return ctx.from.id === ADMIN_ID;
}

bot.command('checkbalance', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        await ctx.reply('Usage: /checkbalance <user_id>');
        return;
    }
    const userId = parseInt(args[1]);
    if (isNaN(userId)) {
        await ctx.reply('Invalid user ID.');
        return;
    }
    const balance = getBalance(userId);
    await ctx.reply(`User ${userId} has ${balance} Birr.`);
});

bot.command('addbalance', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 3) {
        await ctx.reply('Usage: /addbalance <user_id> <amount>');
        return;
    }
    const userId = parseInt(args[1]);
    const amount = parseFloat(args[2]);
    if (isNaN(userId) || isNaN(amount) || amount <= 0) {
        await ctx.reply('Invalid user ID or amount.');
        return;
    }
    const newBalance = addBalance(userId, amount);
    await ctx.reply(`Added ${amount} Birr. New balance: ${newBalance}`);
});

bot.command('deductbalance', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 3) {
        await ctx.reply('Usage: /deductbalance <user_id> <amount>');
        return;
    }
    const userId = parseInt(args[1]);
    const amount = parseFloat(args[2]);
    if (isNaN(userId) || isNaN(amount) || amount <= 0) {
        await ctx.reply('Invalid.');
        return;
    }
    const balance = getBalance(userId);
    if (balance < amount) {
        await ctx.reply(`User only has ${balance} Birr. Cannot deduct ${amount}.`);
        return;
    }
    const newBalance = addBalance(userId, -amount);
    await ctx.reply(`Deducted ${amount} Birr. New balance: ${newBalance}`);
});

bot.command('setbalance', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 3) {
        await ctx.reply('Usage: /setbalance <user_id> <amount>');
        return;
    }
    const userId = parseInt(args[1]);
    const amount = parseFloat(args[2]);
    if (isNaN(userId) || isNaN(amount) || amount < 0) {
        await ctx.reply('Invalid user ID or amount (must be >= 0).');
        return;
    }
    setBalance(userId, amount);
    await ctx.reply(`Balance for user ${userId} set to ${amount} Birr.`);
});

bot.command('togglepayments', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const newStatus = togglePaymentPaused();
    const statusText = newStatus ? '🛑 PAUSED' : '✅ ACTIVE';
    await ctx.reply(`Payment status changed to: ${statusText}`);
});

bot.command('paymentstatus', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const paused = isPaymentPaused();
    await ctx.reply(`Current status: ${paused ? '🛑 PAUSED' : '✅ ACTIVE'}`);
});

// ==================== REGISTER SCENES ====================
const stage = new Stage([depositScene, withdrawScene, botStartScene, channelScene, groupScene]);
bot.use(stage.middleware());

// ==================== EXPRESS SERVER WITH WEBHOOK ====================
const app = express();
const PORT = process.env.PORT || 3000;

// Determine the webhook URL
let WEBHOOK_URL = process.env.WEBHOOK_URL;
if (!WEBHOOK_URL) {
    // If running on Render, use RENDER_EXTERNAL_URL
    const renderUrl = process.env.RENDER_EXTERNAL_URL;
    if (renderUrl) {
        WEBHOOK_URL = `${renderUrl}/webhook`;
    } else {
        // Fallback for local development – use polling instead
        console.warn('No webhook URL provided. Falling back to polling.');
    }
}

// If we have a webhook URL, set it and use webhook mode
if (WEBHOOK_URL) {
    // Set webhook on startup
    bot.telegram.setWebhook(WEBHOOK_URL).then((ok) => {
        if (ok) {
            console.log(`✅ Webhook set to ${WEBHOOK_URL}`);
        } else {
            console.error('❌ Failed to set webhook');
        }
    }).catch(err => {
        console.error('Error setting webhook:', err);
    });

    // Use webhook callback
    app.use(express.json());
    app.use('/webhook', bot.webhookCallback('/webhook'));
} else {
    // Fallback to polling if no webhook URL
    console.log('⚠️ No webhook URL, using polling.');
    bot.launch().then(() => console.log('🤖 Bot started in polling mode.'));
}

// Health check endpoint
app.get('/', (req, res) => res.send('Bot is running with webhooks.'));

app.listen(PORT, () => {
    console.log(`✅ Web server listening on port ${PORT}`);
});

// Graceful stop for polling fallback
process.once('SIGINT', () => {
    if (!WEBHOOK_URL) bot.stop('SIGINT');
    process.exit(0);
});
process.once('SIGTERM', () => {
    if (!WEBHOOK_URL) bot.stop('SIGTERM');
    process.exit(0);
});
