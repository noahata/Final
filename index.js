require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");

// Check required environment variables
const requiredEnv = [
  'BOT_TOKEN',
  'ADMIN_ID',
  'DB_CHANNEL_ID',
  'CHAPA_SECRET_KEY',
  'WEBHOOK_URL'
];

console.log("🔍 Checking environment variables...");
requiredEnv.forEach(varName => {
  if (!process.env[varName]) {
    console.error("❌ Missing required environment variable: " + varName);
    process.exit(1);
  }
});
console.log("✅ All environment variables found");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json());

const ADMIN_ID = Number(process.env.ADMIN_ID);
const DB_CHANNEL = process.env.DB_CHANNEL_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const PRICING = { STANDARD: 99, PENALTY: 149 };
const TEACHER_PERCENT = 0.55;

// In-memory storage
let users = {};
let processedTransactions = new Set();
let adminReplyTarget = null;

// Rate limiting
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS = 30;

// Session timeout
const SESSION_TIMEOUT = 30 * 60 * 1000;

// ================= HELPER FUNCTIONS =================

function checkRateLimit(userId) {
  const now = Date.now();
  const userLimits = rateLimit.get(userId) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
  
  if (now > userLimits.resetTime) {
    userLimits.count = 1;
    userLimits.resetTime = now + RATE_LIMIT_WINDOW;
  } else {
    userLimits.count++;
  }
  
  rateLimit.set(userId, userLimits);
  return userLimits.count <= MAX_REQUESTS;
}

function isValidYouTubeUrl(url) {
  if (!url) return false;
  return url.includes('youtube.com/channel/') || 
         url.includes('youtube.com/c/') || 
         url.includes('youtube.com/user/') || 
         url.includes('youtu.be/') || 
         url.includes('youtube.com/@');
}

function isValidEmail(email) {
  if (email.toLowerCase() === 'skip') return true;
  return email.includes('@') && email.includes('.');
}

function isValidPhone(phone) {
  const cleanPhone = phone.replace(/\s/g, '');
  return cleanPhone.match(/^(\+251|0)?9\d{8}$/) !== null;
}

function getFee(user) {
  console.log("💰 Calculating fee for:", user?.name);
  
  if (!user || !user.createdAt) {
    return PRICING.STANDARD;
  }
  
  const hours = (Date.now() - user.createdAt) / (1000 * 60 * 60);
  
  if (user.status === "reapply_required" || hours > 24) {
    user.penalty = true;
    return PRICING.PENALTY;
  }
  
  user.penalty = false;
  return PRICING.STANDARD;
}

function cleanupInactiveSessions() {
  const now = Date.now();
  Object.keys(users).forEach(userId => {
    const user = users[userId];
    if (user.lastActivity && (now - user.lastActivity > SESSION_TIMEOUT)) {
      if (user.status === 'collecting' || user.status === 'idle') {
        delete users[userId];
      }
    }
  });
}

setInterval(cleanupInactiveSessions, 15 * 60 * 1000);

async function sendWithTyping(chatId, text, options = {}) {
  await bot.sendChatAction(chatId, 'typing');
  await new Promise(resolve => setTimeout(resolve, 1000));
  return bot.sendMessage(chatId, text, options);
}

// ================= START =================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (!checkRateLimit(chatId)) {
    return bot.sendMessage(chatId, "⚠️ Too many requests. Please wait a moment.");
  }

  users[chatId] = {
    step: null,
    status: "idle",
    createdAt: Date.now(),
    lastActivity: Date.now()
  };

  await sendWithTyping(chatId,
"👋 *Welcome to OTS Teacher Registration System*\n\n" +
"📚 This is your professional platform to register as a verified teacher.\n\n" +
"👇 Please choose an option below to begin:",
{
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        ["📝 Register"],
        ["📊 My Status", "ℹ️ About Platform"]
      ],
      resize_keyboard: true
    }
  });
});

