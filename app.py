import os
import io
import json
import hashlib
import secrets
import asyncio
import traceback
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, request, Response, jsonify, render_template_string
from flask_cors import CORS
from telethon import TelegramClient
from telethon.sessions import StringSession

API_ID           = int(os.environ["API_ID"])
API_HASH         = os.environ["API_HASH"]
SESSION          = os.environ["TG_SESSION"]
CHANNEL          = int(os.environ["TG_CHANNEL"])
ADMIN_KEY        = os.environ["ADMIN_KEY"]

USERS_MSG_MARKER    = "D2AI_USERS_DB_v1"
SETTINGS_MSG_MARKER = "D2AI_SETTINGS_v1"
CODES_MSG_MARKER    = "D2AI_CODES_v1"
REWARDS_MSG_MARKER  = "D2AI_REWARDS_v1"

app = Flask(__name__)
CORS(app)

client = TelegramClient(StringSession(SESSION), API_ID, API_HASH)

USERS = {}
SESSIONS = {}
ACTIVATION_CODES = {}
REWARDS = {} # { "phone": { "status": "pending", "proof": "link" } }
USERS_MSG_ID = None
SETTINGS_MSG_ID = None
CODES_MSG_ID = None
REWARDS_MSG_ID = None

DEFAULT_SETTINGS = {
    "default_price_etb": 100,
    "default_period_days": 30,
    "default_trial_days": 3,
    "payments_enabled_globally": True,
    "payment_phone": "0952350836",
    "payment_name": "Noah",
    "support_telegram": "https://t.me/Ace_spy" 
}
SETTINGS = dict(DEFAULT_SETTINGS)

def run(coro):
    try:
        loop = asyncio.get_running_loop()
        return asyncio.run_coroutine_threadsafe(coro, loop).result()
    except RuntimeError:
        new_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(new_loop)
        try:
            return new_loop.run_until_complete(coro)
        finally:
            new_loop.close()

def hash_password(pw): return hashlib.sha256(pw.encode()).hexdigest()
def make_token(): return secrets.token_urlsafe(48)

def save_to_tg(marker, data, msg_id_holder):
    global USERS_MSG_ID, SETTINGS_MSG_ID, CODES_MSG_ID, REWARDS_MSG_ID
    payload = marker + "\n" + json.dumps(data, ensure_ascii=False)
    try:
        if msg_id_holder == "users":
            if USERS_MSG_ID: run(client.edit_message(CHANNEL, USERS_MSG_ID, payload))
            else:
                msg = run(client.send_message(CHANNEL, payload)); USERS_MSG_ID = msg.id; run(client.pin_message(CHANNEL, msg.id))
        elif msg_id_holder == "settings":
            if SETTINGS_MSG_ID: run(client.edit_message(CHANNEL, SETTINGS_MSG_ID, payload))
            else:
                msg = run(client.send_message(CHANNEL, payload)); SETTINGS_MSG_ID = msg.id; run(client.pin_message(CHANNEL, msg.id))
        elif msg_id_holder == "codes":
            if CODES_MSG_ID: run(client.edit_message(CHANNEL, CODES_MSG_ID, payload))
            else:
                msg = run(client.send_message(CHANNEL, payload)); CODES_MSG_ID = msg.id; run(client.pin_message(CHANNEL, msg.id))
        elif msg_id_holder == "rewards":
            if REWARDS_MSG_ID: run(client.edit_message(CHANNEL, REWARDS_MSG_ID, payload))
            else:
                msg = run(client.send_message(CHANNEL, payload)); REWARDS_MSG_ID = msg.id; run(client.pin_message(CHANNEL, msg.id))
    except Exception as e: print(f"⚠️ save {msg_id_holder} failed: {e}")

def load_from_tg(marker, dict_to_fill, id_type):
    global USERS_MSG_ID, SETTINGS_MSG_ID, CODES_MSG_ID, REWARDS_MSG_ID
    try:
        msgs = run(client.get_messages(CHANNEL, limit=200))
        for m in msgs:
            if m.message and m.message.startswith(marker):
                if id_type == "users": USERS_MSG_ID = m.id
                elif id_type == "settings": SETTINGS_MSG_ID = m.id
                elif id_type == "codes": CODES_MSG_ID = m.id
                elif id_type == "rewards": REWARDS_MSG_ID = m.id
                
                _, _, json_part = m.message.partition("\n")
                dict_to_fill.clear()
                dict_to_fill.update(json.loads(json_part))
                print(f"✅ Loaded {id_type}")
                return
    except Exception as e: print(f"⚠️ load {id_type} failed: {e}")

