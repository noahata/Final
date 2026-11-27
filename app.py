import os
import json
import hashlib
import secrets
import asyncio
import hmac
import requests
import threading
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, request, jsonify, render_template_string
from flask_cors import CORS
from telethon import TelegramClient
from telethon.sessions import StringSession

API_ID           = int(os.environ["API_ID"])
API_HASH         = os.environ["API_HASH"]
SESSION          = os.environ["TG_SESSION"]
CHANNEL          = int(os.environ["TG_CHANNEL"])
ADMIN_KEY        = os.environ["ADMIN_KEY"]

CHAPA_SECRET_KEY = os.environ.get("CHAPA_SECRET_KEY") 
CHAPA_WEBHOOK_SECRET = os.environ.get("CHAPA_WEBHOOK_SECRET")

USERS_MSG_MARKER    = "D2AI_USERS_DB_v1"
PAYMENTS_MSG_MARKER = "D2AI_PAYMENTS_V1"
SETTINGS_MSG_MARKER = "D2AI_SETTINGS_V1"
CODES_MSG_MARKER    = "D2AI_CODES_V1"
REWARDS_MSG_MARKER  = "D2AI_REWARDS_V1" # New

app = Flask(__name__)
CORS(app)
client = TelegramClient(StringSession(SESSION), API_ID, API_HASH)

USERS = {}
SESSIONS = {}
PAYMENTS = {}
SETTINGS = {}
CODES = {}
REWARDS = {} # New: Stores pending/completed video rewards
USERS_MSG_ID = None
PAYMENTS_MSG_ID = None
SETTINGS_MSG_ID = None
CODES_MSG_ID = None
REWARDS_MSG_ID = None

DEFAULT_SETTINGS = {
    "default_trial_days": 14,
    "chapa_test_mode": False
}

def run_async(coro):
    try:
        loop = asyncio.get_running_loop()
        return asyncio.run_coroutine_threadsafe(coro, loop).result()
    except RuntimeError:
        new_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(new_loop)
        try: return new_loop.run_until_complete(coro)
        finally: new_loop.close()

def hash_password(pw): return hashlib.sha256(pw.encode()).hexdigest()
def make_token(): return secrets.token_urlsafe(48)

def save_to_tg(marker, data, msg_id_holder):
    global USERS_MSG_ID, PAYMENTS_MSG_ID, SETTINGS_MSG_ID, CODES_MSG_ID, REWARDS_MSG_ID
    payload = marker + "\n" + json.dumps(data, ensure_ascii=False)
    try:
        if msg_id_holder == "users":
            if USERS_MSG_ID: run_async(client.edit_message(CHANNEL, USERS_MSG_ID, payload))
            else:
                msg = run_async(client.send_message(CHANNEL, payload)); USERS_MSG_ID = msg.id; run_async(client.pin_message(CHANNEL, msg.id))
        elif msg_id_holder == "payments":
            if PAYMENTS_MSG_ID: run_async(client.edit_message(CHANNEL, PAYMENTS_MSG_ID, payload))
            else:
                msg = run_async(client.send_message(CHANNEL, payload)); PAYMENTS_MSG_ID = msg.id; run_async(client.pin_message(CHANNEL, msg.id))
        elif msg_id_holder == "settings":
            if SETTINGS_MSG_ID: run_async(client.edit_message(CHANNEL, SETTINGS_MSG_ID, payload))
            else:
                msg = run_async(client.send_message(CHANNEL, payload)); SETTINGS_MSG_ID = msg.id; run_async(client.pin_message(CHANNEL, msg.id))
        elif msg_id_holder == "codes":
            if CODES_MSG_ID: run_async(client.edit_message(CHANNEL, CODES_MSG_ID, payload))
            else:
                msg = run_async(client.send_message(CHANNEL, payload)); CODES_MSG_ID = msg.id; run_async(client.pin_message(CHANNEL, msg.id))
        elif msg_id_holder == "rewards":
            if REWARDS_MSG_ID: run_async(client.edit_message(CHANNEL, REWARDS_MSG_ID, payload))
            else:
                msg = run_async(client.send_message(CHANNEL, payload)); REWARDS_MSG_ID = msg.id; run_async(client.pin_message(CHANNEL, msg.id))
    except Exception as e: print(f"⚠️ save {msg_id_holder} failed: {e}")