// ================= MESSAGE HANDLER =================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const user = users[chatId];
  
  if (!checkRateLimit(chatId)) {
    return bot.sendMessage(chatId, "⚠️ Too many requests. Please wait a moment.");
  }

  // ADMIN REPLY MODE
  if (msg.from.id === ADMIN_ID && adminReplyTarget) {
    await bot.sendMessage(adminReplyTarget,
"📩 *Message from OTS Administration*\n\n" + text,
{ parse_mode: "Markdown" });

    await bot.sendMessage(ADMIN_ID, "✅ Reply delivered successfully.");
    adminReplyTarget = null;
    return;
  }

  if (!user) return;
  
  user.lastActivity = Date.now();

  // REGISTER BUTTON
  if (text === "📝 Register") {
    if (user.status === "pending_review" || user.status === "approved" || user.status === "payment_verified") {
      return bot.sendMessage(chatId, 
        "⚠️ You already have a registration in progress. Please wait for admin review.");
    }
    
    user.step = "name";
    user.status = "collecting";
    user.createdAt = Date.now();

    return sendWithTyping(chatId,
"📝 *Step 1/5 - Full Name*\n\n" +
"👤 Please enter your full legal name as it appears on your ID.",
{
      parse_mode: "Markdown",
      reply_markup: { 
        keyboard: [["⬅️ Back", "❌ Cancel"]], 
        resize_keyboard: true 
      }
    });
  }

  // CANCEL BUTTON HANDLER
  if (text === "❌ Cancel") {
    user.step = null;
    user.status = "idle";
    return bot.sendMessage(chatId, 
      "❌ Registration cancelled. You can start over with /start anytime.",
      {
        reply_markup: {
          keyboard: [
            ["📝 Register"],
            ["📊 My Status", "ℹ️ About Platform"]
          ],
          resize_keyboard: true
        }
      });
  }

  // BACK BUTTON HANDLER
  if (text === "⬅️ Back") {
    if (user.step === "phone") user.step = "name";
    else if (user.step === "youtube") user.step = "phone";
    else if (user.step === "email") user.step = "youtube";
    else if (user.step === "subject") user.step = "email";
    else if (!user.step) return;
    
    return bot.sendMessage(chatId, "⬅️ Returned to previous step.", {
      reply_markup: { 
        keyboard: [["⬅️ Back", "❌ Cancel"]], 
        resize_keyboard: true 
      }
    });
  }

  // NAME STEP
  if (user.step === "name") {
    if (!text || text.length < 2) {
      return bot.sendMessage(chatId, "⚠️ Please enter a valid name (at least 2 characters).");
    }
    
    user.name = text.trim();
    user.step = "phone";
    
    return sendWithTyping(chatId,
"📱 *Step 2/5 - Phone Number*\n\n" +
"📞 Please share your phone number using the secure button below:",
{
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [
          [{ text: "📲 Share Phone Number", request_contact: true }],
          ["⬅️ Back", "❌ Cancel"]
        ],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
  }

  // PHONE STEP
  if (user.step === "phone") {
    let phoneNumber;
    
    if (msg.contact && msg.contact.user_id === chatId) {
      phoneNumber = msg.contact.phone_number;
    } else if (text && text !== "⬅️ Back" && text !== "❌ Cancel") {
      phoneNumber = text;
    } else {
      return bot.sendMessage(chatId, 
        "⚠️ Please use the contact button or enter your phone number manually (e.g., 0912345678).");
    }
    
    if (!isValidPhone(phoneNumber)) {
      return bot.sendMessage(chatId, 
        "⚠️ Please enter a valid Ethiopian phone number (e.g., 0912345678 or +251912345678).");
    }

    user.phone = phoneNumber;
    user.step = "youtube";

    return sendWithTyping(chatId,
"🌐 *Step 3/5 - YouTube Channel (Required)*\n\n" +
"📹 Please enter your YouTube channel link.\n" +
"📌 Example: https://youtube.com/c/yourchannel or https://youtube.com/@yourchannel\n\n" +
"⚠️ This step is *mandatory* for registration.",
{
      parse_mode: "Markdown",
      reply_markup: { 
        keyboard: [["⬅️ Back", "❌ Cancel"]], 
        resize_keyboard: true 
      }
    });
  }

  // YOUTUBE STEP
  if (user.step === "youtube") {
    if (!text || text.toLowerCase() === "skip") {
      return bot.sendMessage(chatId,
"⚠️ *YouTube channel is required for registration.*\n\n" +
"📹 Please provide a valid YouTube channel URL:",
{ parse_mode: "Markdown" });
    }

    if (!isValidYouTubeUrl(text)) {
      return bot.sendMessage(chatId,
"⚠️ Please enter a valid YouTube channel URL.\n\n" +
"📌 Examples:\n" +
"• https://youtube.com/c/yourchannel\n" +
"• https://youtube.com/@yourchannel\n" +
"• https://youtu.be/yourchannel");
    }

    user.youtube = text.trim();
    user.step = "email";

    return sendWithTyping(chatId,
"📧 *Step 4/5 - Email Address*\n\n" +
"✉️ Enter your email address, or type 'Skip' to continue without email.\n\n" +
"📌 Example: name@example.com",
{
      parse_mode: "Markdown",
      reply_markup: { 
        keyboard: [["⬅️ Back", "❌ Cancel"]], 
        resize_keyboard: true 
      }
    });
  }

  // EMAIL STEP
  if (user.step === "email") {
    if (!isValidEmail(text)) {
      return bot.sendMessage(chatId, 
        "⚠️ Please enter a valid email (e.g., name@example.com) or type 'Skip'.");
    }

    if (text.toLowerCase() === "skip") {
      user.email = "Not provided";
    } else {
      user.email = text.trim();
    }
    
    user.step = "subject";

    return sendWithTyping(chatId,
"📚 *Step 5/5 - Teaching Subject*\n\n" +
"📖 What subject(s) do you teach? (e.g., Mathematics, Physics, English)\n\n" +
"✏️ Please be specific.",
{
      parse_mode: "Markdown",
      reply_markup: { 
        keyboard: [["⬅️ Back", "❌ Cancel"]], 
        resize_keyboard: true 
      }
    });
}  // SUBJECT STEP
  if (user.step === "subject") {
    if (!text || text.length < 2) {
      return bot.sendMessage(chatId, 
        "⚠️ Please enter at least one subject you teach.");
    }

    user.subject = text.trim();
    user.step = "completed";
    user.status = "pending_review";

    // Send info to DB channel
    (async () => {
      let channelName = "Unknown";
      let channelLink = "No link";
      let subscribers = "Unknown";
      
      try {
        const info = await bot.getChat(DB_CHANNEL);
        channelName = info.title;
        channelLink = info.invite_link || "No link";
        subscribers = info.members_count || "Unknown";
      } catch (err) {
        console.error("Error fetching channel info:", err.message);
      }

      await bot.sendMessage(DB_CHANNEL,
"📌 *New Teacher Registration Pending Review*\n\n" +
"👤 *Name:* " + user.name + "\n" +
"📱 *Phone:* " + user.phone + "\n" +
"📚 *Subject:* " + user.subject + "\n" +
"🌐 *YouTube:* " + user.youtube + "\n" +
"📧 *Email:* " + user.email + "\n" +
"🕒 *Registered:* " + new Date().toLocaleString() + "\n\n" +
"🏷 *Telegram Channel Info:*\n" +
"• Name: " + channelName + "\n" +
"• Link: " + channelLink + "\n" +
"• Subscribers: " + subscribers + "\n\n" +
"💰 *Payment:* Pending\n" +
"📊 *Status:* Pending Review",
{
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💬 Reply", callback_data: "reply_" + chatId },
              { text: "✅ Approve", callback_data: "approve_" + chatId },
              { text: "❌ Reject", callback_data: "reject_" + chatId }
            ]
          ]
        }
      });

      await bot.sendMessage(chatId,
"✅ *Registration Submitted Successfully!*\n\n" +
"📋 Your registration is now under admin review.\n\n" +
"📌 *Next Steps:*\n" +
"1️⃣ Admin will review your information (usually within 24 hours)\n" +
"2️⃣ If approved, you'll receive a secure Chapa payment link\n" +
"3️⃣ Complete payment to activate your profile\n\n" +
"💰 *Commission:* You earn 55% of all app profits from students you refer\n\n" +
"⏱️ *Note:* Registration fee may increase if payment is delayed beyond 24 hours.",
{ parse_mode: "Markdown" });
    })();
  }

  // STATUS BUTTON
  if (text === "📊 My Status") {
    let statusMessage = "📄 *Your Current Registration Status*\n\n";
    
    if (!user.status || user.status === "idle") {
      statusMessage += "❌ You haven't started registration yet. Use /start to begin.";
    } else {
      statusMessage += "📌 Status: *" + user.status.replace(/_/g, ' ').toUpperCase() + "*\n";
      
      if (user.status === "pending_review") {
        statusMessage += "\n⏳ Your application is being reviewed by admin.";
      } else if (user.status === "approved") {
        const fee = getFee(user);
        statusMessage += "\n✅ Approved! Payment required: *" + fee + " ETB*";
      } else if (user.status === "reapply_required") {
        statusMessage += "\n❌ Your application was not approved. Please reapply.";
      } else if (user.status === "payment_verified") {
        statusMessage += "\n💰 Payment verified! Commission rate: 55%";
      }
    }
    
    return bot.sendMessage(chatId, statusMessage, { parse_mode: "Markdown" });
  }

  if (text === "ℹ️ About Platform") {
    return bot.sendMessage(chatId,
"ℹ️ *About OTS Platform*\n\n" +
"📚 OTS (Online Teaching System) connects qualified teachers with students securely across Ethiopia.\n\n" +
"✨ *Features:*\n" +
"• 🔒 Secure payment processing via Chapa\n" +
"• 💰 55% commission rate for teachers\n" +
"• 🤝 Direct student-teacher connection\n" +
"• ✅ Admin-verified teachers only\n" +
"• 🕐 24/7 support\n\n" +
"💵 *Registration Fee:* 99 ETB (Standard) / 149 ETB (After 24h)\n\n" +
"📞 For more information, contact @OTSSupport",
{ parse_mode: "Markdown" });
  }
});

