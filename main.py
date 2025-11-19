import os
import uuid
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, Request, UploadFile, File, Form, Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from sqlalchemy import (
    create_engine,
    Column,
    Integer,
    String,
    Boolean,
    DateTime,
    ForeignKey,
    and_,
    or_,
)
from sqlalchemy.orm import sessionmaker, declarative_base, Session as DBSession

# ---------------------- CONFIG ---------------------- #

DATABASE_URL = "sqlite:///./app.db"
UPLOAD_DIR = "uploads"

os.makedirs(UPLOAD_DIR, exist_ok=True)

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------- MODELS ---------------------- #

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    tg_id = Column(String, unique=True, index=True)

    display_name = Column(String)
    age = Column(Integer)
    city = Column(String)
    gender = Column(String)          # male / female / other
    looking_for = Column(String)     # all / male / female

    bio = Column(String)
    interests = Column(String)       # comma separated

    photo = Column(String, nullable=True)

    is_premium = Column(Boolean, default=False)
    invisible_mode = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.utcnow)
    last_active = Column(DateTime, default=datetime.utcnow)


class Like(Base):
    __tablename__ = "likes"

    id = Column(Integer, primary_key=True)
    from_user = Column(Integer, ForeignKey("users.id"))
    to_user = Column(Integer, ForeignKey("users.id"))

    is_match = Column(Boolean, default=False)
    is_superlike = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.utcnow)


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True)
    from_user = Column(Integer, ForeignKey("users.id"))
    to_user = Column(Integer, ForeignKey("users.id"))

    body = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    is_read = Column(Boolean, default=False)


Base.metadata.create_all(engine)


# ---------------------- HELPERS ---------------------- #

def get_or_create_user_by_tg(tg_id: str, name: Optional[str], username: Optional[str], db: DBSession) -> User:
    user = db.query(User).filter(User.tg_id == tg_id).first()
    if user:
        user.last_active = datetime.utcnow()
        db.commit()
        return user

    display_name = name or username or f"User {tg_id}"

    user = User(
        tg_id=tg_id,
        display_name=display_name,
        looking_for="all",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def bool_from_str(val: Optional[str]) -> Optional[bool]:
    if val is None:
        return None
    v = str(val).lower()
    if v in ["1", "true", "yes", "on"]:
        return True
    if v in ["0", "false", "no", "off"]:
        return False
    return None


# ---------------------- APP INIT ---------------------- #

app = FastAPI()

templates = Jinja2Templates(directory="templates")

app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")


# ---------------------- ROUTES ---------------------- #

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


# ---------- AUTH by Telegram WebApp ----------- #

@app.post("/api/tg-login")
def tg_login(
    tg_id: str = Form(...),
    name: Optional[str] = Form(None),
    username: Optional[str] = Form(None),
    db: DBSession = Depends(get_db),
):
    """
    Простий логін: приймаємо tg_id з WebApp (без криптоперевірки).
    У проді треба валідувати хеш.
    """
    user = get_or_create_user_by_tg(tg_id, name, username, db)
    return {
        "ok": True,
        "user": {
            "id": user.id,
            "tg_id": user.tg_id,
            "display_name": user.display_name,
            "is_premium": user.is_premium,
            "invisible_mode": user.invisible_mode,
        },
    }


# ---------- PROFILE ---------- #

@app.get("/api/me")
def api_me(tg_id: str, db: DBSession = Depends(get_db)):
    user = db.query(User).filter(User.tg_id == tg_id).first()
    if not user:
        raise HTTPException(404, "User not found")

    return {
        "id": user.id,
        "tg_id": user.tg_id,
        "display_name": user.display_name,
        "age": user.age,
        "gender": user.gender,
        "looking_for": user.looking_for,
        "city": user.city,
        "bio": user.bio,
        "interests": user.interests,
        "photo": user.photo,
        "is_premium": user.is_premium,
        "invisible_mode": user.invisible_mode,
        "last_active": user.last_active.isoformat() if user.last_active else None,
    }


@app.post("/api/me/update")
def api_me_update(
    tg_id: str,
    display_name: Optional[str] = Form(None),
    age: Optional[int] = Form(None),
    city: Optional[str] = Form(None),
    gender: Optional[str] = Form(None),
    looking_for: Optional[str] = Form(None),
    bio: Optional[str] = Form(None),
    interests: Optional[str] = Form(None),
    invisible_mode: Optional[str] = Form(None),   # "true"/"false"
    file: UploadFile = File(None),
    db: DBSession = Depends(get_db),
):
    user = db.query(User).filter(User.tg_id == tg_id).first()
    if not user:
        raise HTTPException(404, "User not found")

    if display_name is not None:
        user.display_name = display_name.strip() or user.display_name
    if age is not None:
        user.age = age
    if city is not None:
        user.city = city.strip() or None
    if gender is not None:
        user.gender = gender or None
    if looking_for is not None:
        user.looking_for = looking_for or "all"
    if bio is not None:
        user.bio = bio.strip() or None
    if interests is not None:
        user.interests = interests.strip() or None

    b = bool_from_str(invisible_mode)
    if b is not None:
        user.invisible_mode = b

    if file:
        ext = (file.filename or "jpg").split(".")[-1]
        filename = f"{uuid.uuid4()}.{ext}"
        path = os.path.join(UPLOAD_DIR, filename)
        with open(path, "wb") as f:
            f.write(file.file.read())
        user.photo = f"/uploads/{filename}"

    user.last_active = datetime.utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)

    return {"ok": True}


