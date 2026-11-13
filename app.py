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
CHAPA_SECRET_KEY = os.environ.get("CHAPA_SECRET_KEY", "")
CHAPA_BASE_URL   = "https://api.chapa.co/v1"
APP_BASE_URL     = os.environ.get("APP_BASE_URL", "https://final-k4m9.onrender.com")

USERS_MSG_MARKER    = "D2AI_USERS_DB_v1"
SETTINGS_MSG_MARKER = "D2AI_SETTINGS_v1"
CODES_MSG_MARKER    = "D2AI_CODES_v1"

app = Flask(__name__)
CORS(app)

client = TelegramClient(StringSession(SESSION), API_ID, API_HASH)
tg_loop = asyncio.new_event_loop()
asyncio.set_event_loop(tg_loop)

def run(coro):
    return tg_loop.run_until_complete(coro)

def hash_password(pw):
    return hashlib.sha256(pw.encode()).hexdigest()

def make_token():
    return secrets.token_urlsafe(48)

USERS = {}
SESSIONS = {}
ACTIVATION_CODES = {}
USERS_MSG_ID = None
SETTINGS_MSG_ID = None
CODES_MSG_ID = None

DEFAULT_SETTINGS = {
    "default_price_etb": 100,
    "default_period_days": 30,
    "default_trial_days": 3,
    "payments_enabled_globally": True,
}
SETTINGS = dict(DEFAULT_SETTINGS)

def save_to_tg(marker, data, msg_id_holder):
    global USERS_MSG_ID, SETTINGS_MSG_ID, CODES_MSG_ID
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
    except Exception as e: print(f"⚠️ save {msg_id_holder} failed: {e}")

def load_from_tg(marker, dict_to_fill, id_type):
    global USERS_MSG_ID, SETTINGS_MSG_ID, CODES_MSG_ID
    try:
        msgs = run(client.get_messages(CHANNEL, limit=200))
        for m in msgs:
            if m.message and m.message.startswith(marker):
                if id_type == "users": USERS_MSG_ID = m.id
                elif id_type == "settings": SETTINGS_MSG_ID = m.id
                elif id_type == "codes": CODES_MSG_ID = m.id
                
                _, _, json_part = m.message.partition("\n")
                dict_to_fill.clear()
                dict_to_fill.update(json.loads(json_part))
                print(f"✅ Loaded {id_type}")
                return
    except Exception as e: print(f"⚠️ load {id_type} failed: {e}")

def save_users(): save_to_tg(USERS_MSG_MARKER, USERS, "users")
def save_settings(): save_to_tg(SETTINGS_MSG_MARKER, SETTINGS, "settings")
def save_codes(): save_to_tg(CODES_MSG_MARKER, ACTIVATION_CODES, "codes")

def load_users(): load_from_tg(USERS_MSG_MARKER, USERS, "users")
def load_settings(): load_from_tg(SETTINGS_MSG_MARKER, SETTINGS, "settings")
def load_codes(): load_from_tg(CODES_MSG_MARKER, ACTIVATION_CODES, "codes")

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

def get_msg_file_info(msg):
    if not msg: return None
    media = msg.video or msg.document
    if not media: return None
    return {"size": getattr(media, "size", 0) or 0, "mime": getattr(media, "mime_type", None) or "video/mp4", "duration": getattr(media, "duration", 0) or 0, "thumbs": getattr(media, "thumbs", None)}

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
    return jsonify({"payments_enabled_globally": SETTINGS.get("payments_enabled_globally", True), "mode": pay.get("mode", "free"), "price_etb": state.get("price_etb", 0), "period_days": pay.get("period_days", 30), "subscription": state})

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
    pay.update({"mode": "paid", "status": "active", "until": (base + timedelta(days=days)).isoformat(), "last_payment_ref": f"CODE-{code}", "last_payment_at": now.isoformat()})
    ACTIVATION_CODES[code]["used_by"] = request.phone
    ACTIVATION_CODES[code]["used_at"] = now.isoformat()
    save_users(); save_codes()
    return jsonify({"ok": True, "message": f"Successfully added {days} days!"})

# --- ZERO AUTH PAYMENT FLOW (WITH ERROR CATCHING) ---
@app.route("/api/subscription/pay_direct", methods=["POST"])
def pay_direct():
    try:
        data = request.get_json() or {}
        phone = data.get("phone", "0912345678").strip()
        
        # Clean phone number format
        if phone.startswith("0"): phone = "+251" + phone[1:]
        elif not phone.startswith("+"): phone = "+251" + phone

        amount = SETTINGS.get("default_price_etb", 100)
        tx_ref = f"d2ai-guest-{secrets.token_hex(6)}"
        
        payload = {
            "amount": str(amount), "currency": "ETB",
            "email": f"{phone.replace('+','')}@d2ai.app",
            "first_name": "Guest", "last_name": "User", "phone_number": phone,
            "tx_ref": tx_ref,
            "callback_url": f"{APP_BASE_URL}/verify",
            "return_url": f"{APP_BASE_URL}/payment/success?tx_ref={tx_ref}",
            "customization": {"title": "D² Ai Subscription", "description": f"{amount} ETB"},
        }
        
        import requests as http
        r = http.post(f"{CHAPA_BASE_URL}/transaction/initialize", json=payload, headers={"Authorization": f"Bearer {CHAPA_SECRET_KEY}", "Content-Type": "application/json"}, timeout=20)
        
        if r.status_code not in (200, 201): 
            return jsonify({"error": "chapa init failed", "detail": r.text}), 500
            
        response_data = r.json()
        return jsonify({"checkout_url": response_data["data"]["checkout_url"], "tx_ref": tx_ref, "amount": amount})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/payment/success")
