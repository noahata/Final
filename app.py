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
USERS_MSG_ID = None
SETTINGS_MSG_ID = None

DEFAULT_SETTINGS = {
    "default_price_etb": 100,
    "default_period_days": 30,
    "default_trial_days": 3,
    "payments_enabled_globally": True, # Changed to True to enable testing
}
SETTINGS = dict(DEFAULT_SETTINGS)

def save_users():
    global USERS_MSG_ID
    payload = USERS_MSG_MARKER + "\n" + json.dumps(USERS, ensure_ascii=False)
    try:
        if USERS_MSG_ID:
            run(client.edit_message(CHANNEL, USERS_MSG_ID, payload))
        else:
            msg = run(client.send_message(CHANNEL, payload))
            USERS_MSG_ID = msg.id
            run(client.pin_message(CHANNEL, msg.id))
    except Exception as e:
        print(f"⚠️ save_users failed: {e}")

def load_users():
    global USERS_MSG_ID
    try:
        msgs = run(client.get_messages(CHANNEL, limit=200))
        for m in msgs:
            if m.message and m.message.startswith(USERS_MSG_MARKER):
                USERS_MSG_ID = m.id
                _, _, json_part = m.message.partition("\n")
                USERS.clear()
                USERS.update(json.loads(json_part))
                print(f"✅ Loaded {len(USERS)} users")
                return
        print("ℹ️ No users DB yet")
    except Exception as e:
        print(f"⚠️ load_users failed: {e}")

def save_settings():
    global SETTINGS_MSG_ID
    payload = SETTINGS_MSG_MARKER + "\n" + json.dumps(SETTINGS, ensure_ascii=False)
    try:
        if SETTINGS_MSG_ID:
            run(client.edit_message(CHANNEL, SETTINGS_MSG_ID, payload))
        else:
            msg = run(client.send_message(CHANNEL, payload))
            SETTINGS_MSG_ID = msg.id
            run(client.pin_message(CHANNEL, msg.id))
    except Exception as e:
        print(f"⚠️ save_settings failed: {e}")

def load_settings():
    global SETTINGS_MSG_ID
    try:
        msgs = run(client.get_messages(CHANNEL, limit=200))
        for m in msgs:
            if m.message and m.message.startswith(SETTINGS_MSG_MARKER):
                SETTINGS_MSG_ID = m.id
                _, _, json_part = m.message.partition("\n")
                SETTINGS.clear()
                SETTINGS.update(json.loads(json_part))
                print(f"✅ Loaded settings")
                return
        print("ℹ️ No settings — using defaults")
        save_settings()
    except Exception as e:
        print(f"⚠️ load_settings failed: {e}")

def require_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return jsonify({"error": "missing token"}), 401
        sess = SESSIONS.get(auth[7:])
        if not sess:
            return jsonify({"error": "invalid token"}), 401
        user = USERS.get(sess["phone"])
        if not user:
            return jsonify({"error": "user gone"}), 401
        request.user = user
        request.phone = sess["phone"]
        return f(*args, **kwargs)
    return wrapper

