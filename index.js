// ==================== PART 1 ====================
// Copy everything below and paste into index.js (first half)

const { Telegraf, session, Markup, Scenes, Composer } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

// ==================== CONFIG ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN environment variable missing.');

// Hardcoded settings (change as needed)
const ADMIN_ID = 6596414316;
const EARN_RATE = 0.5;          // paid to worker per task
const BUY_RATE = 1.0;           // charged to buyer per unit
const WITHDRAW_MIN = 5;
const WITHDRAW_MAX = 25;
const WITHDRAW_FEE = 1.0;
const CHAPA_PUBLIC = 'CHAPUBK-VEVdXIbNH7NduotligB37ahBxZEhuBxE';
const CHAPA_SECRET = 'CHASECK-X336iOa0QhxUCUOdUeq8g3X6JpgwFLn2';
const CHAPA_WEBHOOK_SECRET = 'your_webhook_secret'; // optional

// ==================== DATABASE SETUP ====================
const db = new sqlite3.Database('./bot_data.db');

// Promisify db methods
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
});
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { if (err) reject(err); else resolve(this); });
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
});

// Initialize tables
const initDB = async () => {
    await dbRun(`CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS wallets (
        user_id INTEGER PRIMARY KEY,
        balance REAL DEFAULT 0.0,
        total_earned REAL DEFAULT 0.0,
        total_spent REAL DEFAULT 0.0
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        amount REAL,
        type TEXT,
        status TEXT DEFAULT 'pending',
        reference TEXT,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        buyer_id INTEGER,
        service_type TEXT,
        target_link TEXT,
        quantity INTEGER,
        total_cost REAL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        service_type TEXT,
        target_link TEXT,
        status TEXT DEFAULT 'available',
        worker_id INTEGER,
        taken_at TIMESTAMP,
        completed_at TIMESTAMP,
        reward REAL DEFAULT 0.5
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        amount REAL,
        fee REAL DEFAULT 1.0,
        net_amount REAL,
        phone_number TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP
    )`);
};
initDB().catch(console.error);

// ==================== DB HELPER FUNCTIONS ====================
async function registerUser(user) {
    await dbRun(
        `INSERT OR IGNORE INTO users (user_id, username, first_name, last_name) VALUES (?, ?, ?, ?)`,
        [user.id, user.username, user.first_name, user.last_name]
    );
    await dbRun(`INSERT OR IGNORE INTO wallets (user_id) VALUES (?)`, [user.id]);
}

async function getBalance(userId) {
    const row = await dbGet(`SELECT balance FROM wallets WHERE user_id = ?`, [userId]);
    return row ? row.balance : 0;
}

async function updateBalance(userId, amount) {
    await dbRun(`UPDATE wallets SET balance = balance + ? WHERE user_id = ?`, [amount, userId]);
}

async function createOrder(buyerId, serviceType, targetLink, quantity, totalCost) {
    const result = await dbRun(
        `INSERT INTO orders (buyer_id, service_type, target_link, quantity, total_cost, status) VALUES (?, ?, ?, ?, ?, ?)`,
        [buyerId, serviceType, targetLink, quantity, totalCost, 'pending']
    );
    return result.lastID;
}

async function generateTasks(orderId, serviceType, targetLink, quantity) {
    for (let i = 0; i < quantity; i++) {
        await dbRun(
            `INSERT INTO tasks (order_id, service_type, target_link, reward) VALUES (?, ?, ?, ?)`,
            [orderId, serviceType, targetLink, EARN_RATE]
        );
    }
}

async function getAvailableTasks(serviceType = null) {
    let sql = `SELECT id, service_type, target_link, reward FROM tasks WHERE status = 'available'`;
    const params = [];
    if (serviceType) {
        sql += ` AND service_type = ?`;
        params.push(serviceType);
    }
    return await dbAll(sql, params);
}

async function claimTask(taskId, workerId) {
    const result = await dbRun(
        `UPDATE tasks SET status = 'taken', worker_id = ?, taken_at = CURRENT_TIMESTAMP 
         WHERE id = ? AND status = 'available'`,
        [workerId, taskId]
    );
    return result.changes > 0;
}