def payment_success():
    tx_ref = request.args.get("tx_ref", "UNKNOWN")
    new_code = f"D2AI-{secrets.token_hex(4).upper()}"
    ACTIVATION_CODES[new_code] = {"days": SETTINGS["default_period_days"], "used_by": None, "tx_ref": tx_ref}
    save_codes()
    return f"""
    <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#0F172A;color:white;">
    <h1 style="color:#10B981;">✅ Payment Successful!</h1>
    <p>Your Activation Code is:</p>
    <h2 style="background:#1E293B;padding:15px;border-radius:10px;letter-spacing:2px;">{new_code}</h2>
    <p>Copy this code and enter it in the D² Ai app to unlock your account.</p>
    </body></html>
    """

# --- THE PAYMENT WEB PAGE (NO LOGIN REQUIRED) ---
PAYMENT_HTML = """
<!DOCTYPE html>
<html>
<head>
<title>D² Ai - Payment</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; text-align: center; padding: 40px 20px; background: #0F172A; color: white; }
  .card { background: #1E293B; padding: 30px; border-radius: 12px; max-width: 400px; margin: auto; box-shadow: 0 4px 12px rgba(0,0,0,0.5); border: 1px solid #334155; }
  h1 { color: #3b82f6; }
  input { width: 100%; padding: 12px; margin: 10px 0; border-radius: 8px; border: 1px solid #334155; background: #0F172A; color: white; font-size: 16px; }
  button { background: #10b981; color: white; border: none; padding: 15px 30px; font-size: 18px; border-radius: 8px; margin-top: 10px; width: 100%; cursor: pointer; font-weight: bold; }
  button:hover { background: #059669; }
  #status { color: #ef4444; margin-top: 15px; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Subscribe to D² Ai</h1>
    <p>Get unlimited access to all premium videos and the Offline AI Tutor.</p>
    <h2>100 ETB / 30 Days</h2>
    
    <input type="tel" id="phone" placeholder="Enter phone (e.g., 0912345678)">
    <button onclick="startPayment()">Pay with Chapa</button>
    <p id="status"></p>
  </div>

  <script>
    async function startPayment() {
      const status = document.getElementById('status');
      const phoneInput = document.getElementById('phone').value;
      
      if (!phoneInput) {
        status.innerText = "Please enter your phone number.";
        return;
      }

      status.innerText = "Initializing payment...";

      try {
        const res = await fetch('/api/subscription/pay_direct', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: phoneInput })
        });
        
        const data = await res.json();
        
        if (data.checkout_url) {
          window.location.href = data.checkout_url;
        } else {
          status.innerText = "Error: " + (data.error || "Unknown error");
        }
      } catch (e) {
        status.innerText = "Network Error: " + e;
      }
    }
  </script>
</body>
</html>
"""

@app.route("/payment")
def payment_page():
    return render_template_string(PAYMENT_HTML)

def parse_caption(caption):
    if not caption: return None
    parts = [p.strip() for p in caption.split("|", 3)]
    if len(parts) == 4: return {"subject": parts[0], "grade": parts[1], "chapter": parts[2], "topic": parts[3]}
    return {"subject": "General", "grade": "General", "chapter": "Uncategorized", "topic": caption}

def build_structure():
    msgs = run(client.get_messages(CHANNEL, limit=1000))
    grades = {}
    for m in msgs:
        info = get_msg_file_info(m)
        if not info: continue
        if m.message and (m.message.startswith(USERS_MSG_MARKER) or m.message.startswith(SETTINGS_MSG_MARKER) or m.message.startswith(CODES_MSG_MARKER)): continue
        meta = parse_caption(m.message or "")
        if not meta: continue
        g_name, sbj, ch = meta["grade"], meta["subject"], meta["chapter"]
        if g_name not in grades: grades[g_name] = {"grade": g_name, "subjects": {}}
        if sbj not in grades[g_name]["subjects"]: grades[g_name]["subjects"][sbj] = {"subject": sbj, "chapters": {}}
        if ch not in grades[g_name]["subjects"][sbj]["chapters"]: grades[g_name]["subjects"][sbj]["chapters"][ch] = {"chapter": ch, "videos": []}
        grades[g_name]["subjects"][sbj]["chapters"][ch]["videos"].append({
            "id": m.id, "tg_msg_id": m.id, "title": meta["topic"], "playlist": sbj, "grade": g_name, "chapter": ch, "subject": sbj,
            "stream_url": f"/stream/{m.id}", "download_url": f"/download/{m.id}", "thumb_url": f"/thumb/{m.id}",
        })
    result = []
    for g in grades.values():
        g["subjects"] = list(g["subjects"].values())
        for s in g["subjects"]:
            s["chapters"] = list(s["chapters"].values())
            for c in s["chapters"]: c["videos"].sort(key=lambda v: v["tg_msg_id"])
        result.append(g)
    return result

