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

app = Flask(__name__)
CORS(app)
client = TelegramClient(StringSession(SESSION), API_ID, API_HASH)

# Global data stores
USERS = {}
SESSIONS = {}
PAYMENTS = {}
SETTINGS = {}
USERS_MSG_ID = None
PAYMENTS_MSG_ID = None
SETTINGS_MSG_ID = None

DEFAULT_SETTINGS = {
    "default_trial_days": 14,
    "chapa_test_mode": True 
}

# --- ASYNC HELPERS ---
def run_async(coro):
    """Run a coroutine in a new event loop safely."""
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
    global USERS_MSG_ID, PAYMENTS_MSG_ID, SETTINGS_MSG_ID
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
    except Exception as e: print(f"⚠️ save {msg_id_holder} failed: {e}")

def load_from_tg(marker, dict_to_fill, id_type):
    global USERS_MSG_ID, PAYMENTS_MSG_ID, SETTINGS_MSG_ID
    try:
        msgs = run_async(client.get_messages(CHANNEL, limit=200))
        for m in msgs:
            if m.message and m.message.startswith(marker):
                if id_type == "users": USERS_MSG_ID = m.id
                elif id_type == "payments": PAYMENTS_MSG_ID = m.id
                elif id_type == "settings": SETTINGS_MSG_ID = m.id
                _, _, json_part = m.message.partition("\n")
                dict_to_fill.clear()
                dict_to_fill.update(json.loads(json_part))
                return
    except Exception as e: print(f"⚠️ load {id_type} failed: {e}")

def save_users(): save_to_tg(USERS_MSG_MARKER, USERS, "users")
def save_payments(): save_to_tg(PAYMENTS_MSG_MARKER, PAYMENTS, "payments")
def save_settings(): save_to_tg(SETTINGS_MSG_MARKER, SETTINGS, "settings")

def load_users(): load_from_tg(USERS_MSG_MARKER, USERS, "users")
def load_payments(): load_from_tg(PAYMENTS_MSG_MARKER, PAYMENTS, "payments")
def load_settings(): load_from_tg(SETTINGS_MSG_MARKER, SETTINGS, "settings")

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
    return jsonify({"subscription": state})

@app.route("/api/payment/initialize", methods=["POST"])
@require_auth
def init_payment():
    data = request.get_json() or {}
    amount, days = data.get("amount", 99), data.get("days", 30)
    tx_ref = f"D2AI-{request.phone}-{int(datetime.utcnow().timestamp())}"
    headers = {"Authorization": f"Bearer {CHAPA_SECRET_KEY}", "Content-Type": "application/json"}
    payload = {
        "amount": str(amount), "currency": "ETB", "email": f"{request.phone}@d2ai.com",
        "first_name": "User", "last_name": "AI", "phone_number": request.phone, "tx_ref": tx_ref,
        "callback_url": "https://final-k4m9.onrender.com/api/payment/webhook",
        "return_url": "https://final-k4m9.onrender.com/api/subscription/status",
        "customization": {"title": "D² AI Premium", "description": f"{days} Days"}
    }
    try:
        res = requests.post("https://api.chapa.co/v1/transaction/initialize", json=payload, headers=headers)
        res_data = res.json()
        if res_data.get("status") == "success":
            PAYMENTS[tx_ref] = {"phone": request.phone, "days": days, "status": "pending"}
            save_payments()
            return jsonify({"checkout_url": res_data["data"]["checkout_url"]})
        return jsonify({"error": "Failed to init"}), 400
    except Exception as e: return jsonify({"error": str(e)}), 500

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
  input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #334155; background: #0F172A; color: white; margin-bottom: 12px; }
  button { background: #3B82F6; color: white; border: 0; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-weight: bold; }
  button:hover { background: #2563EB; }
  button.danger { background: #EF4444; }
  button.success { background: #10B981; }
  .user-row { display: flex; justify-content: space-between; align-items: center; padding: 15px; border-bottom: 1px solid #334155; }
  .user-info { display: flex; flex-direction: column; gap: 5px; }
  .actions { display: flex; gap: 10px; }
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
    <div class="card">
      <h2>👥 User Management & Test Override</h2>
      <p style="color:#94A3B8; font-size:14px; margin-bottom:20px;">Manage subscriptions, test payments, or ban users.</p>
      <div id="usersList"></div>
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
  loadUsers();
}

async function loadUsers() {
  $('usersList').innerHTML = 'Loading...';
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

# --- CORRECTED STARTUP LOGIC ---
def start_telegram_client():
    """Starts the Telethon client in a separate thread to prevent blocking Flask."""
    try:
        print("Starting Telegram Client...")
        # Use a dedicated event loop for Telethon
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(client.start())
        print("Loading databases from Telegram...")
        load_users()
        load_payments()
        load_settings()
        print("✅ Databases loaded successfully.")
        # Keep the loop running for background tasks
        loop.run_forever()
    except Exception as e:
        print(f"❌ Startup error: {e}")

if __name__ == "__main__":
    # 1. Start Telegram in a background thread so it doesn't block Flask
    telegram_thread = threading.Thread(target=start_telegram_client, daemon=True)
    telegram_thread.start()

    # 2. Start Flask immediately on the port Render provides
    port = int(os.environ.get("PORT", 5000))
    print(f"Starting Flask on port {port}...")
    app.run(host="0.0.0.0", port=port)
