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
    return {"status": pay.get("status", "active"), "locked": False, "days_left": (until - now).days, "price_etb": price, "until": until_str}

def _require_active_subscription(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        state = _user_subscription_state(request.user)
        if state["locked"]:
            return jsonify({"error": "subscription_required", "subscription": state, "price_etb": state["price_etb"]}), 402
        return f(*args, **kwargs)
    return wrapper

def get_msg_file_info(msg):
    """Extract file info safely — works for Video, Document, or hybrid."""
    if not msg:
        return None
    media = msg.video or msg.document
    if not media:
        return None
    return {
        "size":     getattr(media, "size", 0) or 0,
        "mime":     getattr(media, "mime_type", None) or "video/mp4",
        "duration": getattr(media, "duration", 0) or 0,
        "thumbs":   getattr(media, "thumbs", None),
    }

@app.route("/")
def health():
    return jsonify({
        "status": "ok",
        "users_loaded": len(USERS),
        "payments_global": SETTINGS.get("payments_enabled_globally"),
    })

@app.route("/diag")
def diag():
    try:
        me = run(client.get_me())
        return jsonify({"telegram_ok": True, "me_name": me.first_name, "me_id": me.id, "channel_id": CHANNEL, "users_count": len(USERS)})
    except Exception as e:
        return jsonify({"telegram_ok": False, "error": str(e), "traceback": traceback.format_exc()}), 500

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

@app.route("/auth/me")
@require_auth
def me():
    u = request.user
    return jsonify({"phone": u["phone"], "name": u.get("name"), "device_name": u.get("device_name"), "last_login": u.get("last_login")})

@app.route("/auth/logout", methods=["POST"])
@require_auth
def logout():
    SESSIONS.pop(request.headers.get("Authorization", "")[7:], None)
    return jsonify({"ok": True})

@app.route("/api/subscription/status")
@require_auth
def subscription_status():
    state = _user_subscription_state(request.user)
    pay = request.user.get("payment", {})
    return jsonify({
        "payments_enabled_globally": SETTINGS.get("payments_enabled_globally", False),
        "mode": pay.get("mode", "free"),
        "price_etb": state.get("price_etb", 0),
        "period_days": pay.get("period_days", 30),
        "subscription": state,
    })

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
    return f"""<html><body style="font-family:system-ui;text-align:center;padding:60px">
      <h1>✅ Payment received</h1><p>Ref: <code>{tx_ref}</code></p>
      <p>Return to D² Ai app.</p></body></html>"""

def parse_caption(caption):
    if not caption:
        return None
    parts = [p.strip() for p in caption.split("|", 2)]
    if len(parts) == 3:
        return {"playlist": parts[0], "chapter": parts[1], "title": parts[2]}
    return {"playlist": "General", "chapter": "Uncategorized", "title": caption}

def build_structure():
    msgs = run(client.get_messages(CHANNEL, limit=1000))
    playlists = {}
    for m in msgs:
        info = get_msg_file_info(m)
        if not info:
            continue
        if m.message and (m.message.startswith(USERS_MSG_MARKER) or m.message.startswith(SETTINGS_MSG_MARKER)):
            continue
        meta = parse_caption(m.message or "")
        if not meta:
            continue
        pl = meta["playlist"]
        ch = meta["chapter"]
        playlists.setdefault(pl, {"title": pl, "chapters": {}})
        playlists[pl]["chapters"].setdefault(ch, {"title": ch, "videos": []})
        playlists[pl]["chapters"][ch]["videos"].append({
            "id": m.id, "tg_msg_id": m.id, "title": meta["title"],
            "playlist": pl, "chapter": ch,
            "duration": info["duration"], "size": info["size"], "mime": info["mime"],
            "stream_url": f"/stream/{m.id}", "download_url": f"/download/{m.id}", "thumb_url": f"/thumb/{m.id}",
        })
    result = []
    for pl in playlists.values():
        pl["chapters"] = list(pl["chapters"].values())
        for c in pl["chapters"]:
            c["videos"].sort(key=lambda v: v["tg_msg_id"])
        pl["chapter_count"] = len(pl["chapters"])
        result.append(pl)
    return result

@app.route("/api/playlists")
@require_auth
def api_playlists():
    return jsonify([{"title": p["title"], "chapter_count": p["chapter_count"]} for p in build_structure()])

@app.route("/api/playlist/<string:name>")
@require_auth
@_require_active_subscription
def api_playlist(name):
    for p in build_structure():
        if p["title"] == name:
            return jsonify({"title": p["title"], "chapters": [{"title": c["title"], "video_count": len(c["videos"])} for c in p["chapters"]]})
    return jsonify({"error": "not found"}), 404

@app.route("/api/playlist/<string:pl_name>/chapter/<string:ch_name>")
@require_auth
@_require_active_subscription
def api_chapter(pl_name, ch_name):
    for p in build_structure():
        if p["title"] == pl_name:
            for c in p["chapters"]:
                if c["title"] == ch_name:
                    return jsonify({"playlist": pl_name, "chapter": ch_name, "videos": c["videos"]})
    return jsonify({"error": "not found"}), 404

@app.route("/stream/<int:message_id>")
@require_auth
@_require_active_subscription
def stream(message_id):
    msg = run(client.get_messages(CHANNEL, ids=message_id))
    info = get_msg_file_info(msg)
    if not info:
        return "Not found", 404
    file_size = info["size"]
    mime = info["mime"]
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
        buf = io.BytesIO()
        run(client.download_media(msg, file=buf, offset=start, limit=length))
        buf.seek(0)
        chunk = 256 * 1024
        while True:
            data = buf.read(chunk)
            if not data: break
            yield data
    return Response(generate(), status=status, headers={
        "Content-Type": mime, "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Cache-Control": "public, max-age=3600",
    })

@app.route("/download/<int:message_id>")
@require_auth
@_require_active_subscription
def download(message_id):
    msg = run(client.get_messages(CHANNEL, ids=message_id))
    info = get_msg_file_info(msg)
    if not info:
        return "Not found", 404
    def generate():
        buf = io.BytesIO()
        run(client.download_media(msg, file=buf))
        buf.seek(0)
        chunk = 512 * 1024
        while True:
            data = buf.read(chunk)
            if not data: break
            yield data
    return Response(generate(), headers={
        "Content-Type": info["mime"], "Content-Length": str(info["size"]),
        "Content-Disposition": f'attachment; filename="{message_id}.mp4"',
        "Accept-Ranges": "bytes",
    })

@app.route("/thumb/<int:message_id>")
@require_auth
def thumb(message_id):
    msg = run(client.get_messages(CHANNEL, ids=message_id))
    info = get_msg_file_info(msg)
    if not info or not info["thumbs"]:
        return "", 404
    buf = io.BytesIO()
    run(client.download_media(msg, file=buf, thumb=-1))
    buf.seek(0)
    return Response(buf.read(), mimetype="image/jpeg")

@app.route("/admin/users")
@require_admin
def admin_users():
    return jsonify([{
        "phone": u["phone"], "name": u.get("name"), "device_name": u.get("device_name"),
        "is_active": u.get("is_active", True), "last_login": u.get("last_login"),
        "payment": u.get("payment", {}), "state": _user_subscription_state(u),
    } for u in USERS.values()])

@app.route("/admin/user/<phone>/payment", methods=["GET"])
@require_admin
def admin_get_user_payment(phone):
    user = USERS.get(phone)
    if not user:
        return jsonify({"error": "user not found"}), 404
    return jsonify({"phone": phone, "name": user.get("name"), "payment": user.get("payment", {}), "state": _user_subscription_state(user)})

@app.route("/admin/user/<phone>/payment", methods=["POST"])
@require_admin
def admin_update_user_payment(phone):
    user = USERS.get(phone)
    if not user:
        return jsonify({"error": "user not found"}), 404
    data = request.get_json() or {}
    pay = user.setdefault("payment", {})
    if "mode" in data and data["mode"] in ("free", "trial", "paid"): pay["mode"] = data["mode"]
    if "price_etb" in data: pay["price_etb"] = int(data["price_etb"])
    if "period_days" in data: pay["period_days"] = int(data["period_days"])
    if "note" in data: pay["note"] = str(data["note"])
    if "extend_days" in data:
        days = int(data["extend_days"])
        now = datetime.utcnow()
        base = now
        until_str = pay.get("until")
        if until_str:
            try:
                prev = datetime.fromisoformat(until_str)
                if prev > now: base = prev
            except Exception: pass
        pay["until"] = (base + timedelta(days=days)).isoformat()
        pay["status"] = "active"
        pay["mode"] = "paid"
    if data.get("force_expire"):
        pay["until"] = datetime.utcnow().isoformat()
        pay["status"] = "expired"
    save_users()
    return jsonify({"ok": True, "payment": pay, "state": _user_subscription_state(user)})

@app.route("/admin/reset-device/<phone>", methods=["POST"])
@require_admin
def admin_reset_device(phone):
    user = USERS.get(phone)
    if not user: return jsonify({"error": "user not found"}), 404
    user["device_id"] = None
    user["device_name"] = None
    save_users()
    for tok in [t for t, s in SESSIONS.items() if s["phone"] == phone]:
        SESSIONS.pop(tok, None)
    return jsonify({"ok": True})

@app.route("/admin/toggle-user/<phone>", methods=["POST"])
@require_admin
def admin_toggle_user(phone):
    user = USERS.get(phone)
    if not user: return jsonify({"error": "user not found"}), 404
    user["is_active"] = not user.get("is_active", True)
    save_users()
    return jsonify({"ok": True, "is_active": user["is_active"]})

@app.route("/admin/delete-user/<phone>", methods=["POST"])
@require_admin
def admin_delete_user(phone):
    USERS.pop(phone, None)
    save_users()
    return jsonify({"ok": True})

@app.route("/admin/settings", methods=["GET"])
@require_admin
def admin_get_settings():
    return jsonify(SETTINGS)

@app.route("/admin/settings", methods=["POST"])
@require_admin
def admin_update_settings():
    data = request.get_json() or {}
    for k in ["default_price_etb", "default_period_days", "default_trial_days", "payments_enabled_globally"]:
        if k in data: SETTINGS[k] = data[k]
    save_settings()
    return jsonify({"ok": True, "settings": SETTINGS})

@app.route("/admin/structure")
@require_admin
def admin_structure():
    try:
        return jsonify(build_structure())
    except Exception as e:
        err = traceback.format_exc()
        print(f"❌ build_structure error:\n{err}")
        return jsonify({"error": str(e), "traceback": err}), 500

@app.route("/admin/video/<int:msg_id>", methods=["POST"])
@require_admin
def admin_edit_video(msg_id):
    data = request.get_json() or {}
    playlist = (data.get("playlist") or "").strip()
    chapter = (data.get("chapter") or "").strip()
    title = (data.get("title") or "").strip()
    if not playlist or not chapter or not title:
        return jsonify({"error": "playlist, chapter, title required"}), 400
    msg = run(client.get_messages(CHANNEL, ids=msg_id))
    if not get_msg_file_info(msg):
        return jsonify({"error": "video not found"}), 404
    new_caption = f"{playlist}|{chapter}|{title}"
    try:
        run(client.edit_message(CHANNEL, msg_id, new_caption))
    except Exception as e:
        return jsonify({"error": f"edit failed: {e}"}), 500
    return jsonify({"ok": True, "caption": new_caption})

@app.route("/admin/video/<int:msg_id>", methods=["DELETE"])
@require_admin
def admin_delete_video(msg_id):
    try:
        run(client.delete_messages(CHANNEL, [msg_id]))
    except Exception as e:
        return jsonify({"error": f"delete failed: {e}"}), 500
    return jsonify({"ok": True})

ADMIN_HTML = """
<!DOCTYPE html>
<html>
<head>
<title>D² Ai Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui,sans-serif; margin:0; background:#f0f4f8; }
  header { background:#1976d2; color:white; padding:16px; }
  header h1 { margin:0; font-size:20px; }
  .container { max-width:1100px; margin:20px auto; padding:0 16px; }
  .card { background:white; border-radius:12px; padding:20px; box-shadow:0 2px 8px rgba(0,0,0,.08); margin-bottom:20px; }
  .card h2 { margin-top:0; color:#1976d2; font-size:16px; }
  label { display:block; margin:12px 0 4px; font-size:13px; color:#555; }
  input,select { width:100%; padding:10px; border:1px solid #ccc; border-radius:6px; font-size:14px; }
  input[type=checkbox] { width:auto; }
  button { background:#1976d2; color:white; border:0; padding:10px 16px; border-radius:6px; font-size:14px; margin-top:12px; cursor:pointer; }
  button:hover { background:#1565c0; }
  button.danger { background:#d32f2f; }
  button.small { padding:4px 10px; font-size:12px; margin-top:4px; }
  .status { margin-top:12px; font-size:13px; }
  .success { color:#2e7d32; }
  .error { color:#c62828; }
  table { width:100%; border-collapse:collapse; margin-top:12px; }
  th,td { padding:8px; text-align:left; border-bottom:1px solid #eee; font-size:13px; }
  th { background:#f5f5f5; }
  .hint { background:#e3f2fd; padding:12px; border-radius:6px; font-size:13px; margin-bottom:12px; color:#0d47a1; }
  .modal-bg { display:none; position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:100; align-items:center; justify-content:center; }
  .modal { background:white; border-radius:12px; padding:24px; max-width:500px; width:90%; max-height:90vh; overflow-y:auto; }
  .video-row { display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid #eee; font-size:13px; gap:8px; }
  .video-info { flex:1; }
  .badge { display:inline-block; background:#e3f2fd; color:#1976d2; padding:2px 8px; border-radius:10px; font-size:11px; margin-right:4px; }
  .hidden { display:none !important; }
  pre { background:#f5f5f5; padding:8px; border-radius:4px; font-size:11px; overflow-x:auto; white-space:pre-wrap; }
</style>
</head>
<body>
<header><h1>D² Ai — Admin</h1></header>
<div class="container">
  <div class="card">
    <h2>🔑 Admin Key</h2>
    <input type="password" id="adminKey" placeholder="Enter admin key and press Enter">
    <button onclick="loadAll()">Load Panel</button>
    <div class="status" id="keyStatus"></div>
  </div>
  <div id="panel" class="hidden">
    <div class="card">
      <h2>⚙️ Global Settings</h2>
      <label><input type="checkbox" id="paymentsGlobal"> Enable payments globally</label>
      <label>Default Price (ETB)</label><input type="number" id="defPrice" value="100">
      <label>Default Period (days)</label><input type="number" id="defPeriod" value="30">
      <label>Default Trial (days)</label><input type="number" id="defTrial" value="3">
      <button onclick="saveSettings()">Save Settings</button>
      <div class="status" id="settingsStatus"></div>
    </div>
    <div class="card">
      <h2>📤 How to Upload Videos</h2>
      <div class="hint">
        <b>Upload videos directly in Telegram</b>:<br>
        1. Open your Telegram channel<br>
        2. Send video with caption: <code>playlist|chapter|title</code><br>
        3. Example: <code>GRADE 11 MATHS|ALGEBRA|SOLVING</code><br>
        4. Refresh below.
      </div>
    </div>
    <div class="card">
      <h2>📚 Videos Management</h2>
      <button onclick="loadVideos()">Refresh Videos</button>
      <div id="videos" style="margin-top:12px"></div>
    </div>
    <div class="card">
      <h2>👥 Users</h2>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input type="text" id="userSearch" placeholder="🔍 Search..." oninput="filterUsers()">
        <button onclick="loadUsers()" style="margin-top:0">Refresh</button>
        <button onclick="clearSearch()" style="margin-top:0;background:#888">Clear</button>
      </div>
      <div id="userCount" style="font-size:12px;color:#666;margin:8px 0">0 users</div>
      <table id="usersTable">
        <thead><tr><th>Phone</th><th>Name</th><th>Device</th><th>Payment</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>
</div>

<div class="modal-bg" id="editModal"><div class="modal">
  <h3 id="editTitle"></h3>
  <label>Playlist</label><input type="text" id="editPlaylist">
  <label>Chapter</label><input type="text" id="editChapter">
  <label>Video Title</label><input type="text" id="editVideoTitle">
  <div style="display:flex;gap:8px;margin-top:16px">
    <button onclick="saveVideoEdit()">Save</button>
    <button class="danger" onclick="closeEdit()">Cancel</button>
  </div>
  <div class="status" id="editStatus"></div>
</div></div>

<div class="modal-bg" id="payModal"><div class="modal">
  <h3 id="payTitle"></h3>
  <label>Mode</label>
  <select id="payMode"><option value="free">Free</option><option value="trial">Trial</option><option value="paid">Paid</option></select>
  <label>Price (ETB)</label><input type="number" id="payPrice" value="100">
  <label>Period (days)</label><input type="number" id="payPeriod" value="30">
  <label>Extend by (days)</label><input type="number" id="payExtend" value="0">
  <label>Note</label><input type="text" id="payNote">
  <div style="display:flex;gap:8px;margin-top:16px">
    <button onclick="savePayment()">Save</button>
    <button class="danger" onclick="closeModal()">Cancel</button>
    <button class="danger" style="margin-left:auto" onclick="forceExpire()">Expire</button>
  </div>
  <div class="status" id="payStatus"></div>
</div></div>

<script>
const $ = id => document.getElementById(id);
$('adminKey').value = localStorage.getItem('adminKey') || '';
$('adminKey').onchange = () => localStorage.setItem('adminKey', $('adminKey').value);
$('adminKey').onkeydown = (e) => { if (e.key === 'Enter') loadAll(); };
const key = () => $('adminKey').value;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function loadAll() {
  if (!key()) { $('keyStatus').textContent = '❌ Enter key'; $('keyStatus').className='status error'; return; }
  localStorage.setItem('adminKey', key());
  $('keyStatus').textContent = '⏳ Loading…';
  try {
    const r = await fetch('/admin/settings', { headers: { 'X-Admin-Key': key() } });
    if (r.status === 401) {
      $('keyStatus').textContent = '❌ Unauthorized';
      $('keyStatus').className = 'status error';
      $('panel').classList.add('hidden');
      return;
    }
    if (!r.ok) { $('keyStatus').textContent = '❌ Error ' + r.status; return; }
    const s = await r.json();
    $('paymentsGlobal').checked = s.payments_enabled_globally;
    $('defPrice').value = s.default_price_etb;
    $('defPeriod').value = s.default_period_days;
    $('defTrial').value = s.default_trial_days;
    $('keyStatus').textContent = '✅ Loaded';
    $('keyStatus').className = 'status success';
    $('panel').classList.remove('hidden');
    loadVideos();
    loadUsers();
  } catch (e) { $('keyStatus').textContent = '❌ ' + e; }
}

async function saveSettings() {
  const body = {
    payments_enabled_globally: $('paymentsGlobal').checked,
    default_price_etb: parseInt($('defPrice').value),
    default_period_days: parseInt($('defPeriod').value),
    default_trial_days: parseInt($('defTrial').value),
  };
  const r = await fetch('/admin/settings', {
    method: 'POST',
    headers: { 'X-Admin-Key': key(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  $('settingsStatus').textContent = r.ok ? '✅ Saved' : '❌ Failed';
  $('settingsStatus').className = r.ok ? 'status success' : 'status error';
}

async function loadVideos() {
  $('videos').innerHTML = '<i>Loading…</i>';
  try {
    const r = await fetch('/admin/structure', { headers: { 'X-Admin-Key': key() } });
    const text = await r.text();
    if (!r.ok) {
      let errMsg = 'HTTP ' + r.status;
      try { const j = JSON.parse(text); errMsg = j.error || errMsg; } catch(e){}
      $('videos').innerHTML = '<div class="error">❌ ' + escapeHtml(errMsg) + '</div><pre>' + escapeHtml(text.substring(0,800)) + '</pre>';
      return;
    }
    const playlists = JSON.parse(text);
    const videos = [];
    playlists.forEach(p => p.chapters.forEach(c => c.videos.forEach(v => {
      videos.push({...v, playlist: p.title, chapter: c.title});
    })));
    if (videos.length === 0) { $('videos').innerHTML = '<i>No videos yet.</i>'; return; }
    $('videos').innerHTML = videos.map(v => `
      <div class="video-row">
        <div class="video-info">
          <div><span class="badge">#${v.tg_msg_id}</span> <b>${escapeHtml(v.title)}</b></div>
          <div style="color:#666;font-size:12px;margin-top:4px">
            📘 ${escapeHtml(v.playlist)} → 📖 ${escapeHtml(v.chapter)} · ${(v.size/1024/1024).toFixed(1)} MB
          </div>
        </div>
        <div>
          <button class="small" onclick="openEdit(${v.tg_msg_id}, '${escapeHtml(v.playlist)}', '${escapeHtml(v.chapter)}', '${escapeHtml(v.title)}')">✏️</button>
          <button class="small danger" onclick="deleteVideo(${v.tg_msg_id})">🗑</button>
        </div>
      </div>`).join('');
  } catch (e) { $('videos').innerHTML = '<div class="error">❌ ' + escapeHtml(String(e)) + '</div>'; }
}

let editingId = null;
function openEdit(id, pl, ch, ti) {
  editingId = id;
  $('editTitle').textContent = 'Edit Video #' + id;
  $('editPlaylist').value = pl; $('editChapter').value = ch; $('editVideoTitle').value = ti;
  $('editStatus').textContent = '';
  $('editModal').style.display = 'flex';
}
function closeEdit() { $('editModal').style.display = 'none'; editingId = null; }
async function saveVideoEdit() {
  const body = { playlist: $('editPlaylist').value, chapter: $('editChapter').value, title: $('editVideoTitle').value };
  const r = await fetch('/admin/video/' + editingId, { method: 'POST', headers: { 'X-Admin-Key': key(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok) { $('editStatus').textContent = '✅ Saved'; loadVideos(); setTimeout(closeEdit, 700); }
  else { $('editStatus').textContent = '❌ ' + await r.text(); }
}
async function deleteVideo(id) {
  if (!confirm('Delete video #' + id + '?')) return;
  const r = await fetch('/admin/video/' + id, { method: 'DELETE', headers: { 'X-Admin-Key': key() } });
  if (r.ok) loadVideos();
}

let allUsers = [];
async function loadUsers() {
  const r = await fetch('/admin/users', { headers: { 'X-Admin-Key': key() } });
  if (!r.ok) return;
  allUsers = await r.json();
  renderUsers(allUsers);
}
function filterUsers() {
  const q = ($('userSearch').value || '').trim().toLowerCase();
  renderUsers(q ? allUsers.filter(u => (u.phone||'').toLowerCase().includes(q) || (u.name||'').toLowerCase().includes(q) || (u.device_name||'').toLowerCase().includes(q)) : allUsers);
}
function clearSearch() { $('userSearch').value = ''; renderUsers(allUsers); }

function renderUsers(users) {
  $('userCount').textContent = users.length + ' user' + (users.length===1?'':'s');
  if (users.length === 0) { document.querySelector('#usersTable tbody').innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;padding:20px">No users</td></tr>'; return; }
  document.querySelector('#usersTable tbody').innerHTML = users.map(u => {
    const s = u.state || {};
    let badge = '';
    if (s.status === 'free') badge = '<span style="color:green">free</span>';
    else if (s.status === 'trial') badge = `<span style="color:blue">trial · ${s.days_left}d</span>`;
    else if (s.status === 'active') badge = `<span style="color:green">active · ${s.days_left}d</span>`;
    else if (s.status === 'expired') badge = '<span style="color:red">expired</span>';
    else badge = '<span style="color:orange">no sub</span>';
    return `<tr>
      <td>${escapeHtml(u.phone)}</td><td>${escapeHtml(u.name||'-')}</td><td>${escapeHtml(u.device_name||'-')}</td>
      <td>${badge}</td><td>${u.is_active?'✅':'⛔'}</td>
      <td><button class="small" onclick="openPay('${u.phone}')">💳</button>
          <button class="small" onclick="resetDevice('${u.phone}')">📱</button>
          <button class="small danger" onclick="toggleUser('${u.phone}')">${u.is_active?'Dis':'Ena'}</button></td>
    </tr>`;
  }).join('');
}

let currentPhone = null;
async function openPay(phone) {
  currentPhone = phone;
  const r = await fetch('/admin/user/' + phone + '/payment', { headers: { 'X-Admin-Key': key() } });
  const data = await r.json();
  const p = data.payment || {};
  $('payTitle').textContent = 'Payment — ' + phone;
  $('payMode').value = p.mode || 'free';
  $('payPrice').value = p.price_etb || 100;
  $('payPeriod').value = p.period_days || 30;
  $('payExtend').value = 0;
  $('payNote').value = p.note || '';
  $('payStatus').textContent = '';
  $('payModal').style.display = 'flex';
}
function closeModal() { $('payModal').style.display = 'none'; currentPhone = null; }
async function savePayment() {
  const body = { mode: $('payMode').value, price_etb: parseInt($('payPrice').value), period_days: parseInt($('payPeriod').value), note: $('payNote').value };
  const ext = parseInt($('payExtend').value) || 0;
  if (ext > 0) body.extend_days = ext;
  const r = await fetch('/admin/user/' + currentPhone + '/payment', { method: 'POST', headers: { 'X-Admin-Key': key(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  $('payStatus').textContent = r.ok ? '✅ Saved' : '❌ Failed';
  if (r.ok) { loadUsers(); setTimeout(closeModal, 800); }
}
async function forceExpire() {
  if (!confirm('Expire now?')) return;
  await fetch('/admin/user/' + currentPhone + '/payment', { method: 'POST', headers: { 'X-Admin-Key': key(), 'Content-Type': 'application/json' }, body: JSON.stringify({ force_expire: true }) });
  loadUsers();
}
async function resetDevice(phone) {
  if (!confirm('Reset device for ' + phone + '?')) return;
  await fetch('/admin/reset-device/' + phone, { method: 'POST', headers: { 'X-Admin-Key': key() } });
  loadUsers();
}
async function toggleUser(phone) {
  await fetch('/admin/toggle-user/' + phone, { method: 'POST', headers: { 'X-Admin-Key': key() } });
  loadUsers();
}

if (key()) loadAll();
</script>
</body>
</html>
"""

@app.route("/admin")
def admin_page():
    return render_template_string(ADMIN_HTML)

print("🚀 Starting server...")
try:
    async def _start_client():
        await client.start()
        me = await client.get_me()
        print(f"✅ Logged in as: {me.first_name} (ID: {me.id})")
        return me

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
