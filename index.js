const { Telegraf, session, Markup, Scenes } = require('telegraf');
const fs = require('fs');
const path = require('path');

// ==================== CONFIG ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN environment variable missing.');

// ⚠️ CHANGE THIS TO YOUR TELEGRAM USER ID
const ADMIN_ID = 6596414316; // <-- replace with your numeric ID

const TELEBIRR_NUMBER = '0986179505'; // Telebirr number to send payment to

// ==================== BALANCE STORAGE (JSON file) ====================
const BALANCE_FILE = path.join(__dirname, 'balances.json');

function loadBalances() {
    if (!fs.existsSync(BALANCE_FILE)) {
        fs.writeFileSync(BALANCE_FILE, JSON.stringify({}));
        return {};
    }
    try {
        const data = fs.readFileSync(BALANCE_FILE, 'utf8');
        return JSON.parse(data);
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

// ---------- Deposit Scene (Telebirr manual) ----------
const depositScene = new WizardScene(
    'deposit',
    async (ctx) => {
        await ctx.reply('Enter amount in Birr to deposit:');
        return ctx.wizard.next();
    },
    async (ctx) => {
        const amount = parseFloat(ctx.message.text);
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('Please enter a valid positive number.');
            return;
        }
        ctx.wizard.state.amount = amount;
        // Show payment instructions
        await ctx.reply(
            `💳 Please send exactly **${amount} Birr** to Telebirr number:\n` +
            `\`${TELEBIRR_NUMBER}\`\n\n` +
            `After sending, take a screenshot of the payment confirmation and send it here.\n` +
            `📸 Send the screenshot as a photo.`
        );
        await ctx.reply('📤 Send the screenshot now.');
        return ctx.wizard.next();
    },
    async (ctx) => {
        // This step receives the photo
        const photo = ctx.message.photo;
        if (!photo) {
            await ctx.reply('Please send a photo (screenshot) of your payment confirmation.');
            return;
        }
        const userId = ctx.from.id;
        const amount = ctx.wizard.state.amount;
        // Forward the photo to admin with user details
        const caption =
            `📥 Deposit Screenshot\n` +
            `User: ${userId} (${ctx.from.first_name || ''} ${ctx.from.last_name || ''})\n` +
            `Amount: ${amount} Birr\n` +
            `Please verify and credit balance using /addbalance ${userId} ${amount}`;
        await ctx.telegram.sendPhoto(ADMIN_ID, photo[photo.length - 1].file_id, { caption });
        await ctx.reply(
            `✅ Screenshot sent to admin. Your deposit will be verified and credited shortly.`,
            walletKeyboard
        );
        return ctx.scene.leave();
    }
);

// ---------- Withdraw Scene ----------
const withdrawScene = new WizardScene(
    'withdraw',
    async (ctx) => {
        await ctx.reply('Enter amount to withdraw (min 5, max 25 Birr, fee 1 Birr):');
        return ctx.wizard.next();
    },
    async (ctx) => {
        const amount = parseFloat(ctx.message.text);
        if (isNaN(amount) || amount < 5 || amount > 25) {
            await ctx.reply('Amount must be between 5 and 25. Try again.');
            return;
        }
        const userId = ctx.from.id;
        const balance = getBalance(userId);
        if (balance < amount + 1) {
            await ctx.reply(`Insufficient balance. You have ${balance} Birr, need ${amount + 1} (amount + fee).`);
            return ctx.scene.leave();
        }
        ctx.wizard.state.amount = amount;
        await ctx.reply('Enter your Telebirr phone number (09XXXXXXXX):');
        return ctx.wizard.next();
    },
    async (ctx) => {
        const phone = ctx.message.text.trim();
        if (!phone.match(/^09\d{8}$/)) {
            await ctx.reply('Invalid phone number. Enter 09XXXXXXXX.');
            return;
        }
        const userId = ctx.from.id;
        const { amount } = ctx.wizard.state;
        const netAmount = amount - 1;
        // Deduct balance
        const newBalance = addBalance(userId, -(amount + 1));
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `📤 Withdrawal Request\nUser: ${userId} (${ctx.from.first_name || ''} ${ctx.from.last_name || ''})\nAmount: ${amount} Birr\nNet: ${netAmount} Birr\nPhone: ${phone}\nNew balance: ${newBalance}`
        );
        await ctx.reply(
            `✅ Withdrawal request sent. You will receive ${netAmount} Birr within 24‑48 hours after admin approval.`,
            walletKeyboard
        );
        return ctx.scene.leave();
    }
);