def save_users(): save_to_tg(USERS_MSG_MARKER, USERS, "users")
def save_settings(): save_to_tg(SETTINGS_MSG_MARKER, SETTINGS, "settings")
def save_codes(): save_to_tg(CODES_MSG_MARKER, ACTIVATION_CODES, "codes")
def save_rewards(): save_to_tg(REWARDS_MSG_MARKER, REWARDS, "rewards")

def load_users(): load_from_tg(USERS_MSG_MARKER, USERS, "users")
def load_settings(): load_from_tg(SETTINGS_MSG_MARKER, SETTINGS, "settings")
def load_codes(): load_from_tg(CODES_MSG_MARKER, ACTIVATION_CODES, "codes")
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
    if not SETTINGS.get("payments_enabled_globally"): return {"status": "free", "locked": False, "days_left": None, "price_etb": 0}
    pay = user.get("payment", {})
    mode = pay.get("mode", "free")
    price = pay.get("price_etb", SETTINGS["default_price_etb"])
    if mode == "free": return {"status": "free", "locked": False, "days_left": None, "price_etb": 0}
    until_str = pay.get("until")
    if not until_str: return {"status": "none", "locked": True, "days_left": 0, "price_etb": price}
    try: until = datetime.fromisoformat(until_str)
    except Exception: return {"status": "none", "locked": True, "days_left": 0, "price_etb": price}
    now = datetime.utcnow()
    if until < now: return {"status": "expired", "locked": True, "days_left": 0, "price_etb": price, "until": until_str}
    return {"status": pay.get("status", "active"), "locked": False, "days_left": (until - now).days, "price_etb": price, "until": until_str}