// ================= ADMIN CALLBACKS - LIVE CHAPA ONLY =================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  // Handle approve - LIVE CHAPA ONLY (NO MANUAL FALLBACK)
  if (query.data.startsWith("approve_")) {
    console.log("✅ Approve button clicked");
    
    // Only admin can approve
    if (query.from.id !== ADMIN_ID) {
      await bot.answerCallbackQuery(query.id, { text: "⛔ Unauthorized", show_alert: true });
      return;
    }
    
    const targetId = Number(query.data.split("_")[1]);
    const targetUser = users[targetId];
    
    if (!targetUser) {
      console.log("❌ User not found:", targetId);
      await bot.answerCallbackQuery(query.id, { text: "❌ User not found", show_alert: true });
      return;
    }
    
    console.log("👤 User found:", targetUser.name);
    
    // Calculate fee
    const fee = getFee(targetUser);
    console.log("💰 Fee calculated:", fee, "ETB");
    
    // Verify fee is valid
    if (typeof fee !== 'number' || isNaN(fee) || fee <= 0) {
      console.log("❌ Invalid fee:", fee);
      await bot.sendMessage(ADMIN_ID, "❌ Fee calculation failed for " + targetUser.name);
      await bot.answerCallbackQuery(query.id, { text: "❌ Fee calculation failed", show_alert: true });
      return;
    }
    
    targetUser.status = "approved";
    
    // Generate transaction reference
    const tx_ref = "OTS-" + Date.now() + "-" + targetId;
    targetUser.tx_ref = tx_ref;
    
    // Prepare email (ensure it's valid for Chapa)
    let email = targetUser.email;
    if (email === "Not provided" || !email.includes('@')) {
      email = "teacher_" + Date.now() + "@ots.com";
    }
    
    // Prepare payment data for Chapa
    const paymentData = {
      amount: fee,
      currency: "ETB",
      email: email,
      first_name: targetUser.name.split(' ')[0] || "Teacher",
      last_name: targetUser.name.split(' ').slice(1).join(' ') || "User",
      tx_ref: tx_ref,
      callback_url: WEBHOOK_URL + "/verify",
      return_url: WEBHOOK_URL + "/success"
    };
    
    console.log("📤 Sending to Chapa with amount:", paymentData.amount, "ETB");
    
    // Update admin message to show processing
    await bot.editMessageText(
      query.message.text + "\n\n⏳ *GENERATING CHAPA PAYMENT LINK...*",
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [] }
      }
    );
    
    try {
      // Send to Chapa API
      const response = await axios.post(
        "https://api.chapa.co/v1/transaction/initialize",
        paymentData,
        { 
          headers: { 
            Authorization: "Bearer " + process.env.CHAPA_SECRET_KEY,
            "Content-Type": "application/json"
          } 
        }
      );
      
      console.log("📥 Chapa response:", response.data);
      
      if (response.data && response.data.status === "success") {
        const paymentLink = response.data.data.checkout_url;
        
        // Send success to teacher with Chapa payment link
        await bot.sendMessage(targetId,
"🎉 *Congratulations! Your registration is approved!*\n\n" +
"💰 *Amount to Pay: " + fee + " ETB*\n\n" +
"🔗 *Click this link to pay securely via Chapa:*\n" +
paymentLink + "\n\n" +
"📋 *Instructions:*\n" +
"1️⃣ Click the link above\n" +
"2️⃣ Complete payment on Chapa website\n" +
"3️⃣ Return here - account will auto-activate within 1 minute\n\n" +
"⏱️ *Payment window:* 24 hours\n\n" +
"❓ Need help? Contact @OTSSupport",
{ parse_mode: "Markdown" });
        
        // Notify admin
        await bot.sendMessage(ADMIN_ID,
"✅ *Chapa Payment Link Generated*\n\n" +
"👤 Teacher: " + targetUser.name + "\n" +
"💰 Amount: " + fee + " ETB\n" +
"🔗 Link sent to teacher\n\n" +
"⏳ Waiting for payment verification...");
        
        // Update admin message to show approved with link
        await bot.editMessageText(
          query.message.text + "\n\n✅ *APPROVED - CHAPA LINK SENT*",
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [] }
          }
        );
        
        await bot.answerCallbackQuery(query.id, { text: "✅ Chapa link sent - Amount: " + fee + " ETB" });
      } else {
        // Chapa API returned error
        console.log("❌ Chapa returned non-success:", response.data);
        
        await bot.sendMessage(ADMIN_ID,
"❌ *Chapa API Error*\n\n" +
"👤 Teacher: " + targetUser.name + "\n" +
"💰 Amount: " + fee + " ETB\n" +
"📊 Response: " + JSON.stringify(response.data) + "\n\n" +
"⚠️ Please check Chapa dashboard and try again.");
        
        await bot.editMessageText(
          query.message.text + "\n\n❌ *CHAPA ERROR - TRY AGAIN*",
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [] }
          }
        );
        
        await bot.answerCallbackQuery(query.id, { text: "❌ Chapa error - check logs", show_alert: true });
      }
      
    } catch (error) {
      // Chapa API connection error
      console.error("❌ Chapa API connection error:", error.response?.data || error.message);
      
      const errorDetails = error.response?.data || { message: error.message };
      
      await bot.sendMessage(ADMIN_ID,
"❌ *Chapa API Connection Failed*\n\n" +
"👤 Teacher: " + targetUser.name + "\n" +
"💰 Amount: " + fee + " ETB\n" +
"📊 Error: " + JSON.stringify(errorDetails) + "\n\n" +
"⚠️ Please check:\n" +
"• Chapa API key is correct\n" +
"• Webhook URL is set in Chapa dashboard\n" +
"• Internet connection");
      
      await bot.editMessageText(
        query.message.text + "\n\n❌ *CHAPA CONNECTION FAILED*",
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [] }
        }
      );
      
      await bot.answerCallbackQuery(query.id, { text: "❌ Chapa connection failed", show_alert: true });
    }
    
    return;
  }

  // Reply callback
  if (query.data.startsWith("reply_")) {
    if (query.from.id !== ADMIN_ID) {
      await bot.answerCallbackQuery(query.id, { text: "⛔ Unauthorized", show_alert: true });
      return;
    }
    
    const targetId = Number(query.data.split("_")[1]);
    adminReplyTarget = targetId;
    await bot.answerCallbackQuery(query.id, { text: "💬 Reply mode activated" });
    return bot.sendMessage(ADMIN_ID, "✍️ Please type your reply message:");
  }

  // Reject callback
  if (query.data.startsWith("reject_")) {
    if (query.from.id !== ADMIN_ID) {
      await bot.answerCallbackQuery(query.id, { text: "⛔ Unauthorized", show_alert: true });
      return;
    }
    
    const targetId = Number(query.data.split("_")[1]);
    const targetUser = users[targetId];
    
    if (!targetUser) {
      await bot.answerCallbackQuery(query.id, { text: "❌ User not found", show_alert: true });
      return;
    }
    
    targetUser.status = "reapply_required";
    
    await bot.editMessageText(
      query.message.text + "\n\n❌ *REJECTED*",
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [] }
      }
    );
    
    await bot.answerCallbackQuery(query.id, { text: "❌ Teacher rejected" });
    
    await bot.sendMessage(targetId,
"❌ *Registration Not Approved*\n\n" +
"Unfortunately, your registration was not approved at this time.\n\n" +
"🔄 You may reapply with updated information using /start.\n\n" +
"📋 *Common reasons for rejection:*\n" +
"• Invalid YouTube channel\n" +
"• Incomplete information\n" +
"• Unable to verify identity",
{ parse_mode: "Markdown" });
    
    return;
  }
});

