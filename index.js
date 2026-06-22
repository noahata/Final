const { Telegraf, session, Markup, Scenes } = require('telegraf');
const express = require('express');
const axios = require('axios');

// ==================== CONFIG ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN environment variable missing.');

// ⚠️ CHANGE THIS TO YOUR OWN TELEGRAM USER ID
const ADMIN_ID = 6596414316;  // <--- replace with your numeric ID

// Chapa keys (hardcoded – replace with your own if needed)
const CHAPA_SECRET = 'CHASECK-X336iOa0QhxUCUOdUeq8g3X6JpgwFLn2';
const CHAPA_PUBLIC = 'CHAPUBK-VEVdXIbNH7NduotligB37ahBxZEhuBxE';

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

// ==================== CHAPA PAYMENT (generate link) ====================
async function createChapaPayment(amount, email, txRef) {
    const url = 'https://api.chapa.co/v1/transaction/initialize';
    const headers = {
        'Authorization': `Bearer ${CHAPA_SECRET}`,
        'Content-Type': 'application/json'
    };
    const payload = {
        amount,
        currency: 'ETB',
        email,
        tx_ref: txRef,
        callback_url: 'https://yourdomain.com/webhook/chapa',
        return_url: `https://t.me/${process.env.BOT_USERNAME || 'YourBot'}`,
        customization: { title: 'Wallet Deposit' }
    };
    const response = await axios.post(url, payload, { headers });
    return response.data;
}

// ==================== SCENES ====================
const { Stage, WizardScene } = Scenes;

// ---------- Deposit Scene ----------
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
        const userId = ctx.from.id;
        const txRef = `dep_${userId}_${Date.now()}`;
        try {
            const result = await createChapaPayment(amount, `${userId}@example.com`, txRef);
            if (result.status === 'success' && result.data && result.data.checkout_url) {
                // Send payment link to user
                await ctx.reply(
                    `💰 Deposit link:\n${result.data.checkout_url}\n\nAfter payment, please send a screenshot to admin for manual credit.`
                );
                // Forward deposit request to admin
                await ctx.telegram.sendMessage(
                    ADMIN_ID,
                    `📥 Deposit Request\nUser: ${userId} (${ctx.from.first_name || ''} ${ctx.from.last_name || ''})\nAmount: ${amount} Birr\nTxRef: ${txRef}\nPayment link: ${result.data.checkout_url}`
                );
            } else {
                await ctx.reply('Payment initialization failed. Try again later.');
            }
        } catch (error) {
            console.error('Chapa error:', error);
            await ctx.reply('Payment service error.');
        }
        await ctx.reply('Returning to wallet.', walletKeyboard);
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
        const netAmount = amount - 1; // fee = 1 Birr

        // Forward withdrawal request to admin
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `📤 Withdrawal Request\nUser: ${userId} (${ctx.from.first_name || ''} ${ctx.from.last_name || ''})\nAmount: ${amount} Birr\nNet: ${netAmount} Birr\nPhone: ${phone}`
        );
        await ctx.reply(
            `✅ Withdrawal request sent to admin.\nYou will receive ${netAmount} Birr within 24‑48 hours after approval.`,
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
        const totalCost = qty * 1; // 1 Birr per start

        // Forward order to admin
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `🤖 Bot Start Order\nUser: ${userId} (${ctx.from.first_name || ''} ${ctx.from.last_name || ''})\nBot link: ${ctx.wizard.state.link}\nQuantity: ${qty}\nTotal cost: ${totalCost} Birr`
        );
        await ctx.reply(`✅ Order submitted to admin. You will be notified when processed.`);
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
        const totalCost = qty * 1; // 1 Birr per member

        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `📢 Channel Subscribe Order\nUser: ${userId} (${ctx.from.first_name || ''} ${ctx.from.last_name || ''})\nChannel: ${ctx.wizard.state.link}\nQuantity: ${qty}\nTotal cost: ${totalCost} Birr`
        );
        await ctx.reply(`✅ Order submitted to admin. You will be notified when processed.`);
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

        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `👑 Group Join Order\nUser: ${userId} (${ctx.from.first_name || ''} ${ctx.from.last_name || ''})\nGroup: ${ctx.wizard.state.link}\nQuantity: ${qty}\nTotal cost: ${totalCost} Birr`
        );
        await ctx.reply(`✅ Order submitted to admin. You will be notified when processed.`);
        return ctx.scene.leave();
    }
);

// ---------- Earn Scene (forward request) ----------
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
        // This step is not used; the callback handles it.
        return;
    }
);

// Handle callback for requesting tasks
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
    await ctx.reply('Your balance is managed by admin. Use /balance to request your current balance from admin.');
    // Optionally forward balance request to admin
    await ctx.telegram.sendMessage(
        ADMIN_ID,
        `💰 Balance Request\nUser: ${ctx.from.id} (${ctx.from.first_name || ''} ${ctx.from.last_name || ''})`
    );
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

// ==================== REGISTER SCENES ====================
const stage = new Stage([depositScene, withdrawScene, botStartScene, channelScene, groupScene, earnScene]);
bot.use(stage.middleware());

// ==================== LAUNCH ====================
bot.launch().then(() => console.log('Bot started (database‑free mode).'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
