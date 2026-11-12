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
    "payments_enabled_globally": False,
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
                return
        save_settings()
    except Exception as e:
        print(f"⚠️ load_settings failed: {e}")

def require_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "): return jsonify({"error": "missing token"}), 401
        sess = SESSIONS.get(auth[7:])
        if not sess: return jsonify({"error": "invalid token"}), 401
        user = USERS.get(sess["phone"])
        if not user: return jsonify({"error": "user gone"}), 401
        request.user = user
        request.phone = sess["phone"]
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
    except: return {"status": "none", "locked": True, "days_left": 0, "price_etb": price}
    now = datetime.utcnow()
    if until < now: return {"status": "expired", "locked": True, "days_left": 0, "price_etb": price, "until": until_str}
    return {"status": mode, "locked": False, "days_left": (until - now).days, "price_etb": price, "until": until_str}

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

# --- AUTH ---
@app.route("/auth/register", methods=["POST"])
def register():
    data = request.get_json() or {}
    phone = data.get("phone", "").strip()
    password = data.get("password", "")
    name = data.get("name", "").strip()
    device_id = data.get("device_id", "")
    if not phone or not password or not device_id: return jsonify({"error": "required fields missing"}), 400
    if phone in USERS: return jsonify({"error": "already registered"}), 409
    trial_days = SETTINGS.get("default_trial_days", 3)
    USERS[phone] = {
        "phone": phone, "password_hash": hash_password(password), "name": name,
        "device_id": device_id, "device_name": data.get("device_name", "Unknown"), "is_active": True,
        "created_at": datetime.utcnow().isoformat(), "last_login": None,
        "payment": {"mode": "trial", "price_etb": SETTINGS["default_price_etb"], "period_days": SETTINGS["default_period_days"], "status": "trial", "until": (datetime.utcnow() + timedelta(days=trial_days)).isoformat()},
    }
    save_users()
    token = make_token()
    SESSIONS[token] = {"phone": phone, "device_id": device_id}
    return jsonify({"token": token, "user": {"phone": phone, "name": name}})