def require_admin(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if request.headers.get("X-Admin-Key") != ADMIN_KEY:
            return jsonify({"error": "unauthorized"}), 401
        return f(*args, **kwargs)
    return wrapper

def _user_subscription_state(user):
    if not SETTINGS.get("payments_enabled_globally"):
        return {"status": "free", "locked": False, "days_left": None, "price_etb": 0}
    pay = user.get("payment", {})
    mode = pay.get("mode", "free")
    price = pay.get("price_etb", SETTINGS["default_price_etb"])
    if mode == "free":
        return {"status": "free", "locked": False, "days_left": None, "price_etb": 0}
    until_str = pay.get("until")
    if not until_str:
        return {"status": "none", "locked": True, "days_left": 0, "price_etb": price}
    try:
        until = datetime.fromisoformat(until_str)
    except Exception:
        return {"status": "none", "locked": True, "days_left": 0, "price_etb": price}
    now = datetime.utcnow()
    if until < now:
        return {"status": "expired", "locked": True, "days_left": 0, "price_etb": price, "until": until_str}
    
    days_left = (until - now).days
    return {"status": pay.get("status", "active"), "locked": False, "days_left": days_left, "price_etb": price, "until": until_str}

def _require_active_subscription(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        state = _user_subscription_state(request.user)
        if state["locked"]:
            return jsonify({"error": "subscription_required", "subscription": state, "price_etb": state["price_etb"]}), 402
        return f(*args, **kwargs)
    return wrapper

def get_msg_file_info(msg):
    if not msg: return None
    media = msg.video or msg.document
    if not media: return None
    return {
        "size":     getattr(media, "size", 0) or 0,
        "mime":     getattr(media, "mime_type", None) or "video/mp4",
        "duration": getattr(media, "duration", 0) or 0,
        "thumbs":   getattr(media, "thumbs", None),
    }

@app.route("/")
def health():
    return jsonify({"status": "ok", "app": "D² Ai"})

@app.route("/auth/register", methods=["POST"])
def register():
    data = request.get_json() or {}
    phone = data.get("phone", "").strip()
    password = data.get("password", "")
    name = data.get("name", "").strip()
    device_id = data.get("device_id", "")
    device_name = data.get("device_name", "Unknown")
    if not phone or not password or not device_id:
        return jsonify({"error": "phone, password, device_id required"}), 400
    if phone in USERS:
        return jsonify({"error": "phone already registered"}), 409
    trial_days = SETTINGS.get("default_trial_days", 3)
    USERS[phone] = {
        "phone": phone, "password_hash": hash_password(password), "name": name,
        "device_id": device_id, "device_name": device_name, "is_active": True,
        "created_at": datetime.utcnow().isoformat(), "last_login": None,
        "payment": {
            "mode": "trial", "price_etb": SETTINGS["default_price_etb"],
            "period_days": SETTINGS["default_period_days"], "status": "trial",
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
    phone = data.get("phone", "").strip()
    password = data.get("password", "")
    device_id = data.get("device_id", "")
    device_name = data.get("device_name", "Unknown")
    if not phone or not password or not device_id:
        return jsonify({"error": "phone, password, device_id required"}), 400
    user = USERS.get(phone)
    if not user or user["password_hash"] != hash_password(password):
        return jsonify({"error": "invalid credentials"}), 401
    if not user.get("is_active", True):
        return jsonify({"error": "account disabled"}), 403
    if user.get("device_id") is None:
        user["device_id"] = device_id
        user["device_name"] = device_name
    elif user["device_id"] != device_id:
        return jsonify({"error": "device_not_registered", "message": "Locked to another device.", "registered_device": user.get("device_name", "Unknown")}), 403
    user["last_login"] = datetime.utcnow().isoformat()
    save_users()
    token = make_token()
    SESSIONS[token] = {"phone": phone, "device_id": device_id}
    return jsonify({"token": token, "user": {"phone": phone, "name": user["name"], "device_name": user.get("device_name")}})

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
        "subscription": state,
    })

@app.route("/api/ai/check", methods=["GET"])
@require_auth
@_require_active_subscription
def check_ai_access():
    return jsonify({"allowed": True})

@app.route("/api/subscription/initialize", methods=["POST"])
@require_auth
def subscription_initialize():
    state = _user_subscription_state(request.user)
    if not state["locked"]:
        return jsonify({"error": "already active"}), 400
    import requests as http
    pay = request.user.setdefault("payment", {})
    amount = pay.get("price_etb", SETTINGS["default_price_etb"])
    tx_ref = f"d2ai-{request.phone.replace('+','')}-{secrets.token_hex(6)}"
    payload = {
        "amount": str(amount), "currency": "ETB",
        "email": f"{request.phone.replace('+','')}@d2ai.app",
        "first_name": request.user.get("name") or "User",
        "last_name": request.phone, "phone_number": request.phone,
        "tx_ref": tx_ref,
        "callback_url": f"{APP_BASE_URL}/verify",
        "return_url": f"{APP_BASE_URL}/payment/success?tx_ref={tx_ref}",
        "customization": {"title": "D² Ai Subscription", "description": f"{amount} ETB"},
    }
    r = http.post(f"{CHAPA_BASE_URL}/transaction/initialize", json=payload,
                  headers={"Authorization": f"Bearer {CHAPA_SECRET_KEY}", "Content-Type": "application/json"}, timeout=20)
    if r.status_code not in (200, 201):
        return jsonify({"error": "chapa init failed", "detail": r.text}), 500
    data = r.json()
    pay["pending_tx_ref"] = tx_ref
    save_users()
    return jsonify({"checkout_url": data["data"]["checkout_url"], "tx_ref": tx_ref, "amount": amount})

def _handle_payment_webhook():
    import requests as http
    data = request.get_json() or {}
    tx_ref = data.get("tx_ref") or data.get("trx_ref")
    status = data.get("status")
    if not tx_ref or (status and status != "success"):
        return jsonify({"ok": True, "ignored": True})
    try:
        v = http.get(f"{CHAPA_BASE_URL}/transaction/verify/{tx_ref}",
                     headers={"Authorization": f"Bearer {CHAPA_SECRET_KEY}"}, timeout=15)
        if v.status_code != 200 or v.json().get("data", {}).get("status") != "success":
            return jsonify({"ok": True, "ignored": True})
    except Exception as e:
        print(f"⚠️ Chapa verify error: {e}")
        return jsonify({"ok": True, "ignored": True})
    for phone, user in USERS.items():
        pay = user.get("payment", {})
        if pay.get("pending_tx_ref") == tx_ref:
            now = datetime.utcnow()
            period = pay.get("period_days", 30)
            base = now
            until_str = pay.get("until")
            if until_str:
                try:
                    prev = datetime.fromisoformat(until_str)
                    if prev > now: base = prev
                except Exception: pass
            pay.update({"mode": "paid", "status": "active",
                        "until": (base + timedelta(days=period)).isoformat(),
                        "last_payment_ref": tx_ref, "last_payment_at": now.isoformat(),
                        "pending_tx_ref": None})
            save_users()
            print(f"✅ Payment verified: {phone}")
            break
    return jsonify({"ok": True, "verified": True})

@app.route("/payment/webhook", methods=["POST"])
def payment_webhook():
    return _handle_payment_webhook()

@app.route("/verify", methods=["POST"])
def chapa_verify_alias():
    return _handle_payment_webhook()

@app.route("/payment/success")
def payment_success():
    tx_ref = request.args.get("tx_ref", "")
    return f"""<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0F172A;color:white;">
      <h1>✅ Payment received</h1><p>Ref: <code>{tx_ref}</code></p>
      <p>Return to D² Ai app.</p></body></html>"""

def parse_caption(caption):
    if not caption: return None
    parts = [p.strip() for p in caption.split("|", 3)]
    if len(parts) == 4:
        return {"subject": parts[0], "grade": parts[1], "chapter": parts[2], "topic": parts[3]}
    return {"subject": "General", "grade": "General", "chapter": "Uncategorized", "topic": caption}

def build_structure():
    msgs = run(client.get_messages(CHANNEL, limit=1000))
    grades = {}
    for m in msgs:
        info = get_msg_file_info(m)
        if not info: continue
        if m.message and (m.message.startswith(USERS_MSG_MARKER) or m.message.startswith(SETTINGS_MSG_MARKER)): continue
        meta = parse_caption(m.message or "")
        if not meta: continue
        
        g_name = meta["grade"]
        sbj = meta["subject"]
        
        if g_name not in grades: grades[g_name] = {"grade": g_name, "subjects": {}}
        if sbj not in grades[g_name]["subjects"]: grades[g_name]["subjects"][sbj] = {"subject": sbj, "chapters": {}}
            
        ch = meta["chapter"]
        if ch not in grades[g_name]["subjects"][sbj]["chapters"]: grades[g_name]["subjects"][sbj]["chapters"][ch] = {"chapter": ch, "videos": []}
            
        grades[g_name]["subjects"][sbj]["chapters"][ch]["videos"].append({
            "id": m.id, "tg_msg_id": m.id, "title": meta["topic"],
            "playlist": sbj, "grade": g_name, "chapter": ch, "subject": sbj,
            "duration": info["duration"], "size": info["size"], "mime": info["mime"],
            "stream_url": f"/stream/{m.id}", "download_url": f"/download/{m.id}", "thumb_url": f"/thumb/{m.id}",
        })
        
    result = []
    for g in grades.values():
        g["subjects"] = list(g["subjects"].values())
        for s in g["subjects"]:
            s["chapters"] = list(s["chapters"].values())
            for c in s["chapters"]:
                c["videos"].sort(key=lambda v: v["tg_msg_id"])
        result.append(g)
    return result

@app.route("/api/playlists")
@require_auth
def api_playlists():
    return jsonify([{"title": g["grade"], "subject_count": len(g["subjects"])} for g in build_structure()])

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
    file_size = info["size"]
    mime = info["mime"]
    media = msg.video or msg.document
    range_header = request.headers.get("Range")
    start, end, status = 0, file_size - 1, 200
    if range_header:
        units, _, rng = range_header.partition("=")
        if units.strip() == "bytes":
            s, _, e = rng.partition("-")
            start = int(s) if s else 0
            end = int(e) if e else file_size - 1
            end = min(end, file_size - 1)
            status = 206
    length = end - start + 1
    def generate():
        CHUNK = 4096
        aligned_start = (start // CHUNK) * CHUNK
        skip_bytes = start - aligned_start
        aligned_limit = length + skip_bytes
        buf = io.BytesIO()
        try:
            for chunk in client.iter_download(media, offset=aligned_start, limit=aligned_limit, chunk_size=CHUNK * 64):
                buf.write(chunk)
        except Exception as e: print(f"stream error: {e}"); return
        buf.seek(skip_bytes)
        remaining = length
        while remaining > 0:
            piece = buf.read(min(262144, remaining))
            if not piece: break
            remaining -= len(piece)
            yield piece
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
            for chunk in client.iter_download(media, chunk_size=524288): yield chunk
        except Exception as e: print(f"download error: {e}"); return
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
    except Exception as e: print(f"thumb error: {e}")
    msg = run(client.get_messages(CHANNEL, ids=message_id))
    if not msg or not msg.video or not msg.video.thumbs: return "", 404
    buf = io.BytesIO(); run(client.download_media(msg, file=buf, thumb=-1)); buf.seek(0)
    return Response(buf.read(), mimetype="image/jpeg")

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
  button { background: #3B82F6; color: white; border: 0; padding: 12px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; width: 100%; }
  button:hover { background: #2563EB; }
  button.danger { background: #EF4444; }
  .hint { background: #1E3A8A; padding: 16px; border-radius: 8px; font-size: 14px; color: #BFDBFE; margin-bottom: 20px; line-height: 1.5; }
  .video-row { display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid #334155; font-size: 14px; }
  .video-info b { color: white; font-size: 16px; }
  .video-info span { color: #94A3B8; font-size: 12px; display: block; margin-top: 4px; }
  .badge { background: #334155; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-right: 4px; }
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
      <label>Default Price (ETB)</label><input type="number" id="defPrice" value="100">
      <label>Default Period (Days)</label><input type="number" id="defPeriod" value="30">
      <label>Default Trial (Days)</label><input type="number" id="defTrial" value="3">
      <button onclick="saveSettings()">Save Settings</button>
    </div>

    <div class="card">
      <h2>📤 Upload Instructions</h2>
      <div class="hint">
        <b>Upload via Telegram:</b><br>
        Send video to your channel with caption:<br>
        <code>Subject|Grade|Chapter|Topic</code><br>
        Example: <code>Maths|Grade 10|Algebra|Linear Equations</code><br>
        Reply to the video with a photo to set the thumbnail.
      </div>
      <button onclick="loadVideos()">Refresh Videos</button>
    </div>

    <div class="card">
      <h2>📚 Your Videos</h2>
      <div id="videosList"></div>
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
  $('defPeriod').value = s.default_period_days;
  $('defTrial').value = s.default_trial_days;
  $('panel').style.display = 'block';
  loadVideos();
}

async function saveSettings() {
  await fetch('/admin/settings', {
    method: 'POST',
    headers: { 'X-Admin-Key': key(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      default_price_etb: parseInt($('defPrice').value),
      default_period_days: parseInt($('defPeriod').value),
      default_trial_days: parseInt($('defTrial').value)
    })
  });
  alert('Settings saved!');
}

async function loadVideos() {
  $('videosList').innerHTML = 'Loading...';
  const r = await fetch('/admin/structure', { headers: { 'X-Admin-Key': key() } });
  const grades = await r.json();
  let html = '';
  grades.forEach(g => {
    g.subjects.forEach(s => {
      s.chapters.forEach(c => {
        c.videos.forEach(v => {
          html += `
            <div class="video-row">
              <div class="video-info">
                <b>${v.title}</b>
                <span>${g.grade} → ${s.subject} → ${c.chapter}</span>
              </div>
              <div>
                <button class="danger" style="width:auto; padding:6px 12px;" onclick="delVideo(${v.tg_msg_id})">🗑 Delete</button>
              </div>
            </div>`;
        });
      });
    });
  });
  $('videosList').innerHTML = html || 'No videos found.';
}

async function delVideo(id) {
  if (!confirm('Delete this video?')) return;
  await fetch('/admin/video/' + id, { method: 'DELETE', headers: { 'X-Admin-Key': key() } });
  loadVideos();
}
</script>
</body>
</html>
"""

@app.route("/admin")
def admin_page():
    return render_template_string(ADMIN_HTML)

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
def admin_structure():
    return jsonify(build_structure())

@app.route("/admin/video/<int:msg_id>", methods=["DELETE"])
@require_admin
def admin_delete_video(msg_id):
    run(client.delete_messages(CHANNEL, [msg_id]))
    return jsonify({"ok": True})

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
  button { background: #10b981; color: white; border: none; padding: 15px 30px; font-size: 18px; border-radius: 8px; margin-top: 20px; width: 100%; cursor: pointer; font-weight: bold; }
  button:hover { background: #059669; }
  #status { color: #ef4444; margin-top: 15px; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Subscribe to D² Ai</h1>
    <p>Get unlimited access to all premium videos and the Offline AI Tutor.</p>
    <h2>100 ETB / 30 Days</h2>
    <button onclick="startPayment()">Pay with Chapa</button>
    <p id="status"></p>
  </div>

  <script>
    async function startPayment() {
      const status = document.getElementById('status');
      status.innerText = "Initializing payment...";
      
      const urlParams = new URLSearchParams(window.location.search);
      const token = urlParams.get('token');
      
      if (!token) {
        status.innerText = "Error: No login token found. Please login from the app.";
        return;
      }

      try {
        const res = await fetch('/api/subscription/initialize', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
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

print("🚀 Starting D² Ai Server...")
try:
    async def _start_client():
        await client.start()
        me = await client.get_me()
        print(f"✅ Logged in as: {me.first_name}")
    tg_loop.run_until_complete(_start_client())
    load_users()
    load_settings()
    print("✅ Server ready")
except Exception as e:
    print(f"❌ Startup error: {e}")
    traceback.print_exc()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
