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
REWARDS = {}
USERS_MSG_ID = None
SETTINGS_MSG_ID = None
CODES_MSG_ID = None
REWARDS_MSG_ID = None

DEFAULT_SETTINGS = {
    "default_price_etb": 99,
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
        try: return new_loop.run_until_complete(coro)
        finally: new_loop.close()

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
    if not SETTINGS.get("payments_enabled_globally"): return {"status": "free", "locked": False, "days_left": None}
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

def _require_active_subscription(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        state = _user_subscription_state(request.user)
        if state["locked"]: return jsonify({"error": "subscription_required", "subscription": state}), 402
        return f(*args, **kwargs)
    return wrapper

@app.route("/auth/register", methods=["POST"])
def register():
    data = request.get_json() or {}
    phone, password, name, device_id = data.get("phone", "").strip(), data.get("password", ""), data.get("name", "").strip(), data.get("device_id", "")
    device_name = data.get("device_name", "Unknown")
    
    if not phone or not password or not device_id: return jsonify({"error": "phone, password, device_id required"}), 400
    if phone in USERS: return jsonify({"error": "phone already registered"}), 409
    
    # Enforce 1 Device = 1 Account
    for u_phone, u_data in USERS.items():
        if u_data.get("device_id") == device_id:
            return jsonify({"error": "This device is already linked to an account. Please recover your old account."}), 403

    trial_days = SETTINGS.get("default_trial_days", 3)
    USERS[phone] = {
        "phone": phone, "password_hash": hash_password(password), "name": name,
        "device_id": device_id, "device_name": device_name, "is_active": True,
        "created_at": datetime.utcnow().isoformat(), "last_login": None,
        "profile_pic": "", "recovery_code": secrets.token_hex(4).upper(),
        "payment": {
            "mode": "trial", "price_etb": SETTINGS["default_price_etb"], "period_days": SETTINGS["default_period_days"], "status": "trial",
            "until": (datetime.utcnow() + timedelta(days=trial_days)).isoformat(),
        },
    }
    save_users()
    token = make_token()
    SESSIONS[token] = {"phone": phone, "device_id": device_id}
    return jsonify({"token": token, "user": {"phone": phone, "name": name, "recovery_code": USERS[phone]["recovery_code"]}})

@app.route("/auth/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    phone, password, device_id = data.get("phone", "").strip(), data.get("password", ""), data.get("device_id", "")
    if not phone or not password or not device_id: return jsonify({"error": "phone, password, device_id required"}), 400
    user = USERS.get(phone)
    if not user or user["password_hash"] != hash_password(password): return jsonify({"error": "invalid credentials"}), 401
    if not user.get("is_active", True): return jsonify({"error": "account disabled"}), 403
    
    if user.get("device_id") != device_id: 
        return jsonify({"error": "device_mismatch", "message": "Account locked to another device. Use Recovery Code."}), 403
        
    user["last_login"] = datetime.utcnow().isoformat()
    save_users()
    token = make_token()
    SESSIONS[token] = {"phone": phone, "device_id": device_id}
    return jsonify({"token": token, "user": {"phone": phone, "name": user["name"], "recovery_code": user.get("recovery_code")}})

@app.route("/auth/recover", methods=["POST"])
def recover_account():
    data = request.get_json() or {}
    phone, recovery_code, new_device_id = data.get("phone", "").strip(), data.get("recovery_code", "").strip().upper(), data.get("device_id", "")
    user = USERS.get(phone)
    if not user or user.get("recovery_code") != recovery_code: 
        return jsonify({"error": "Invalid phone or recovery code"}), 401
        
    user["device_id"] = new_device_id
    save_users()
    token = make_token()
    SESSIONS[token] = {"phone": phone, "device_id": new_device_id}
    return jsonify({"token": token, "user": {"phone": phone, "name": user["name"]}})

@app.route("/auth/profile", methods=["POST"])
@require_auth
def update_profile():
    data = request.get_json() or {}
    if "name" in data and data["name"]: request.user["name"] = data["name"]
    if "profile_pic" in data: request.user["profile_pic"] = data["profile_pic"]
    save_users()
    return jsonify({"ok": True})

@app.route("/api/subscription/status")
@require_auth
def subscription_status():
    state = _user_subscription_state(request.user)
    return jsonify({
        "mode": request.user.get("payment", {}).get("mode", "free"),
        "subscription": state,
        "name": request.user.get("name", ""),
        "profile_pic": request.user.get("profile_pic", ""),
        "recovery_code": request.user.get("recovery_code", "")
    })

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
    
    # If currently paid, extend. If trial, replace.
    base = now
    if pay.get("mode") == "paid" and pay.get("until"):
        try:
            prev = datetime.fromisoformat(pay.get("until"))
            if prev > now: base = prev
        except Exception: pass
        
    new_until = base + timedelta(days=days)
    pay.update({"mode": "paid", "status": "active", "until": new_until.isoformat()})
    
    ACTIVATION_CODES[code]["used_by"] = request.phone
    save_users(); save_codes()
    
    days_left = (new_until - now).days
    return jsonify({"ok": True, "message": f"Activated! You have {days_left} days left."})

@app.route("/api/support")
def get_support():
    return jsonify({"telegram": SETTINGS.get("support_telegram", ""), "payment_phone": SETTINGS.get("payment_phone", ""), "payment_name": SETTINGS.get("payment_name", "")})

@app.route("/api/reward", methods=["POST"])
@require_auth
def submit_reward():
    data = request.get_json() or {}
    proof = data.get("proof", "").strip()
    if not proof: return jsonify({"error": "Proof link required"}), 400
    REWARDS[request.phone] = {"phone": request.phone, "proof": proof}
    save_rewards()
    return jsonify({"ok": True, "message": "Proof submitted! Admin will review it."})

@app.route("/admin")
def admin_page(): return "Admin Panel"
@app.route("/admin/settings", methods=["GET", "POST"])
@require_admin
def admin_settings():
    if request.method == "POST":
        data = request.get_json() or {}
        for k in SETTINGS.keys():
            if k in data: SETTINGS[k] = data[k]
        save_settings()
        return jsonify({"ok": True})
    return jsonify(SETTINGS)

if __name__ == "__main__":
    try:
        asyncio.run(client.start())
        load_users(); load_settings(); load_codes(); load_rewards()
    except Exception as e: print(f"❌ Startup error: {e}")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
