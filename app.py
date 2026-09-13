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
        print("ℹ️ No users DB yet — fresh start")
    except Exception as e:
        print(f"⚠️ load_users failed: {e}")
        traceback.print_exc()

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
                print(f"✅ Loaded settings: {SETTINGS}")
                return
        print("ℹ️ No settings — using defaults")
        save_settings()
    except Exception as e:
        print(f"⚠️ load_settings failed: {e}")
        traceback.print_exc()

def require_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return jsonify({"error": "missing token"}), 401
        token = auth[7:]
        sess = SESSIONS.get(token)
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
        return {"status": "expired", "locked": True, "days_left": 0,
                "price_etb": price, "until": until_str}

    days = (until - now).days
    return {"status": pay.get("status", "active"), "locked": False,
            "days_left": days, "price_etb": price, "until": until_str}

def _require_active_subscription(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        state = _user_subscription_state(request.user)
        if state["locked"]:
            return jsonify({
                "error": "subscription_required",
                "subscription": state,
                "price_etb": state["price_etb"],
            }), 402
        return f(*args, **kwargs)
    return wrapper
@app.route("/")
def health():
    return jsonify({
        "status": "ok",
        "users_loaded": len(USERS),
        "payments_global": SETTINGS.get("payments_enabled_globally"),
        "telegram_connected": client.is_connected() if hasattr(client, "is_connected") else None,
    })

@app.route("/diag")
def diag():
    try:
        me = run(client.get_me())
        return jsonify({
            "telegram_ok": True,
            "me_name": me.first_name,
            "me_id": me.id,
            "channel_id": CHANNEL,
            "users_count": len(USERS),
        })
    except Exception as e:
        return jsonify({"telegram_ok": False, "error": str(e), "traceback": traceback.format_exc()}), 500

@app.route("/auth/register", methods=["POST"])
def register():
    data = request.get_json() or {}
    phone       = data.get("phone", "").strip()
    password    = data.get("password", "")
    name        = data.get("name", "").strip()
    device_id   = data.get("device_id", "")
    device_name = data.get("device_name", "Unknown")

    if not phone or not password or not device_id:
        return jsonify({"error": "phone, password, device_id required"}), 400
    if phone in USERS:
        return jsonify({"error": "phone already registered"}), 409

    trial_days = SETTINGS.get("default_trial_days", 3)
    USERS[phone] = {
        "phone": phone,
        "password_hash": hash_password(password),
        "name": name,
        "device_id": device_id,
        "device_name": device_name,
        "is_active": True,
        "created_at": datetime.utcnow().isoformat(),
        "last_login": None,
        "payment": {
            "mode": "trial",
            "price_etb": SETTINGS["default_price_etb"],
            "period_days": SETTINGS["default_period_days"],
            "status": "trial",
            "until": (datetime.utcnow() + timedelta(days=trial_days)).isoformat(),
            "note": "",
            "last_payment_at": None,
            "last_payment_ref": None,
            "pending_tx_ref": None,
        },
    }
    save_users()
    token = make_token()
    SESSIONS[token] = {"phone": phone, "device_id": device_id}
    return jsonify({"token": token, "user": {"phone": phone, "name": name}})

@app.route("/auth/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    phone       = data.get("phone", "").strip()
    password    = data.get("password", "")
    device_id   = data.get("device_id", "")
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
        return jsonify({
            "error": "device_not_registered",
            "message": "This account is locked to another device. Contact admin.",
            "registered_device": user.get("device_name", "Unknown"),
        }), 403

    user["last_login"] = datetime.utcnow().isoformat()
    save_users()
    token = make_token()
    SESSIONS[token] = {"phone": phone, "device_id": device_id}
    return jsonify({
        "token": token,
        "user": {
            "phone": phone,
            "name": user["name"],
            "device_name": user.get("device_name"),
        },
    })

@app.route("/auth/me")
@require_auth
def me():
    u = request.user
    return jsonify({
        "phone": u["phone"],
        "name": u.get("name"),
        "device_name": u.get("device_name"),
        "last_login": u.get("last_login"),
    })

@app.route("/auth/logout", methods=["POST"])
@require_auth
def logout():
    token = request.headers.get("Authorization", "")[7:]
    SESSIONS.pop(token, None)
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
        "amount": str(amount),
        "currency": "ETB",
        "email": f"{request.phone.replace('+','')}@d2ai.app",
        "first_name": request.user.get("name") or "User",
        "last_name": request.phone,
        "phone_number": request.phone,
        "tx_ref": tx_ref,
        "callback_url": f"{APP_BASE_URL}/verify",
        "return_url": f"{APP_BASE_URL}/payment/success?tx_ref={tx_ref}",
        "customization": {
            "title": "D² Ai Subscription",
            "description": f"Access for {pay.get('period_days', 30)} days — {amount} ETB",
        },
    }

    r = http.post(
        f"{CHAPA_BASE_URL}/transaction/initialize",
        json=payload,
        headers={"Authorization": f"Bearer {CHAPA_SECRET_KEY}", "Content-Type": "application/json"},
        timeout=20,
    )
    if r.status_code not in (200, 201):
        return jsonify({"error": "chapa init failed", "detail": r.text}), 500

    data = r.json()
    pay["pending_tx_ref"] = tx_ref
    pay["pending_amount"] = amount
    save_users()
    return jsonify({"checkout_url": data["data"]["checkout_url"], "tx_ref": tx_ref, "amount": amount})

def _handle_payment_webhook():
    import requests as http
    data = request.get_json() or {}
    tx_ref = data.get("tx_ref") or data.get("trx_ref")
    status = data.get("status")
    if not tx_ref:
        return jsonify({"ok": True, "ignored": True})
    if status and status != "success":
        return jsonify({"ok": True, "ignored": True})

    try:
        v = http.get(
            f"{CHAPA_BASE_URL}/transaction/verify/{tx_ref}",
            headers={"Authorization": f"Bearer {CHAPA_SECRET_KEY}"},
            timeout=15,
        )
        if v.status_code != 200:
            return jsonify({"ok": True, "ignored": True})
        verified = v.json().get("data", {})
        if verified.get("status") != "success":
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
                    if prev > now:
                        base = prev
                except Exception:
                    pass
            pay["mode"] = "paid"
            pay["status"] = "active"
            pay["until"] = (base + timedelta(days=period)).isoformat()
            pay["last_payment_ref"] = tx_ref
            pay["last_payment_at"] = now.isoformat()
            pay["pending_tx_ref"] = None
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
      <h1>✅ Payment received</h1>
      <p>Reference: <code>{tx_ref}</code></p>
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
        if not m.video:
            continue
        if m.message and (m.message.startswith(USERS_MSG_MARKER)
                          or m.message.startswith(SETTINGS_MSG_MARKER)):
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
            "duration": m.video.duration or 0,
            "size": m.video.size or 0,
            "stream_url": f"/stream/{m.id}",
            "download_url": f"/download/{m.id}",
            "thumb_url": f"/thumb/{m.id}",
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
            return jsonify({
                "title": p["title"],
                "chapters": [{"title": c["title"], "video_count": len(c["videos"])} for c in p["chapters"]],
            })
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
    if not msg or not msg.video:
        return "Not found", 404
    file_size = msg.video.size
    mime = msg.video.mime_type or "video/mp4"
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
            if not data:
                break
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
    if not msg or not msg.video:
        return "Not found", 404
    file_size = msg.video.size
    mime = msg.video.mime_type or "video/mp4"
    def generate():
        buf = io.BytesIO()
        run(client.download_media(msg, file=buf))
        buf.seek(0)
        chunk = 512 * 1024
        while True:
            data = buf.read(chunk)
            if not data:
                break
            yield data
    return Response(generate(), headers={
        "Content-Type": mime, "Content-Length": str(file_size),
        "Content-Disposition": f'attachment; filename="{message_id}.mp4"',
        "Accept-Ranges": "bytes",
    })

@app.route("/thumb/<int:message_id>")
@require_auth
def thumb(message_id):
    msg = run(client.get_messages(CHANNEL, ids=message_id))
    if not msg or not msg.video or not msg.video.thumbs:
        return "", 404
    buf = io.BytesIO()
    run(client.download_media(msg, file=buf, thumb=-1))
    buf.seek(0)
    return Response(buf.read(), mimetype="image/jpeg")

@app.route("/admin/users")
@require_admin
def admin_users():
    out = []
    for u in USERS.values():
        out.append({
            "phone": u["phone"], "name": u.get("name"),
            "device_name": u.get("device_name"),
            "is_active": u.get("is_active", True),
            "last_login": u.get("last_login"),
            "payment": u.get("payment", {}),
            "state": _user_subscription_state(u),
        })
    return jsonify(out)

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
    if "mode" in data and data["mode"] in ("free", "trial", "paid"):
        pay["mode"] = data["mode"]
    if "price_etb" in data:
        pay["price_etb"] = int(data["price_etb"])
    if "period_days" in data:
        pay["period_days"] = int(data["period_days"])
    if "note" in data:
        pay["note"] = str(data["note"])
    if "extend_days" in data:
        days = int(data["extend_days"])
        now = datetime.utcnow()
        base = now
        until_str = pay.get("until")
        if until_str:
            try:
                prev = datetime.fromisoformat(until_str)
                if prev > now:
                    base = prev
            except Exception:
                pass
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
    if not user:
        return jsonify({"error": "user not found"}), 404
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
    if not user:
        return jsonify({"error": "user not found"}), 404
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
        if k in data:
            SETTINGS[k] = data[k]
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
    if not msg or not msg.video:
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