# ---------- PREMIUM (для демо: простий toggle) ---------- #

@app.post("/api/premium/set")
def api_premium_set(
    tg_id: str,
    value: str = Form(...),
    db: DBSession = Depends(get_db),
):
    user = db.query(User).filter(User.tg_id == tg_id).first()
    if not user:
        raise HTTPException(404, "User not found")

    b = bool_from_str(value)
    if b is None:
        raise HTTPException(400, "Bad value")

    user.is_premium = b
    db.add(user)
    db.commit()
    return {"ok": True, "is_premium": user.is_premium}


# ---------- SEARCH & SWIPE DECK ---------- #

@app.get("/api/search")
def api_search(
    tg_id: str,
    gender: Optional[str] = None,
    city: Optional[str] = None,
    db: DBSession = Depends(get_db),
):
    me = db.query(User).filter(User.tg_id == tg_id).first()
    if not me:
        raise HTTPException(404, "User not found")

    q = db.query(User).filter(User.id != me.id)

    # невидимі не зʼявляються в деку
    q = q.filter(User.invisible_mode == False)

    if gender and gender != "all":
        q = q.filter(User.gender == gender)

    if city:
        c = city.strip()
        if c:
            q = q.filter(User.city.ilike(f"%{c}%"))

    users = q.order_by(User.created_at.desc()).all()

    results = []
    for u in users:
        # чи вже лайкнув мене / я його
        liked_me = db.query(Like).filter(
            Like.from_user == u.id,
            Like.to_user == me.id
        ).first() is not None

        my_like = db.query(Like).filter(
            Like.from_user == me.id,
            Like.to_user == u.id
        ).first()

        is_match = bool(my_like and my_like.is_match)

        results.append({
            "id": u.id,
            "display_name": u.display_name,
            "age": u.age,
            "city": u.city,
            "gender": u.gender,
            "bio": u.bio,
            "interests": u.interests,
            "photo": u.photo,
            "liked_me": liked_me,
            "liked_by_me": my_like is not None,
            "is_match": is_match,
        })

    return {"users": results}


# ---------- LIKE / SUPERLIKE / MATCHES ---------- #

@app.post("/api/like")
def api_like(
    tg_id: str,
    target_id: int = Form(...),
    db: DBSession = Depends(get_db),
):
    me = db.query(User).filter(User.tg_id == tg_id).first()
    if not me:
        raise HTTPException(404, "User not found")
    if me.id == target_id:
        raise HTTPException(400, "Cannot like yourself")

    existing = db.query(Like).filter(
        Like.from_user == me.id,
        Like.to_user == target_id,
    ).first()

    if existing:
        return {"ok": True, "already": True, "is_match": existing.is_match}

    like = Like(from_user=me.id, to_user=target_id, is_superlike=False)
    db.add(like)

    reverse = db.query(Like).filter(
        Like.from_user == target_id,
        Like.to_user == me.id,
    ).first()

    is_match = False
    if reverse:
        like.is_match = True
        reverse.is_match = True
        db.add(reverse)
        is_match = True

    db.commit()

    return {"ok": True, "is_match": is_match}