@app.route("/auth/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    phone = data.get("phone", "").strip()
    user = USERS.get(phone)
    if not user or user["password_hash"] != hash_password(data.get("password", "")): return jsonify({"error": "invalid credentials"}), 401
    if user["device_id"] != data.get("device_id"): return jsonify({"error": "locked to another device"}), 403
    user["last_login"] = datetime.utcnow().isoformat()
    save_users()
    token = make_token()
    SESSIONS[token] = {"phone": phone, "device_id": user["device_id"]}
    return jsonify({"token": token, "user": {"phone": phone, "name": user["name"]}})

# --- SUBSCRIPTION & AI PAYWALL ---
@app.route("/api/subscription/status")
@require_auth
def subscription_status():
    state = _user_subscription_state(request.user)
    return jsonify({"status": state["status"], "price_etb": state["price_etb"], "days_left": state["days_left"], "until": state.get("until")})

@app.route("/api/ai/check")
@require_auth
@_require_active_subscription
def check_ai_access():
    return jsonify({"allowed": True})

# --- CONTENT ---
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
        if not info or (m.message and m.message.startswith(("D2AI_USERS", "D2AI_SETTINGS"))): continue
        meta = parse_caption(m.message or "")
        if not meta: continue
        g, s, c = meta["grade"], meta["subject"], meta["chapter"]
        grades.setdefault(g, {"grade": g, "subjects": {}})
        grades[g]["subjects"].setdefault(s, {"subject": s, "chapters": {}})
        grades[g]["subjects"][s]["chapters"].setdefault(c, {"chapter": c, "videos": []})
        grades[g]["subjects"][s]["chapters"][c]["videos"].append({
            "id": m.id, "title": meta["topic"], "subject": s, "grade": g, "chapter": c,
            "thumb_url": f"/thumb/{m.id}", "stream_url": f"/stream/{m.id}", "download_url": f"/download/{m.id}"
        })
    result = []
    for g in grades.values():
        g["subjects"] = list(g["subjects"].values())
        for s in g["subjects"]:
            s["chapters"] = list(s["chapters"].values())
            for c in s["chapters"]: c["videos"].sort(key=lambda v: v["id"])
        result.append(g)
    return result

@app.route("/api/playlists")
@require_auth
def api_playlists():
    return jsonify([{"title": g["grade"]} for g in build_structure()])

@app.route("/api/grade/<string:grade_name>")
@require_auth
def api_grade(grade_name):
    for g in build_structure():
        if g["grade"] == grade_name: return jsonify(g)
    return jsonify({"error": "not found"}), 404

# --- STREAMING & DOWNLOADS ---
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
            for chunk in client.iter_download(media, offset=aligned_start, limit=aligned_limit, chunk_size=CHUNK * 64): buf.write(chunk)
        except: return
        buf.seek(skip_bytes)
        remaining = length
        while remaining > 0:
            piece = buf.read(min(262144, remaining))
            if not piece: break
            remaining -= len(piece)
            yield piece
    return Response(generate(), status=status, headers={"Content-Type": mime, "Accept-Ranges": "bytes", "Content-Length": str(length), "Content-Range": f"bytes {start}-{end}/{file_size}"})

@app.route("/download/<int:message_id>")
@require_auth
def download(message_id):
    msg = run(client.get_messages(CHANNEL, ids=message_id))
    if not msg: return "Not found", 404
    media = msg.video or msg.document
    if not media: return "Not a video", 404
    def generate():
        try:
            for chunk in client.iter_download(media, chunk_size=524288): yield chunk
        except: return
    return Response(generate(), headers={"Content-Type": media.mime_type or "video/mp4", "Content-Length": str(media.size), "Content-Disposition": f'attachment; filename="{message_id}.mp4"'})

@app.route("/thumb/<int:message_id>")
@require_auth
def thumb(message_id):
    try:
        msgs = run(client.get_messages(CHANNEL, limit=500))
        for m in msgs:
            if (m.photo and m.reply_to and getattr(m.reply_to, 'reply_to_msg_id', None) == message_id):
                buf = io.BytesIO(); run(client.download_media(m, file=buf)); buf.seek(0)
                return Response(buf.read(), mimetype="image/jpeg")
    except: pass
    msg = run(client.get_messages(CHANNEL, ids=message_id))
    if not msg or not msg.video or not msg.video.thumbs: return "", 404
    buf = io.BytesIO(); run(client.download_media(msg, file=buf, thumb=-1)); buf.seek(0)
    return Response(buf.read(), mimetype="image/jpeg")

# --- PAYMENT GATEWAY ---
@app.route("/api/subscription/initialize", methods=["POST"])
@require_auth
def subscription_initialize():
    import requests as http
    state = _user_subscription_state(request.user)
    if not state["locked"]: return jsonify({"error": "already active"}), 400
    pay = request.user.setdefault("payment", {})
    amount = pay.get("price_etb", SETTINGS["default_price_etb"])
    tx_ref = f"d2ai-{request.phone.replace('+','')}-{secrets.token_hex(6)}"
    payload = {
        "amount": str(amount), "currency": "ETB", "email": f"{request.phone.replace('+','')}@d2ai.app",
        "first_name": request.user.get("name") or "User", "last_name": request.phone, "phone_number": request.phone,
        "tx_ref": tx_ref, "callback_url": f"{APP_BASE_URL}/verify", "return_url": f"{APP_BASE_URL}/payment/success?tx_ref={tx_ref}",
    }
    r = http.post(f"{CHAPA_BASE_URL}/transaction/initialize", json=payload, headers={"Authorization": f"Bearer {CHAPA_SECRET_KEY}"}, timeout=20)
    if r.status_code not in (200, 201): return jsonify({"error": "chapa init failed"}), 500
    pay["pending_tx_ref"] = tx_ref
    save_users()
    return jsonify({"checkout_url": r.json()["data"]["checkout_url"], "tx_ref": tx_ref})

@app.route("/verify", methods=["POST"])
def chapa_verify():
    import requests as http
    data = request.get_json() or {}
    tx_ref = data.get("tx_ref")
    if not tx_ref: return jsonify({"ok": True})
    v = http.get(f"{CHAPA_BASE_URL}/transaction/verify/{tx_ref}", headers={"Authorization": f"Bearer {CHAPA_SECRET_KEY}"})
    if v.status_code == 200 and v.json().get("data", {}).get("status") == "success":
        for phone, user in USERS.items():
            if user.get("payment", {}).get("pending_tx_ref") == tx_ref:
                now = datetime.utcnow()
                user["payment"].update({"mode": "paid", "status": "active", "until": (now + timedelta(days=30)).isoformat(), "pending_tx_ref": None})
                save_users()
                break
    return jsonify({"ok": True})

# --- ADMIN & PAYMENT HTML ---
ADMIN_HTML = """<!DOCTYPE html><html><head><title>Admin</title></head><body><h1>Admin Panel</h1><p>Use the app to check users. Web panel coming soon.</p></body></html>"""

@app.route("/admin")
def admin_page(): return render_template_string(ADMIN_HTML)

@app.route("/payment")
def payment_page():
    token = request.args.get("token", "")
    return f"""<html><body style="text-align:center;padding:50px;font-family:sans-serif;">
    <h1>D² AI SUBSCRIPTION</h1><p>Click below to pay securely via Chapa.</p>
    <button onclick="pay()" style="padding:15px 30px;font-size:18px;background:#00E5FF;border:none;border-radius:8px;font-weight:bold;">PAY NOW</button>
    <script>
    async function pay() {{
        const res = await fetch('/api/subscription/initialize', {{method:'POST', headers:{{'Authorization':'Bearer {token}'}}}});
        const data = await res.json();
        if (data.checkout_url) window.location.href = data.checkout_url;
        else alert('Error: ' + data.error);
    }}
    </script></body></html>"""

if __name__ == "__main__":
    async def start():
        await client.start()
        print("✅ Server Ready")
    tg_loop.run_until_complete(start())
    load_users(); load_settings()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