def load_from_tg(marker, dict_to_fill, id_type):
    global USERS_MSG_ID, PAYMENTS_MSG_ID, SETTINGS_MSG_ID, CODES_MSG_ID, REWARDS_MSG_ID
    try:
        msgs = run_async(client.get_messages(CHANNEL, limit=200))
        for m in msgs:
            if m.message and m.message.startswith(marker):
                if id_type == "users": USERS_MSG_ID = m.id
                elif id_type == "payments": PAYMENTS_MSG_ID = m.id
                elif id_type == "settings": SETTINGS_MSG_ID = m.id
                elif id_type == "codes": CODES_MSG_ID = m.id
                elif id_type == "rewards": REWARDS_MSG_ID = m.id
                _, _, json_part = m.message.partition("\n")
                dict_to_fill.clear()
                dict_to_fill.update(json.loads(json_part))
                return
    except Exception as e: print(f"⚠️ load {id_type} failed: {e}")

def save_users(): save_to_tg(USERS_MSG_MARKER, USERS, "users")
def save_payments(): save_to_tg(PAYMENTS_MSG_MARKER, PAYMENTS, "payments")
def save_settings(): save_to_tg(SETTINGS_MSG_MARKER, SETTINGS, "settings")
def save_codes(): save_to_tg(CODES_MSG_MARKER, CODES, "codes")
def save_rewards(): save_to_tg(REWARDS_MSG_MARKER, REWARDS, "rewards")

def load_users(): load_from_tg(USERS_MSG_MARKER, USERS, "users")
def load_payments(): load_from_tg(PAYMENTS_MSG_MARKER, PAYMENTS, "payments")
def load_settings(): load_from_tg(SETTINGS_MSG_MARKER, SETTINGS, "settings")
def load_codes(): load_from_tg(CODES_MSG_MARKER, CODES, "codes")
def load_rewards(): load_from_tg(REWARDS_MSG_MARKER, REWARDS, "rewards")

def require_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "): return jsonify({"error": "missing token"}), 401
        sess = SESSIONS.get(auth[7:])
        if not sess: return jsonify({"error": "invalid token"}), 401
        user = USERS.get(sess["phone"])
        if not user: return jsonify({"error": "user gone"}), 401
        request.user, request.phone = user, sess["phone"]
        return f(*args, **kwargs)
    return wrapper