@app.post("/api/superlike")
def api_superlike(
    tg_id: str,
    target_id: int = Form(...),
    db: DBSession = Depends(get_db),
):
    me = db.query(User).filter(User.tg_id == tg_id).first()
    if not me:
        raise HTTPException(404, "User not found")
    if me.id == target_id:
        raise HTTPException(400, "Cannot superlike yourself")

    # Non-premium можуть мати 0 суперлайків — тут можеш прикрутити ліміти
    # Для демо дозволяємо всім

    existing = db.query(Like).filter(
        Like.from_user == me.id,
        Like.to_user == target_id,
    ).first()

    if existing:
        existing.is_superlike = True
        existing.is_match = True
        db.add(existing)
    else:
        like = Like(from_user=me.id, to_user=target_id, is_superlike=True, is_match=True)
        db.add(like)

    db.commit()
    return {"ok": True, "is_match": True, "superlike": True}


@app.get("/api/matches")
def api_matches(
    tg_id: str,
    db: DBSession = Depends(get_db),
):
    me = db.query(User).filter(User.tg_id == tg_id).first()
    if not me:
        raise HTTPException(404, "User not found")

    likes = db.query(Like).filter(
        or_(
            Like.from_user == me.id,
            Like.to_user == me.id,
        )
    ).filter(
        or_(
            Like.is_match == True,
            Like.is_superlike == True,
        )
    ).all()

    partner_ids = set()
    for l in likes:
        if l.from_user == me.id:
            partner_ids.add(l.to_user)
        else:
            partner_ids.add(l.from_user)

    users = db.query(User).filter(User.id.in_(partner_ids)).all()

    res = []
    for u in users:
        res.append({
            "id": u.id,
            "display_name": u.display_name,
            "city": u.city,
            "photo": u.photo,
            "last_active": u.last_active.isoformat() if u.last_active else None,
        })

    return {"matches": res}


# ---------- CHAT ---------- #

@app.get("/api/messages")
def api_messages(
    tg_id: str,
    partner_id: int,
    db: DBSession = Depends(get_db),
):
    me = db.query(User).filter(User.tg_id == tg_id).first()
    if not me:
        raise HTTPException(404, "User not found")

    # дозволяємо чат, якщо є:
    # 1) match
    # 2) суперлайк від мене (я преміум) — реалізовано через is_superlike True
    like_rel = db.query(Like).filter(
        or_(
            and_(Like.from_user == me.id, Like.to_user == partner_id),
            and_(Like.from_user == partner_id, Like.to_user == me.id),
        )
    ).filter(
        or_(
            Like.is_match == True,
            Like.is_superlike == True,
        )
    ).first()

    if not like_rel:
        raise HTTPException(403, "No chat permission")

    msgs = db.query(Message).filter(
        or_(
            and_(Message.from_user == me.id, Message.to_user == partner_id),
            and_(Message.from_user == partner_id, Message.to_user == me.id),
        )
    ).order_by(Message.created_at.asc()).all()

    result = []
    for m in msgs:
        result.append({
            "id": m.id,
            "body": m.body,
            "is_me": m.from_user == me.id,
            "time": m.created_at.isoformat(),
        })

    return {"messages": result}


@app.post("/api/messages/send")
def api_messages_send(
    tg_id: str,
    partner_id: int = Form(...),
    body: str = Form(...),
    db: DBSession = Depends(get_db),
):
    me = db.query(User).filter(User.tg_id == tg_id).first()
    if not me:
        raise HTTPException(404, "User not found")

    body = body.strip()
    if not body:
        raise HTTPException(400, "Empty message")

    like_rel = db.query(Like).filter(
        or_(
            and_(Like.from_user == me.id, Like.to_user == partner_id),
            and_(Like.from_user == partner_id, Like.to_user == me.id),
        )
    ).filter(
        or_(
            Like.is_match == True,
            Like.is_superlike == True,
        )
    ).first()

    if not like_rel:
        raise HTTPException(403, "No chat permission")

    msg = Message(from_user=me.id, to_user=partner_id, body=body)
    db.add(msg)
    db.commit()

    return {"ok": True}