async function completeTask(taskId, workerId) {
    const row = await dbGet(
        `SELECT reward FROM tasks WHERE id = ? AND worker_id = ? AND status = 'taken'`,
        [taskId, workerId]
    );
    if (!row) return false;
    await dbRun(`UPDATE tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`, [taskId]);
    await updateBalance(workerId, row.reward);
    return true;
}

async function createWithdrawal(userId, amount, fee, netAmount, phone) {
    const result = await dbRun(
        `INSERT INTO withdrawals (user_id, amount, fee, net_amount, phone_number) VALUES (?, ?, ?, ?, ?)`,
        [userId, amount, fee, netAmount, phone]
    );
    return result.lastID;
}

// ==================== LINK CONVERTER ====================
function convertBotLink(link) {
    const match = link.match(/^(https?:\/\/t\.me\/[^\/?]+)\/app\?startapp=(.+)$/);
    if (match) {
        return `${match[1]}?start=${match[2]}`;
    }
    return link;
}

// ==================== CHAPA PAYMENT ====================
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

// ==================== SCENES (first two) ====================
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
            const email = `${userId}@example.com`;
            const result = await createChapaPayment(amount, email, txRef);
            if (result.status === 'success' && result.data && result.data.checkout_url) {
                await dbRun(
                    `INSERT INTO transactions (user_id, amount, type, status, reference) VALUES (?, ?, ?, ?, ?)`,
                    [userId, amount, 'deposit', 'pending', txRef]
                );
                await ctx.reply(
                    `💰 Please complete payment using the link below:\n${result.data.checkout_url}\n\nAfter payment, it will be credited automatically.`
                );
            } else {
                await ctx.reply('Payment initialization failed. Please try again later.');
            }
        } catch (error) {
            console.error('Chapa error:', error);
            await ctx.reply('Payment service error. Please try again later.');
        }
        await ctx.reply('Returning to wallet.', walletKeyboard);
        return ctx.scene.leave();
    }
);

// ---------- Withdraw Scene ----------
const withdrawScene = new WizardScene(
    'withdraw',
    async (ctx) => {
        await ctx.reply(`Enter amount to withdraw (min ${WITHDRAW_MIN}, max ${WITHDRAW_MAX} Birr, fee ${WITHDRAW_FEE} Birr):`);
        return ctx.wizard.next();
    },
    async (ctx) => {
        const amount = parseFloat(ctx.message.text);
        if (isNaN(amount) || amount < WITHDRAW_MIN || amount > WITHDRAW_MAX) {
            await ctx.reply(`Amount must be between ${WITHDRAW_MIN} and ${WITHDRAW_MAX}. Try again.`);
            return;
        }
        const userId = ctx.from.id;
        const balance = await getBalance(userId);
        const totalRequired = amount + WITHDRAW_FEE;
        if (balance < totalRequired) {
            await ctx.reply(`Insufficient balance. You need ${totalRequired} Birr (amount + fee).`);
            return ctx.scene.leave();
        }
        ctx.wizard.state.amount = amount;
        ctx.wizard.state.netAmount = amount - WITHDRAW_FEE;
        await ctx.reply('Enter your Telebirr phone number:');
        return ctx.wizard.next();
    },
    async (ctx) => {
        const phone = ctx.message.text.trim();
        if (!phone.match(/^09\d{8}$/)) {
            await ctx.reply('Invalid phone number. Please enter a valid Ethiopian phone (09XXXXXXXX).');
            return;
        }
        const userId = ctx.from.id;
        const { amount, netAmount } = ctx.wizard.state;
        await updateBalance(userId, -(amount + WITHDRAW_FEE));
        await createWithdrawal(userId, amount, WITHDRAW_FEE, netAmount, phone);
        await ctx.telegram.sendMessage(
            ADMIN_ID,
            `📥 New withdrawal request:\nUser: ${userId}\nAmount: ${amount} Birr\nNet: ${netAmount} Birr\nPhone: ${phone}\n\nUse /approve_<id> or /reject_<id>`
        );
        await ctx.reply(`✅ Withdrawal request submitted. You will receive ${netAmount} Birr within 24-48 hours.`, walletKeyboard);
        return ctx.scene.leave();
    }
);

// ==================== END OF PART 1 ====================
// Continue with Part 2 below...