def require_admin(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if request.headers.get("X-Admin-Key") != ADMIN_KEY: return jsonify({"error": "unauthorized"}), 401
        return f(*args, **kwargs)
    return wrapper

def _user_subscription_state(user):
    pay = user.get("payment", {})
    mode = pay.get("mode", "free")
    if mode == "free": return {"status": "free", "locked": False, "days_left": None}
    until_str = pay.get("until")
    if not until_str: return {"status": "none", "locked": True, "days_left": 0}
    try: until = datetime.fromisoformat(until_str)
    except Exception: return {"status": "none", "locked": True, "days_left": 0}
    now = datetime.utcnow()
    if until < now: return {"status": "expired", "locked": True, "days_left": 0, "until": until_str}
    return {"status": pay.get("status", "active"), "locked": False, "days_left": (until - now).days, "until": until_str}

@app.route("/privacy")
def privacy_policy():
    return "Privacy Policy - D2 AI. We collect phone and device ID for security."

@app.route("/auth/register", methods=["POST"])
def register():
    data = request.get_json() or {}
    phone, password, name, device_id = data.get("phone", "").strip(), data.get("password", ""), data.get("name", "").strip(), data.get("device_id", "")
    if not phone or not password or not device_id: return jsonify({"error": "missing fields"}), 400
    if phone in USERS: return jsonify({"error": "phone registered"}), 409
    for u_phone, u_data in USERS.items():
        if u_data.get("device_id") == device_id: return jsonify({"error": "device already linked"}), 403

    trial_days = SETTINGS.get("default_trial_days", 14)
    USERS[phone] = {
        "phone": phone, "password_hash": hash_password(password), "name": name,
        "device_id": device_id, "is_active": True, "recovery_code": secrets.token_hex(4).upper(),
        "payment": {"mode": "trial", "status": "trial", "until": (datetime.utcnow() + timedelta(days=trial_days)).isoformat()},
    }
    save_users()
    token = make_token()
    SESSIONS[token] = {"phone": phone}
    return jsonify({"token": token})

@app.route("/auth/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    phone, password, device_id = data.get("phone", "").strip(), data.get("password", ""), data.get("device_id", "")
    user = USERS.get(phone)
    if not user or user["password_hash"] != hash_password(password): return jsonify({"error": "invalid credentials"}), 401
    if user.get("device_id") != device_id: return jsonify({"error": "device_mismatch"}), 403
    token = make_token()
    SESSIONS[token] = {"phone": phone}
    return jsonify({"token": token})

@app.route("/api/subscription/status")
@require_auth
def subscription_status():
    state = _user_subscription_state(request.user)
    return jsonify({
        "subscription": state,
        "recovery_code": request.user.get("recovery_code", "N/A"),
        "name": request.user.get("name", "")
    })

@app.route("/api/subscription/redeem", methods=["POST"])
@require_auth
def redeem_code():
    data = request.get_json() or {}
    code = data.get("code", "").strip().upper()
    
    if code not in CODES:
        return jsonify({"error": "Invalid activation code"}), 400
        
    code_data = CODES[code]
    if code_data.get("used"):
        return jsonify({"error": "This code has already been used"}), 400
        
    days = code_data["days"]
    pay = request.user.setdefault("payment", {})
    base = datetime.utcnow()
    if pay.get("until"):
        try:
            prev = datetime.fromisoformat(pay["until"])
            if prev > base: base = prev
        except: pass
        
    pay.update({"mode": "paid", "status": "active", "until": (base + timedelta(days=days)).isoformat()})
    
    CODES[code]["used"] = True
    CODES[code]["used_by"] = request.phone
    CODES[code]["used_at"] = datetime.utcnow().isoformat()
    
    save_users()
    save_codes()
    
    return jsonify({"message": f"Successfully activated {days} days!"})

# --- NEW REWARD SUBMISSION ROUTE ---
@app.route("/api/reward", methods=["POST"])
@require_auth
def submit_reward():
    data = request.get_json() or {}
    proof = data.get("proof", "").strip()
    
    if not proof or len(proof) < 10:
        return jsonify({"error": "Please provide a valid video link"}), 400
        
    reward_id = f"RWD-{secrets.token_hex(3).upper()}"
    REWARDS[reward_id] = {
        "phone": request.phone,
        "proof": proof,
        "status": "pending",
        "date": datetime.utcnow().isoformat()
    }
    save_rewards()
    return jsonify({"message": "Reward submitted! Admin will review it shortly."})

@app.route("/api/payment/initialize", methods=["POST"])
@require_auth
def init_payment():
    data = request.get_json() or {}
    amount, days = data.get("amount", 99), data.get("days", 30)
    tx_ref = f"D2AI-{request.phone}-{int(datetime.utcnow().timestamp())}"
    
    headers = {"Authorization": f"Bearer {CHAPA_SECRET_KEY}", "Content-Type": "application/json"}
    
    payload = {
        "amount": str(amount), 
        "currency": "ETB", 
        "email": "hiabhiyu@gmail.com",
        "first_name": "User", 
        "last_name": "AI", 
        "tx_ref": tx_ref,
        "callback_url": "https://final-k4m9.onrender.com/api/payment/webhook",
        "return_url": "https://final-k4m9.onrender.com/api/subscription/status",
        "customization": {"title": "D2 AI Premium", "description": f"{days} Days"}
    }
    
    try:
        res = requests.post("https://api.chapa.co/v1/transaction/initialize", json=payload, headers=headers)
        res_data = res.json()
        
        if res_data.get("status") == "success":
            PAYMENTS[tx_ref] = {"phone": request.phone, "amount": amount, "days": days, "status": "pending", "date": datetime.utcnow().isoformat()}
            save_payments()
            return jsonify({"checkout_url": res_data["data"]["checkout_url"]})
        
        error_msg = str(res_data.get("message", "Failed to initialize payment"))
        return jsonify({"error": error_msg}), 400
        
    except Exception as e: 
        return jsonify({"error": "Network error connecting to Chapa"}), 500

@app.route("/api/payment/webhook", methods=["POST"])
def chapa_webhook():
    signature = request.headers.get("x-chapa-signature")
    if not signature: return jsonify({"error": "No signature"}), 400
    expected_hash = hmac.new(CHAPA_WEBHOOK_SECRET.encode('utf-8'), request.data, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_hash, signature): return jsonify({"error": "Invalid signature"}), 401

    data = request.get_json()
    if data.get("status") == "success":
        tx_ref = data.get("tx_ref")
        payment_info = PAYMENTS.get(tx_ref)
        if payment_info and payment_info.get("status") == "pending":
            phone, days = payment_info["phone"], payment_info["days"]
            user = USERS.get(phone)
            if user:
                pay = user.setdefault("payment", {})
                base = datetime.utcnow()
                if pay.get("until"):
                    try:
                        prev = datetime.fromisoformat(pay["until"])
                        if prev > base: base = prev
                    except: pass
                pay.update({"mode": "paid", "status": "active", "until": (base + timedelta(days=days)).isoformat()})
                
                PAYMENTS[tx_ref]["status"] = "completed"
                PAYMENTS[tx_ref]["completed_date"] = datetime.utcnow().isoformat()
                
                save_users()
                save_payments()
    return jsonify({"status": "ok"}), 200

# --- ADMIN PANEL ---
ADMIN_HTML = """
<!DOCTYPE html>
<html>
<head>
<title>D² Ai Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; font-family: system-ui, sans-serif; }
  body { margin: 0; background: #0F172A; color: white; }
  header { background: #1E293B; padding: 20px; text-align: center; border-bottom: 1px solid #334155; }
  h1 { margin: 0; color: #3B82F6; font-size: 24px; }
  .container { max-width: 1000px; margin: 20px auto; padding: 0 16px; }
  .card { background: #1E293B; padding: 20px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #334155; }
  h2 { margin-top: 0; color: #3B82F6; font-size: 18px; }
  input, select { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #334155; background: #0F172A; color: white; margin-bottom: 12px; }
  button { background: #3B82F6; color: white; border: 0; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-weight: bold; }
  button:hover { background: #2563EB; }
  button.danger { background: #EF4444; }
  button.success { background: #10B981; }
  .user-row { display: flex; justify-content: space-between; align-items: center; padding: 15px; border-bottom: 1px solid #334155; }
  .user-info { display: flex; flex-direction: column; gap: 5px; }
  .actions { display: flex; gap: 10px; }
  .payment-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; border-bottom: 1px solid #334155; font-size: 14px; }
  .code-box { display: flex; justify-content: space-between; align-items: center; background: #0F172A; padding: 12px; border-radius: 8px; margin-bottom: 8px; border: 1px solid #334155; }
  .code-text { font-family: monospace; font-size: 18px; font-weight: bold; color: #10B981; letter-spacing: 2px; }
  .reward-row { display: flex; justify-content: space-between; align-items: center; padding: 15px; border-bottom: 1px solid #334155; }
</style>
</head>
<body>
<header><h1>D² Ai — Admin Dashboard</h1></header>
<div class="container">
  <div class="card">
    <h2>🔑 Enter Admin Key</h2>
    <input type="password" id="adminKey" placeholder="Enter Admin Key">
    <button onclick="loadPanel()">Access Panel</button>
  </div>

  <div id="panel" style="display:none;">
    
    <!-- REWARD REQUESTS -->
    <div class="card">
      <h2>🎁 Reward Requests (Video Submissions)</h2>
      <p style="color:#94A3B8; font-size:14px; margin-bottom:10px;">Review user videos. Approve to grant 30 days free.</p>
      <div id="rewardsList">Loading...</div>
    </div>

    <!-- GENERATE CODES -->
    <div class="card">
      <h2>🎟️ Generate Activation Code</h2>
      <p style="color:#94A3B8; font-size:14px; margin-bottom:10px;">Generate a manual code for users to activate without Chapa.</p>
      <div style="display:flex; gap:10px; margin-bottom: 15px;">
        <select id="codeDays" style="flex:1;">
          <option value="30">30 Days (Monthly)</option>
          <option value="180">180 Days (6 Months)</option>
          <option value="365">365 Days (Yearly)</option>
          <option value="7">7 Days (Trial)</option>
        </select>
        <button onclick="generateCode()" class="success" style="flex:1;">Generate Code</button>
      </div>
      <div id="codesList"></div>
    </div>

    <!-- SUCCESSFUL PAYMENTS -->
    <div class="card">
      <h2>💰 Successful Payments</h2>
      <p style="color:#94A3B8; font-size:14px; margin-bottom:10px;">Recent completed transactions via Chapa.</p>
      <div id="paymentsList">Loading...</div>
    </div>

    <!-- USERS -->
    <div class="card">
      <h2>👥 User Management & Test Override</h2>
      <p style="color:#94A3B8; font-size:14px; margin-bottom:20px;">Manage subscriptions, test payments, or ban users.</p>
      <div id="usersList">Loading...</div>
    </div>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
const key = () => $('adminKey').value;

async function loadPanel() {
  if (!key()) return alert('Enter key');
  const r = await fetch('/admin/users', { headers: { 'X-Admin-Key': key() } });
  if (r.status === 401) return alert('Wrong key');
  $('panel').style.display = 'block';
  loadRewards();
  loadCodes();
  loadPayments();
  loadUsers();
}

async function loadRewards() {
  const r = await fetch('/admin/rewards', { headers: { 'X-Admin-Key': key() } });
  const rewards = await r.json();
  let html = '';
  
  const pending = Object.entries(rewards).filter(([id, rw]) => rw.status === 'pending');
  
  if (pending.length === 0) {
    html = '<div style="color:#94A3B8; font-size:14px;">No pending reward requests.</div>';
  } else {
    pending.forEach(([id, rw]) => {
      html += `
        <div class="reward-row">
          <div class="user-info">
            <b>${rw.phone}</b>
            <a href="${rw.proof}" target="_blank" style="color:#3B82F6; font-size:13px;">${rw.proof}</a>
          </div>
          <div class="actions">
            <button class="success" onclick="approveReward('${id}', '${rw.phone}')">Approve (30 Days)</button>
            <button class="danger" onclick="rejectReward('${id}')">Reject</button>
          </div>
        </div>`;
    });
  }
  $('rewardsList').innerHTML = html;
}

async function approveReward(id, phone) {
  if(!confirm('Approve this video and give 30 days free?')) return;
  await fetch('/admin/reward/' + id + '/approve', { 
    method: 'POST', 
    headers: { 'X-Admin-Key': key(), 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ phone: phone }) 
  });
  loadRewards();
  loadUsers();
}

async function rejectReward(id) {
  if(!confirm('Reject this request?')) return;
  await fetch('/admin/reward/' + id + '/reject', { method: 'POST', headers: { 'X-Admin-Key': key() } });
  loadRewards();
}

async function loadCodes() {
  const r = await fetch('/admin/codes', { headers: { 'X-Admin-Key': key() } });
  const codes = await r.json();
  let html = '';
  
  const sortedCodes = Object.entries(codes).sort((a, b) => new Date(b[1].created_at) - new Date(a[1].created_at));
  
  if (sortedCodes.length === 0) {
    html = '<div style="color:#94A3B8; font-size:14px;">No codes generated yet.</div>';
  } else {
    sortedCodes.slice(0, 10).forEach(([code, data]) => {
      const isUsed = data.used;
      const statusText = isUsed ? `<span style="color:#EF4444; font-size:12px;">(Used by ${data.used_by})</span>` : `<span style="color:#F59E0B; font-size:12px;">(Unused)</span>`;
      html += `
        <div class="code-box">
          <div>
            <span class="code-text">${code}</span> 
            <span style="color:#94A3B8; font-size:12px; margin-left:10px;">${data.days} Days</span>
            ${statusText}
          </div>
          <button onclick="navigator.clipboard.writeText('${code}'); alert('Code copied!')" style="padding:6px 12px; font-size:12px;">Copy</button>
        </div>`;
    });
  }
  $('codesList').innerHTML = html;
}

async function generateCode() {
  const days = $('codeDays').value;
  await fetch('/admin/generate-code', { 
    method: 'POST', 
    headers: { 'X-Admin-Key': key(), 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ days: parseInt(days) }) 
  });
  loadCodes();
}

async function loadPayments() {
  const r = await fetch('/admin/payments', { headers: { 'X-Admin-Key': key() } });
  const payments = await r.json();
  let html = '';
  
  const sortedPayments = Object.entries(payments)
    .filter(([ref, p]) => p.status === 'completed')
    .sort((a, b) => new Date(b[1].completed_date) - new Date(a[1].completed_date));

  if (sortedPayments.length === 0) {
      html = '<div style="color:#94A3B8; font-size:14px;">No completed payments yet.</div>';
  } else {
      sortedPayments.forEach(([ref, p]) => {
        const dateStr = new Date(p.completed_date).toLocaleString();
        html += `
          <div class="payment-row">
            <div><b>${p.phone}</b> paid <b style="color:#10B981">${p.amount} ETB</b> for ${p.days} days</div>
            <div style="color:#94A3B8; font-size:12px;">${dateStr}</div>
          </div>`;
      });
  }
  $('paymentsList').innerHTML = html;
}

async function loadUsers() {
  const r = await fetch('/admin/users', { headers: { 'X-Admin-Key': key() } });
  const users = await r.json();
  let html = '';
  users.forEach(u => {
    const isPaid = u.payment?.mode === 'paid';
    const statusBadge = isPaid ? '<span style="color:#10B981">⭐ Paid</span>' : '<span style="color:#F59E0B">🕒 Trial</span>';
    const statusBan = u.is_active ? '' : ' <span style="color:#EF4444">(Banned)</span>';
    
    html += `
      <div class="user-row">
        <div class="user-info">
          <b>${u.phone}</b> ${statusBadge} ${statusBan}
          <span style="color:#94A3B8; font-size:12px;">Name: ${u.name || 'N/A'} | Device: ${u.device_id}</span>
        </div>
        <div class="actions">
          <button class="danger" onclick="setExpired('${u.phone}')">Expire Now</button>
          <button class="success" onclick="addDays('${u.phone}', 30)">+30 Days</button>
          <button style="background:#475569" onclick="toggleBan('${u.phone}')">${u.is_active ? 'Ban' : 'Unban'}</button>
        </div>
      </div>`;
  });
  $('usersList').innerHTML = html;
}

async function setExpired(phone) {
  if(!confirm('Force expire this user to test payment?')) return;
  await fetch('/admin/user/' + phone + '/expire', { method: 'POST', headers: { 'X-Admin-Key': key() } });
  loadUsers();
}

async function addDays(phone, days) {
  await fetch('/admin/user/' + phone + '/add-days', { method: 'POST', headers: { 'X-Admin-Key': key(), 'Content-Type': 'application/json' }, body: JSON.stringify({ days: days }) });
  loadUsers();
}

async function toggleBan(phone) {
  await fetch('/admin/user/' + phone + '/toggle-ban', { method: 'POST', headers: { 'X-Admin-Key': key() } });
  loadUsers();
}
</script>
</body>
</html>
"""

@app.route("/admin")
def admin_page(): return render_template_string(ADMIN_HTML)

@app.route("/admin/users")
@require_admin
def admin_users():
    return jsonify([{"phone": u["phone"], "name": u.get("name"), "device_id": u.get("device_id"), "is_active": u.get("is_active", True), "payment": u.get("payment", {})} for u in USERS.values()])

@app.route("/admin/payments")
@require_admin
def admin_payments(): return jsonify(PAYMENTS)

@app.route("/admin/codes")
@require_admin
def admin_codes(): return jsonify(CODES)

@app.route("/admin/rewards")
@require_admin
def admin_rewards(): return jsonify(REWARDS)

@app.route("/admin/generate-code", methods=["POST"])
@require_admin
def admin_generate_code():
    days = int((request.get_json() or {}).get("days", 30))
    code = "D2AI-" + secrets.token_hex(3).upper()
    CODES[code] = {"days": days, "used": False, "created_at": datetime.utcnow().isoformat()}
    save_codes()
    return jsonify({"code": code})

@app.route("/admin/reward/<reward_id>/approve", methods=["POST"])
@require_admin
def admin_approve_reward(reward_id):
    if reward_id not in REWARDS: return jsonify({"error": "not found"}), 404
    phone = REWARDS[reward_id]["phone"]
    user = USERS.get(phone)
    if not user: return jsonify({"error": "user not found"}), 404
    
    pay = user.setdefault("payment", {})
    base = datetime.utcnow()
    if pay.get("until"):
        try:
            prev = datetime.fromisoformat(pay["until"])
            if prev > base: base = prev
        except: pass
        
    pay.update({"mode": "paid", "status": "active", "until": (base + timedelta(days=30)).isoformat()})
    
    REWARDS[reward_id]["status"] = "approved"
    REWARDS[reward_id]["approved_at"] = datetime.utcnow().isoformat()
    
    save_users()
    save_rewards()
    return jsonify({"ok": True})

@app.route("/admin/reward/<reward_id>/reject", methods=["POST"])
@require_admin
def admin_reject_reward(reward_id):
    if reward_id not in REWARDS: return jsonify({"error": "not found"}), 404
    REWARDS[reward_id]["status"] = "rejected"
    save_rewards()
    return jsonify({"ok": True})

@app.route("/admin/user/<phone>/expire", methods=["POST"])
@require_admin
def admin_expire_user(phone):
    user = USERS.get(phone)
    if not user: return jsonify({"error": "not found"}), 404
    past_date = (datetime.utcnow() - timedelta(days=1)).isoformat()
    user.setdefault("payment", {}).update({"mode": "trial", "status": "expired", "until": past_date})
    save_users()
    return jsonify({"ok": True})

@app.route("/admin/user/<phone>/add-days", methods=["POST"])
@require_admin
def admin_add_days(phone):
    user = USERS.get(phone)
    if not user: return jsonify({"error": "not found"}), 404
    days = int((request.get_json() or {}).get("days", 30))
    pay = user.setdefault("payment", {})
    base = datetime.utcnow()
    if pay.get("until"):
        try:
            prev = datetime.fromisoformat(pay["until"])
            if prev > base: base = prev
        except: pass
    pay.update({"mode": "paid", "status": "active", "until": (base + timedelta(days=days)).isoformat()})
    save_users()
    return jsonify({"ok": True})

@app.route("/admin/user/<phone>/toggle-ban", methods=["POST"])
@require_admin
def admin_toggle_ban(phone):
    user = USERS.get(phone)
    if not user: return jsonify({"error": "not found"}), 404
    user["is_active"] = not user.get("is_active", True)
    save_users()
    return jsonify({"ok": True})

# --- STARTUP LOGIC ---
def start_telegram_client():
    try:
        print("Starting Telegram Client...")
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(client.start())
        print("Loading databases from Telegram...")
        load_users()
        load_payments()
        load_settings()
        load_codes()
        load_rewards() # Load rewards on startup
        print("✅ Databases loaded successfully.")
        loop.run_forever()
    except Exception as e:
        print(f"❌ Startup error: {e}")

if __name__ == "__main__":
    telegram_thread = threading.Thread(target=start_telegram_client, daemon=True)
    telegram_thread.start()

    port = int(os.environ.get("PORT", 5000))
    print(f"Starting Flask on port {port}...")
    app.run(host="0.0.0.0", port=port)