// ---------- Get Bot Start Scene ----------
const botStartScene = new WizardScene(
    'botstart',
    async (ctx) => {
        await ctx.reply('Send me the bot link (e.g., https://t.me/SomeBot or https://t.me/SomeBot/app?startapp=xxx)');
        return ctx.wizard.next();
    },
    async (ctx) => {
        const link = ctx.message.text.trim();
        if (!link.includes('t.me/')) {
            await ctx.reply('Invalid link. Must contain t.me/');
            return;
        }
        const converted = convertBotLink(link);
        ctx.wizard.state.link = converted;
        await ctx.reply('How many starts do you want? (1‑10)');
        return ctx.wizard.next();
    },
    async (ctx) => {
        const qty = parseInt(ctx.message.text);
        if (isNaN(qty) || qty < 1 || qty > 10) {
            await ctx.reply('Enter a number between 1 and 10.');
            return;
        }
        const userId = ctx.from.id;
        const totalCost = qty * 1;
        const balance = getBalance(userId);
        if (balance < totalCost) {
            await ctx.reply(`Insufficient balance. You have ${balance} Birr, need ${totalCost}.`);
            return ctx.scene.leave();
        }
        addBalance(userId, -totalCost);
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `🤖 Bot Start Order\nUser: ${userId} (${ctx.from.first_name || ''} ${ctx.from.last_name || ''})\nBot link: ${ctx.wizard.state.link}\nQuantity: ${qty}\nTotal cost: ${totalCost} Birr\nRemaining balance: ${getBalance(userId)}`
        );
        await ctx.reply(`✅ Order submitted. ${totalCost} Birr deducted. You will be notified when processed.`);
        return ctx.scene.leave();
    }
);

// ---------- Get Channel Subscribe Scene ----------
const channelScene = new WizardScene(
    'channel',
    async (ctx) => {
        await ctx.reply('⚠️ Warning: The bot must be admin in the channel to verify members.\n\nSend channel link (e.g., https://t.me/ChannelName)');
        return ctx.wizard.next();
    },
    async (ctx) => {
        const link = ctx.message.text.trim();
        if (!link.includes('t.me/')) {
            await ctx.reply('Invalid link. Must contain t.me/');
            return;
        }
        ctx.wizard.state.link = link;
        await ctx.reply('How many members do you want? (1‑10)');
        return ctx.wizard.next();
    },
    async (ctx) => {
        const qty = parseInt(ctx.message.text);
        if (isNaN(qty) || qty < 1 || qty > 10) {
            await ctx.reply('Enter a number between 1 and 10.');
            return;
        }
        const userId = ctx.from.id;
        const totalCost = qty * 1;
        const balance = getBalance(userId);
        if (balance < totalCost) {
            await ctx.reply(`Insufficient balance. You have ${balance} Birr, need ${totalCost}.`);
            return ctx.scene.leave();
        }
        addBalance(userId, -totalCost);
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `📢 Channel Subscribe Order\nUser: ${userId} (${ctx.from.first_name || ''} ${ctx.from.last_name || ''})\nChannel: ${ctx.wizard.state.link}\nQuantity: ${qty}\nTotal cost: ${totalCost} Birr\nRemaining balance: ${getBalance(userId)}`
        );
        await ctx.reply(`✅ Order submitted. ${totalCost} Birr deducted. You will be notified when processed.`);
        return ctx.scene.leave();
    }
);