// ================= CHAPA WEBHOOK - LIVE VERIFICATION =================
app.post("/verify", async (req, res) => {
  try {
    console.log("🔔 Chapa webhook received:", req.body);
    
    const { tx_ref } = req.body;
    
    if (!tx_ref) {
      console.log("❌ No tx_ref in webhook");
      return res.status(200).json({ error: "Missing tx_ref" });
    }
    
    // Check if already processed
    if (processedTransactions.has(tx_ref)) {
      console.log("⏭️ Transaction already processed:", tx_ref);
      return res.status(200).json({ status: "already_processed" });
    }
    
    // Verify with Chapa API to confirm payment
    console.log("🔍 Verifying with Chapa API:", tx_ref);
    
    const verify = await axios.get(
      "https://api.chapa.co/v1/transaction/verify/" + tx_ref,
      { headers: { Authorization: "Bearer " + process.env.CHAPA_SECRET_KEY } }
    );
    
    console.log("📊 Chapa verification result:", verify.data);
    
    const data = verify.data.data;
    
    // Check if payment was successful
    if (data && data.status === "success") {
      // Extract user ID from tx_ref (format: OTS-timestamp-userId)
      const telegramId = Number(tx_ref.split("-").pop());
      const user = users[telegramId];
      
      if (user) {
        // Mark as processed
        processedTransactions.add(tx_ref);
        
        // Update user status
        user.status = "payment_verified";
        user.paidAmount = data.amount;
        user.commission = data.amount * TEACHER_PERCENT;
        user.paymentDate = new Date().toISOString();
        
        console.log("✅ Payment verified for user:", user.name);
        
        // Notify user
        await bot.sendMessage(telegramId,
"✅ *Payment Verified Successfully!*\n\n" +
"💰 Amount: *" + data.amount + " ETB*\n\n" +
"🎉 Your teacher profile is now *active*!\n\n" +
"💵 *Commission Rate:* 55%\n" +
"📌 Start sharing your referral link with students!\n\n" +
"🆘 Need help? Contact @OTSSupport",
{ parse_mode: "Markdown" });
        
        // Notify admin
        await bot.sendMessage(ADMIN_ID,
"💰 *Chapa Payment Received*\n\n" +
"👤 Teacher: " + user.name + "\n" +
"💵 Amount: " + data.amount + " ETB\n" +
"🆔 Transaction: " + tx_ref + "\n\n" +
"✅ Status: Payment verified - Account activated",
{ parse_mode: "Markdown" });
      } else {
        console.log("❌ User not found for tx_ref:", tx_ref);
      }
    } else {
      console.log("⚠️ Payment not successful yet:", data?.status);
    }
    
    // Always return 200 to acknowledge receipt
    res.status(200).json({ status: "received" });
    
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    // Always return 200 to prevent Chapa from retrying
    res.status(200).json({ error: "Internal error but acknowledged" });
  }
});