@app.route("/api/playlists")
@require_auth
def api_playlists(): return jsonify([{"title": g["grade"], "subject_count": len(g["subjects"])} for g in build_structure()])

@app.route("/api/grade/<string:grade_name>")
@require_auth
def api_grade(grade_name):
    for g in build_structure():
        if g["grade"] == grade_name: return jsonify(g)
    return jsonify({"error": "not found"}), 404

@app.route("/stream/<int:message_id>")
@require_auth
def stream(message_id):
    msg = run(client.get_messages(CHANNEL, ids=message_id))
    info = get_msg_file_info(msg)
    if not info: return "Not found", 404
    file_size, mime = info["size"], info["mime"]
    media = msg.video or msg.document
    range_header = request.headers.get("Range")
    start, end, status = 0, file_size - 1, 200
    if range_header:
        units, _, rng = range_header.partition("=")
        if units.strip() == "bytes":
            s, _, e = rng.partition("-")
            start = int(s) if s else 0
            end = int(e) if e else file_size - 1
            end = min(end, file_size - 1); status = 206
    length = end - start + 1
    def generate():
        for chunk in client.iter_download(media, offset=start, limit=length, chunk_size=524288): yield chunk
    return Response(generate(), status=status, headers={"Content-Type": mime, "Accept-Ranges": "bytes", "Content-Length": str(length), "Content-Range": f"bytes {start}-{end}/{file_size}", "Cache-Control": "public, max-age=3600"})

@app.route("/download/<int:message_id>")
@require_auth
def download(message_id):
    msg = run(client.get_messages(CHANNEL, ids=message_id))
    if not msg: return "Not found", 404
    file_size, mime, media = 0, "video/mp4", None
    if msg.video: media, file_size, mime = msg.video, msg.video.size, msg.video.mime_type or "video/mp4"
    elif msg.document: media, file_size, mime = msg.document, msg.document.size, msg.document.mime_type or "video/mp4"
    else: return "Not a video file", 404
    def generate():
        try:
            for chunk in client.iter_download(media, chunk_size=1048576): yield chunk
        except Exception: return
    return Response(generate(), headers={"Content-Type": mime, "Content-Length": str(file_size), "Content-Disposition": f'attachment; filename="{message_id}.mp4"', "Accept-Ranges": "bytes"})

@app.route("/thumb/<int:message_id>")
@require_auth
def thumb(message_id):
    try:
        msgs = run(client.get_messages(CHANNEL, limit=500))
        for m in msgs:
            if (m.photo and m.reply_to and hasattr(m.reply_to, 'reply_to_msg_id') and m.reply_to.reply_to_msg_id == message_id):
                buf = io.BytesIO(); run(client.download_media(m, file=buf)); buf.seek(0)
                return Response(buf.read(), mimetype="image/jpeg")
    except Exception: pass
    msg = run(client.get_messages(CHANNEL, ids=message_id))
    if not msg or not msg.video or not msg.video.thumbs: return "", 404
    buf = io.BytesIO(); run(client.download_media(msg, file=buf, thumb=-1)); buf.seek(0)
    return Response(buf.read(), mimetype="image/jpeg")

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
        for k in ["default_price_etb", "default_period_days", "default_trial_days", "payments_enabled_globally"]:
            if k in data: SETTINGS[k] = data[k]
        save_settings()
        return jsonify({"ok": True, "settings": SETTINGS})
    return jsonify(SETTINGS)

@app.route("/admin/structure")
@require_admin
def admin_structure(): return jsonify(build_structure())

@app.route("/admin/video/<int:msg_id>", methods=["DELETE"])
@require_admin
def admin_delete_video(msg_id):
    run(client.delete_messages(CHANNEL, [msg_id]))
    return jsonify({"ok": True})

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
  $('panel').style.display = 'block';
  loadUsers();
}

async function saveSettings() {
  await fetch('/admin/settings', {
    method: 'POST',
    headers: { 'X-Admin-Key': key(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ default_price_etb: parseInt($('defPrice').value), default_trial_days: parseInt($('defTrial').value) })
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

try:
    async def _start_client():
        await client.start()
        print("✅ TG Logged in")
    tg_loop.run_until_complete(_start_client())
    load_users()
    load_settings()
    load_codes()
except Exception as e: print(f"❌ Startup error: {e}")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
    