def _require_active_subscription(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        state = _user_subscription_state(request.user)
        if state["locked"]: return jsonify({"error": "subscription_required", "subscription": state, "price_etb": state["price_etb"]}), 402
        return f(*args, **kwargs)
    return wrapper

@app.route("/auth/register", methods=["POST"])
def register():
    data = request.get_json() or {}
    phone, password, name, device_id = data.get("phone", "").strip(), data.get("password", ""), data.get("name", "").strip(), data.get("device_id", "")
    device_name = data.get("device_name", "Unknown")
    if not phone or not password or not device_id: return jsonify({"error": "phone, password, device_id required"}), 400
    if phone in USERS: return jsonify({"error": "phone already registered"}), 409
    trial_days = SETTINGS.get("default_trial_days", 3)
    USERS[phone] = {
        "phone": phone, "password_hash": hash_password(password), "name": name,
        "device_id": device_id, "device_name": device_name, "is_active": True,
        "created_at": datetime.utcnow().isoformat(), "last_login": None,
        "payment": {
            "mode": "trial", "price_etb": SETTINGS["default_price_etb"], "period_days": SETTINGS["default_period_days"], "status": "trial",
            "until": (datetime.utcnow() + timedelta(days=trial_days)).isoformat(),
            "note": "", "last_payment_at": None, "last_payment_ref": None, "pending_tx_ref": None,
        },
    }
    save_users()
    token = make_token()
    SESSIONS[token] = {"phone": phone, "device_id": device_id}
    return jsonify({"token": token, "user": {"phone": phone, "name": name}})

@app.route("/auth/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    phone, password, device_id = data.get("phone", "").strip(), data.get("password", ""), data.get("device_id", "")
    device_name = data.get("device_name", "Unknown")
    if not phone or not password or not device_id: return jsonify({"error": "phone, password, device_id required"}), 400
    user = USERS.get(phone)
    if not user or user["password_hash"] != hash_password(password): return jsonify({"error": "invalid credentials"}), 401
    if not user.get("is_active", True): return jsonify({"error": "account disabled"}), 403
    if user.get("device_id") is None:
        user["device_id"], user["device_name"] = device_id, device_name
    elif user["device_id"] != device_id: return jsonify({"error": "device_not_registered", "message": "Locked to another device."}), 403
    user["last_login"] = datetime.utcnow().isoformat()
    save_users()
    token = make_token()
    SESSIONS[token] = {"phone": phone, "device_id": device_id}
    return jsonify({"token": token, "user": {"phone": phone, "name": user["name"]}})

@app.route("/api/subscription/status")
@require_auth
def subscription_status():
    state = _user_subscription_state(request.user)
    pay = request.user.get("payment", {})
    return jsonify({
        "payments_enabled_globally": SETTINGS.get("payments_enabled_globally", True), 
        "mode": pay.get("mode", "free"), 
        "price_etb": state.get("price_etb", 0), 
        "period_days": pay.get("period_days", 30), 
        "subscription": state
    })

@app.route("/api/ai/check", methods=["GET"])
@require_auth
@_require_active_subscription
def check_ai_access(): return jsonify({"allowed": True})

@app.route("/api/subscription/redeem", methods=["POST"])
@require_auth
def redeem_code():
    data = request.get_json() or {}
    code = data.get("code", "").strip().upper()
    if not code: return jsonify({"error": "Code required"}), 400
    code_data = ACTIVATION_CODES.get(code)
    if not code_data: return jsonify({"error": "Invalid code"}), 404
    if code_data.get("used_by"): return jsonify({"error": "Code already used"}), 400
    days = code_data.get("days", 30)
    now = datetime.utcnow()
    pay = request.user.setdefault("payment", {})
    base = now
    until_str = pay.get("until")
    if until_str:
        try:
            prev = datetime.fromisoformat(until_str)
            if prev > now: base = prev
        except Exception: pass
        
    new_until = base + timedelta(days=days)
    pay.update({"mode": "paid", "status": "active", "until": new_until.isoformat(), "last_payment_ref": f"CODE-{code}", "last_payment_at": now.isoformat()})
    ACTIVATION_CODES[code]["used_by"] = request.phone
    ACTIVATION_CODES[code]["used_at"] = now.isoformat()
    save_users(); save_codes()
    
    days_left = (new_until - now).days
    return jsonify({"ok": True, "message": f"Successfully activated! You have {days_left} days of Premium left."})

@app.route("/api/reward", methods=["POST"])
@require_auth
def submit_reward():
    data = request.get_json() or {}
    proof = data.get("proof", "").strip()
    if not proof: return jsonify({"error": "Proof link required"}), 400
    REWARDS[request.phone] = {"phone": request.phone, "proof": proof, "status": "pending", "submitted_at": datetime.utcnow().isoformat()}
    save_rewards()
    return jsonify({"ok": True, "message": "Proof submitted! Admin will review it."})

@app.route("/api/support")
def get_support():
    return jsonify({
        "telegram": SETTINGS.get("support_telegram", ""),
        "payment_phone": SETTINGS.get("payment_phone", "0952350836"),
        "payment_name": SETTINGS.get("payment_name", "Noah")
    })

@app.route("/admin/users")
@require_admin
def admin_users(): return jsonify([{"phone": u["phone"], "name": u.get("name"), "is_active": u.get("is_active", True), "payment": u.get("payment", {})} for u in USERS.values()])

@app.route("/admin/toggle-user/<phone>", methods=["POST"])
@require_admin
def admin_toggle_user(phone):
    user = USERS.get(phone)
    if not user: return jsonify({"error": "user not found"}), 404
    user["is_active"] = not user.get("is_active", True)
    save_users()
    return jsonify({"ok": True, "is_active": user["is_active"]})

@app.route("/admin/generate-code", methods=["POST"])
@require_admin
def admin_generate_code():
    data = request.get_json() or {}
    days = int(data.get("days", 30))
    code = f"D2AI-{secrets.token_hex(4).upper()}"
    ACTIVATION_CODES[code] = {"days": days, "used_by": None}
    save_codes()
    return jsonify({"ok": True, "code": code})

@app.route("/admin/settings", methods=["GET", "POST"])
@require_admin
def admin_settings():
    if request.method == "POST":
        data = request.get_json() or {}
        for k in ["default_price_etb", "default_period_days", "default_trial_days", "payments_enabled_globally", "payment_phone", "payment_name", "support_telegram"]:
            if k in data: SETTINGS[k] = data[k]
        save_settings()
        return jsonify({"ok": True, "settings": SETTINGS})
    return jsonify(SETTINGS)

@app.route("/admin/rewards")
@require_admin
def admin_rewards():
    return jsonify(list(REWARDS.values()))

@app.route("/admin/reward/<phone>/approve", methods=["POST"])
@require_admin
def admin_approve_reward(phone):
    if phone not in REWARDS: return jsonify({"error": "reward not found"}), 404
    user = USERS.get(phone)
    if not user: return jsonify({"error": "user not found"}), 404
    
    now = datetime.utcnow()
    pay = user.setdefault("payment", {})
    base = now
    until_str = pay.get("until")
    if until_str:
        try:
            prev = datetime.fromisoformat(until_str)
            if prev > now: base = prev
        except Exception: pass
        
    pay.update({"mode": "paid", "status": "active", "until": (base + timedelta(days=30)).isoformat(), "last_payment_ref": "REWARD-50-LIKES", "last_payment_at": now.isoformat()})
    
    del REWARDS[phone]
    save_users(); save_rewards()
    return jsonify({"ok": True, "message": "Reward approved! 30 days added."})

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
  .row { display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid #334155; font-size: 14px; }
</style>
</head>
<body>
<header><h1>D² Ai — Admin Panel</h1></header>
<div class="container">
  <div class="card">
    <h2>🔑 Admin Key</h2>
    <input type="password" id="adminKey" placeholder="Enter Admin Key">
    <button onclick="loadPanel()">Enter Panel</button>
  </div>

  <div id="panel" style="display:none;">
    <div class="card">
      <h2>⚙️ Global Settings</h2>
      <label>Price (ETB)</label><input type="number" id="defPrice" value="100">
      <label>Trial Days</label><input type="number" id="defTrial" value="3">
      <label>Payment Phone</label><input type="text" id="payPhone" value="0952350836">
      <label>Payment Name</label><input type="text" id="payName" value="Noah">
      <label>Support Telegram Link</label><input type="text" id="supportTg" value="https://t.me/Ace_spy">
      <button onclick="saveSettings()">Save Settings</button>
    </div>

    <div class="card">
      <h2>🎟️ Generate Activation Code</h2>
      <label>Days to add:</label>
      <input type="number" id="codeDays" value="30">
      <button onclick="genCode()">Generate Code</button>
      <div id="codeResult" style="margin-top:10px; font-weight:bold; color:#10B981;"></div>
    </div>

    <div class="card">
      <h2>🏆 Rewards (50 Likes)</h2>
      <div id="rewardsList"></div>
    </div>

    <div class="card">
      <h2>👥 Users Management</h2>
      <div id="usersList"></div>
    </div>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
const key = () => $('adminKey').value;

async function loadPanel() {
  if (!key()) return alert('Enter key');
  const r = await fetch('/admin/settings', { headers: { 'X-Admin-Key': key() } });
  if (r.status === 401) return alert('Wrong key');
  const s = await r.json();
  $('defPrice').value = s.default_price_etb;
  $('defTrial').value = s.default_trial_days;
  $('payPhone').value = s.payment_phone || "0952350836";
  $('payName').value = s.payment_name || "Noah";
  $('supportTg').value = s.support_telegram || "";
  $('panel').style.display = 'block';
  loadUsers();
  loadRewards();
}

async function saveSettings() {
  await fetch('/admin/settings', {
    method: 'POST',
    headers: { 'X-Admin-Key': key(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      default_price_etb: parseInt($('defPrice').value), 
      default_trial_days: parseInt($('defTrial').value),
      payment_phone: $('payPhone').value,
      payment_name: $('payName').value,
      support_telegram: $('supportTg').value
    })
  });
  alert('Settings saved!');
}

async function genCode() {
  const days = parseInt($('codeDays').value);
  const r = await fetch('/admin/generate-code', {
    method: 'POST',
    headers: { 'X-Admin-Key': key(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: days })
  });
  const data = await r.json();
  $('codeResult').innerText = `Code: ${data.code} (Valid for ${days} days)`;
}

async function loadRewards() {
  $('rewardsList').innerHTML = 'Loading...';
  const r = await fetch('/admin/rewards', { headers: { 'X-Admin-Key': key() } });
  const rewards = await r.json();
  let html = '';
  rewards.forEach(rw => {
    html += `
      <div class="row">
        <div><b>${rw.phone}</b><br><span style="color:#94A3B8;font-size:12px;">Proof: ${rw.proof}</span></div>
        <div><button class="success" onclick="approveReward('${rw.phone}')">Approve</button></div>
      </div>`;
  });
  $('rewardsList').innerHTML = html || 'No pending rewards.';
}

async function approveReward(phone) {
  await fetch('/admin/reward/' + phone + '/approve', { method: 'POST', headers: { 'X-Admin-Key': key() } });
  loadRewards();
  loadUsers();
}

async function loadUsers() {
  $('usersList').innerHTML = 'Loading...';
  const r = await fetch('/admin/users', { headers: { 'X-Admin-Key': key() } });
  const users = await r.json();
  let html = '';
  users.forEach(u => {
    html += `
      <div class="row">
        <div><b>${u.phone}</b> - ${u.name || 'No Name'} (${u.is_active ? '🟢 Active' : '🔴 Disabled'})</div>
        <div><button class="${u.is_active ? 'danger' : 'success'}" onclick="toggleUser('${u.phone}')">${u.is_active ? 'Disable' : 'Enable'}</button></div>
      </div>`;
  });
  $('usersList').innerHTML = html || 'No users found.';
}

async function toggleUser(phone) {
  await fetch('/admin/toggle-user/' + phone, { method: 'POST', headers: { 'X-Admin-Key': key() } });
  loadUsers();
}
</script>
</body>
</html>
"""

@app.route("/admin")
def admin_page(): return render_template_string(ADMIN_HTML)

if __name__ == "__main__":
    try:
        asyncio.run(client.start())
        print("✅ TG Logged in")
        load_users()
        load_settings()
        load_codes()
        load_rewards()
    except Exception as e:
        print(f"❌ Startup error: {e}")
        
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