// ================= SUCCESS PAGE =================
app.get("/success", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Payment Successful - OTS</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
          .container { background: white; padding: 40px; border-radius: 15px; max-width: 500px; margin: 0 auto; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
          h1 { color: #4CAF50; font-size: 32px; }
          .checkmark { font-size: 80px; margin: 20px 0; color: #4CAF50; }
          .btn { background: #0088cc; color: white; padding: 15px 40px; text-decoration: none; border-radius: 50px; display: inline-block; margin-top: 30px; font-weight: bold; font-size: 18px; }
          .btn:hover { background: #006699; }
          .note { color: #666; margin-top: 20px; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="checkmark">✅</div>
          <h1>Payment Successful!</h1>
          <p>Your registration payment has been processed successfully.</p>
          <p>You can now close this window and return to Telegram.</p>
          <a href="https://t.me/OTSSupport" class="btn">Return to Telegram</a>
          <p class="note">Your account will be activated within 1 minute</p>
        </div>
      </body>
    </html>
  `);
});

// ================= HEALTH CHECK =================
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    users: Object.keys(users).length,
    transactions: processedTransactions.size,
    chapa_key: process.env.CHAPA_SECRET_KEY ? "✅ Set" : "❌ Missing",
    webhook_url: WEBHOOK_URL + "/verify"
  });
});

// ================= TEST ENDPOINT =================
app.get("/test", (req, res) => {
  res.send(`
    <html>
      <body style="font-family: Arial; padding: 40px;">
        <h1>✅ OTS Teacher Bot is Running!</h1>
        <p>Webhook URL: <code>${WEBHOOK_URL}/verify</code></p>
        <p>Status: <strong style="color: green;">LIVE</strong></p>
        <p>Chapa: <strong style="color: green;">Active</strong></p>
        <p>Users: ${Object.keys(users).length}</p>
      </body>
    </html>
  `);
});

// Root endpoint
app.get("/", (req, res) => {
  res.send("🤖 OTS Teacher Bot is running with LIVE Chapa! Use /test to check status.");
});

// ================= ERROR HANDLER =================
bot.on("polling_error", (error) => {
  console.error("Polling error:", error.message);
});

// ================= SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Server running on port " + PORT);
  console.log("🤖 Bot is running with LIVE Chapa");
  console.log("📊 Monitoring " + Object.keys(users).length + " users");
  console.log("🌐 Webhook URL: " + WEBHOOK_URL + "/verify");
  console.log("🔗 Test URL: " + WEBHOOK_URL + "/test");
  console.log("💰 Pricing: Standard 99 ETB | Penalty 149 ETB");
});