// ---------- Get Group Join Scene ----------
const groupScene = new WizardScene(
    'group',
    async (ctx) => {
        await ctx.reply('⚠️ Warning: The bot must be admin in the group to verify members.\n\nSend group invite link or username (e.g., https://t.me/GroupName)');
        return ctx.wizard.next();
    },
    async (ctx) => {
        const link = ctx.message.text.trim();
        if (!link.includes('t.me/')) {
            await ctx.reply('Invalid link. Must contain t.me/');
            return;
        }
        ctx.wizard.state.link = link;
        await ctx.reply('How many members do you want? (1‑10)');
        return ctx.wizard.next();
    },
    async (ctx) => {
        const qty = parseInt(ctx.message.text);
        if (isNaN(qty) || qty < 1 || qty > 10) {
            await ctx.reply('Enter a number between 1 and 10.');
            return;
        }
        const userId = ctx.from.id;
        const totalCost = qty * 1;
        const balance = getBalance(userId);
        if (balance < totalCost) {
            await ctx.reply(`Insufficient balance. You have ${balance} Birr, need ${totalCost}.`);
            return ctx.scene.leave();
        }
        addBalance(userId, -totalCost);
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `👑 Group Join Order\nUser: ${userId} (${ctx.from.first_name || ''} ${ctx.from.last_name || ''})\nGroup: ${ctx.wizard.state.link}\nQuantity: ${qty}\nTotal cost: ${totalCost} Birr\nRemaining balance: ${getBalance(userId)}`
        );
        await ctx.reply(`✅ Order submitted. ${totalCost} Birr deducted. You will be notified when processed.`);
        return ctx.scene.leave();
    }
);

// ---------- Earn Scene ----------
const earnScene = new WizardScene(
    'earn',
    async (ctx) => {
        await ctx.reply(
            '📌 To earn, you can complete tasks provided by admin.\n' +
            'Click the button below to request available tasks.',
            Markup.inlineKeyboard([
                Markup.button.callback('📋 Request Tasks', 'request_tasks')
            ])
        );
        return ctx.wizard.next();
    },
    async (ctx) => {
        // unused
        return;
    }
);

bot.action('request_tasks', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    await ctx.telegram.sendMessage(
        ADMIN_ID,
        `📋 Task Request\nUser: ${userId} (${ctx.from.first_name || ''} ${ctx.from.last_name || ''})\nWants available tasks.`
    );
    await ctx.reply('✅ Your request has been sent to admin. They will contact you with available tasks.');
    await ctx.reply('Main menu', mainKeyboard);
    await ctx.scene.leave();
});

// ==================== COMMAND HANDLERS ====================
bot.start(async (ctx) => {
    await ctx.reply('Welcome to SniAdsEarnBot!\nAdvertise and earn money.\nUse the buttons below.', mainKeyboard);
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

bot.hears('💲Earn', async (ctx) => {
    await ctx.scene.enter('earn');
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

// Check balance
bot.command('checkbalance', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
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

// Add balance
bot.command('addbalance', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
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
    await ctx.reply(`Added ${amount} Birr to user ${userId}. New balance: ${newBalance}`);
});

// Deduct balance
bot.command('deductbalance', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ');
    if (args.length < 3) {
        await ctx.reply('Usage: /deductbalance <user_id> <amount>');
        return;
    }
    const userId = parseInt(args[1]);
    const amount = parseFloat(args[2]);
    if (isNaN(userId) || isNaN(amount) || amount <= 0) {
        await ctx.reply('Invalid user ID or amount.');
        return;
    }
    const balance = getBalance(userId);
    if (balance < amount) {
        await ctx.reply(`User ${userId} only has ${balance} Birr. Cannot deduct ${amount}.`);
        return;
    }
    const newBalance = addBalance(userId, -amount);
    await ctx.reply(`Deducted ${amount} Birr from user ${userId}. New balance: ${newBalance}`);
});

// Set balance
bot.command('setbalance', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
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

// ==================== REGISTER SCENES ====================
const stage = new Stage([depositScene, withdrawScene, botStartScene, channelScene, groupScene, earnScene]);
bot.use(stage.middleware());

// ==================== LAUNCH ====================
bot.launch().then(() => console.log('Bot started (Telebirr deposit version).'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
