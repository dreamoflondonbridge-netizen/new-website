"""Dependency-free, server-authoritative classroom game."""
import csv
import hashlib
import hmac
import io
import json
import os
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("GAME_DATA_DIR", ROOT / "data"))
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / "game.sqlite3"
LOCK = threading.RLock()
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
LOGIN_FAILURES = {}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect():
    db = sqlite3.connect(DB, timeout=20)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=20000")
    return db


def init():
    with connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS content(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS students(id INTEGER PRIMARY KEY AUTOINCREMENT, class_name TEXT NOT NULL, student_no INTEGER NOT NULL, nickname TEXT NOT NULL, recovery_hash TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(class_name,student_no));
        CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, student_id INTEGER, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS requests(student_id INTEGER NOT NULL, request_id TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(student_id,request_id));
        CREATE TABLE IF NOT EXISTS finals(id INTEGER PRIMARY KEY AUTOINCREMENT, content_id INTEGER NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS final_entries(student_id INTEGER NOT NULL, final_id INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, first_correct INTEGER, complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(student_id,final_id));
        CREATE TABLE IF NOT EXISTS awards(kind TEXT PRIMARY KEY, student_id INTEGER, note TEXT NOT NULL DEFAULT '');
        """)
        if not db.execute("SELECT 1 FROM content LIMIT 1").fetchone():
            db.execute("INSERT INTO content(body,created) VALUES(?,?)", (json.dumps(default_content(), ensure_ascii=False), now()))


def default_content():
    stories = [
        ("우리 학교 급식, 얼마나 남길까?", "급식 잔반을 줄이기 위해 월별 잔반량 변화와 실천 효과를 살펴보자.", "월별 잔반량이 줄어드는 추세를 보여 주는 자료", "월별 변화가 한눈에 보여 실천 효과를 비교할 수 있다", ["잔반량(kg) 3월 120, 4월 95, 5월 68", "급식실 입구 사진", "오늘의 메뉴 표", "음식 캐릭터 그림"]),
        ("스마트폰과 수면 시간", "우리 반의 스마트폰 사용 시간과 평균 수면 시간을 조사했다. 두 값의 관계를 설명하려 한다.", "사용 시간에 따른 수면 시간 비교 자료", "사용 시간과 수면 시간의 관계를 비교할 수 있다", ["1시간 이하 8시간, 2~3시간 7시간, 4시간 이상 6시간", "휴대전화 광고 사진", "앱 아이콘 모음", "학교 시간표"]),
        ("안전한 자전거 통학", "자전거로 통학할 때 가장 많은 사고가 난 위치를 확인하고 안전 수칙을 알리자.", "사고 위치를 표시한 통학로 지도", "위험한 위치를 직관적으로 찾아 피할 수 있다", ["학교 주변 지도: 정문 앞 12건, 사거리 9건, 골목 3건", "자전거 제품 사진", "헬멧 색상 표", "운동장 풍경 그림"]),
        ("우리 동네 미세먼지", "계절별 미세먼지 농도를 분석하여 환기가 필요한 시기를 판단하려 한다.", "계절별 미세먼지 평균 농도 그래프", "계절에 따른 농도 차이를 비교할 수 있다", ["봄 48, 여름 22, 가을 31, 겨울 44 µg/m³", "푸른 하늘 사진 한 장", "먼지 캐릭터 그림", "교실 자리 배치표"]),
        ("도서관 이용 시간 바꾸기", "점심시간과 방과 후 도서관 이용자 수를 조사해 운영 시간을 조정하려 한다.", "시간대별 이용자 수 표", "혼잡한 시간대를 수치로 정확히 비교할 수 있다", ["점심 85명, 방과 후 42명, 아침 15명", "책장 사진", "독서 명언 포스터", "책 표지 그림"]),
        ("플라스틱 줄이기 한 달", "텀블러 사용 캠페인 전후의 일회용 컵 사용량을 비교해 결과를 알리려 한다.", "캠페인 전후 컵 사용량 비교 도표", "캠페인 효과를 전후 수치로 쉽게 확인할 수 있다", ["전 1,200개 → 후 620개 / 한 달, 학생회 조사", "텀블러 상품 사진", "학교 축제 일정표", "환경 마스코트 그림"]),
    ]
    articles = []
    for i, (title, body, correct, effect, labels) in enumerate(stories):
        articles.append({"title":title,"body":body,"select":{"prompt":"이 기사에 가장 적합한 자료는?","choices":[{"title":labels[0],"kind":"graph" if i in (0,1,3,5) else "map" if i == 2 else "table","source":"수업용 가상 조사 자료","unit":"명/개/시간 등 문항 참고","period":"예시 기간","image":""},{"title":labels[1],"kind":"photo","source":"수업용 예시 사진","unit":"","period":"","image":""},{"title":labels[2],"kind":"table","source":"수업용 예시 자료","unit":"","period":"","image":""},{"title":labels[3],"kind":"illustration","source":"수업용 삽화","unit":"","period":"","image":""}],"answer":0,"explanation":correct+"이므로 글의 목적에 맞습니다.","hint":"본문에서 비교하거나 확인하려는 정보를 찾으세요."},"effect":{"prompt":"선택한 자료의 효과로 가장 적절한 것은?","choices":[effect,"기사의 내용과 관계없는 장식만 늘어난다","글에 없는 사실을 자동으로 증명한다","자료의 출처를 확인하지 않아도 된다"],"answer":0,"explanation":effect+"는 점이 핵심입니다.","hint":"글의 목적과 자료가 보여 주는 정보를 연결해 보세요."}})
    quizzes = [
        {"after":2,"prompt":"복합양식 자료의 신뢰성을 판단할 때 먼저 확인할 것은?","choices":["자료의 출처와 조사 시기","자료의 색이 화려한지","사진이 큰지","글씨체가 예쁜지"],"answer":0,"explanation":"출처와 조사 시기가 분명해야 자료를 믿을 수 있습니다.","hint":"누가, 언제 조사했는지를 생각하세요."},
        {"after":4,"prompt":"글에 그래프를 넣을 때 가장 중요한 기준은?","choices":["본문의 주장과 그래프 수치가 연결되는지","막대 색이 많은지","그래프가 페이지를 가득 채우는지","제목이 긴지"],"answer":0,"explanation":"자료는 글의 내용과 목적을 뒷받침해야 합니다.","hint":"글과 자료 사이의 관련성을 살펴보세요."},
        {"after":6,"prompt":"같은 현상을 설명하는 두 자료의 수치가 다를 때 해야 할 일은?","choices":["출처·단위·조사 기간을 비교한다","큰 수치만 고른다","예쁜 자료를 고른다","두 자료를 모두 버린다"],"answer":0,"explanation":"단위와 시기 차이로 수치가 달라질 수 있습니다.","hint":"수치가 만들어진 조건을 확인하세요."}
    ]
    boss = [
        {"prompt":"'급식 잔반량 변화' 기사에 부적절한 자료는?","choices":["유명 가수의 콘서트 사진","월별 잔반량 그래프","잔반 줄이기 실천 사진","음식물 쓰레기 처리량 표"],"answer":0,"explanation":"콘서트 사진은 급식 잔반량과 관련이 없습니다.","hint":"기사의 핵심 정보와 관계없는 자료를 찾으세요.","image":""},
        {"prompt":"'학생 90%가 만족'이라는 출처 없는 도표를 어떻게 바꿀까?","choices":["조사 대상·기간·출처가 있는 검증된 도표로 교체","색을 더 진하게 바꾼다","도표를 크게 늘린다","출처 표기를 지운다"],"answer":0,"explanation":"조사 근거를 확인할 수 있는 자료로 교체해야 합니다.","hint":"신뢰할 수 있는 근거가 무엇인지 생각하세요.","image":""},
        {"prompt":"자전거 사고 위험 장소를 알리는 최종 기사에 알맞은 자료와 효과는?","choices":["사고 위치를 표시한 지도 — 위험 구간을 알 수 있다","자전거 사진 — 사고 횟수를 정확히 비교한다","자전거 가격표 — 사고 위치를 알 수 있다","꽃 그림 — 사고 원인을 설명한다"],"answer":0,"explanation":"지도는 실제 위험 구간을 위치별로 보여 줍니다.","hint":"자료가 전달하는 정보를 함께 판단하세요.","image":""}
    ]
    return {"classes":["1반","2반","3반","4반"],"articles":articles,"quizzes":quizzes,"boss":boss,"boss_dialogue":"조회수만 잘 나오면 되는 거 아니야? 사진도 통계도 대충 넣으면 되지!","finals":[],"settings":{"base_views":30000,"multipliers":[{"value":1,"weight":60},{"value":2,"weight":30},{"value":5,"weight":10}],"roulette":[{"type":"views","value":10000,"weight":30},{"type":"views","value":30000,"weight":25},{"type":"views","value":50000,"weight":20},{"type":"multiplier","value":2,"weight":15},{"type":"multiplier","value":3,"weight":7},{"type":"views","value":200000,"weight":3}],"thresholds":[0,100000,300000,600000,1000000],"boss_views":100000,"sound":True,"open":True}}


def level(views, settings):
    return max(i + 1 for i, threshold in enumerate(settings["thresholds"]) if views >= threshold)


def weighted(items):
    total = sum(x["weight"] for x in items)
    point = secrets.randbelow(total)
    for item in items:
        point -= item["weight"]
        if point < 0:
            return item
    raise RuntimeError("empty weights")


def hash_code(code, salt):
    return hashlib.pbkdf2_hmac("sha256", code.encode(), salt.encode(), 180000).hex()


def state_new():
    return {"article":0,"views":0,"score":0,"solved":[],"attempts":{},"published":[],"roulette":{},"pending_multiplier":1,"boss_stage":0,"completed":False,"events":[]}


def content_for(db, student):
    return json.loads(db.execute("SELECT body FROM content WHERE id=?", (student["version"],)).fetchone()[0])


def latest_content(db):
    row = db.execute("SELECT id,body FROM content ORDER BY id DESC LIMIT 1").fetchone()
    return row["id"], json.loads(row["body"])


def safe_content(content):
    out = json.loads(json.dumps(content, ensure_ascii=False))
    for a in out["articles"]:
        for part in ("select","effect"):
            a[part].pop("answer", None)
            a[part].pop("explanation", None)
            a[part].pop("hint", None)
    for q in out["quizzes"] + out["boss"] + out.get("finals", []):
        q.pop("answer", None)
        q.pop("explanation", None)
        q.pop("hint", None)
    return out


def current_key(state):
    n = state["article"]
    if n in (2,4,6) and f"quiz:{n}" not in state["solved"]:
        return f"quiz:{n}"
    if n in (2,4,6) and str(n) not in state["roulette"]:
        return "spin"
    if n < 6:
        if f"article:{n}:select" not in state["solved"]:
            return f"article:{n}:select"
        if f"article:{n}:effect" not in state["solved"]:
            return f"article:{n}:effect"
        return "publish"
    if state["boss_stage"] < 3:
        return f"boss:{state['boss_stage']}"
    return "complete"


def question_for(content, key):
    bits = key.split(":")
    if bits[0] == "article": return content["articles"][int(bits[1])][bits[2]]
    if bits[0] == "quiz": return next(q for q in content["quizzes"] if q["after"] == int(bits[1]))
    if bits[0] == "boss": return content["boss"][int(bits[1])]
    raise ValueError("not a question")


def points(key):
    if key.startswith("article:"): return 5
    if key.startswith("quiz:"): return 5
    return [8,8,9][int(key.split(":")[1])]


def response_state(db, student):
    state = json.loads(student["state"])
    content = content_for(db, student)
    finals=[]
    for row in db.execute("SELECT f.id,f.body,e.attempts,e.first_correct,e.complete FROM final_entries e JOIN finals f ON f.id=e.final_id WHERE e.student_id=? ORDER BY f.id",(student["id"],)):
        q=json.loads(row["body"])
        for key in ("answer","explanation","hint"): q.pop(key,None)
        finals.append({"id":row["id"],"question":q,"attempts":row["attempts"],"first_correct":row["first_correct"],"complete":bool(row["complete"])})
    return {"profile":{"class_name":student["class_name"],"student_no":student["student_no"],"nickname":student["nickname"]},"state":state,"next":current_key(state),"content":safe_content(content),"level":level(state["views"],content["settings"]),"finals":finals}


def validate_content(data):
    if not isinstance(data, dict) or len(data.get("articles",[])) != 6 or len(data.get("quizzes",[])) != 3 or len(data.get("boss",[])) != 3: raise ValueError("기사 6개, 퀴즈 3개, 보스 문제 3개가 필요합니다.")
    if not data.get("classes") or len(set(data["classes"])) != len(data["classes"]): raise ValueError("반 목록을 확인하세요.")
    for a in data["articles"]:
        if not a.get("title") or not a.get("body"): raise ValueError("기사 제목과 본문을 입력하세요.")
        for part in ("select","effect"):
            q=a[part]
            if len(q["choices"]) != 4 or not isinstance(q["answer"],int) or q["answer"] not in range(4): raise ValueError("모든 문제는 선택지 4개와 정답이 필요합니다.")
    for q in data["quizzes"]+data["boss"]+data.get("finals",[]):
        if len(q["choices"]) != 4 or not isinstance(q["answer"],int) or q["answer"] not in range(4): raise ValueError("모든 문제는 선택지 4개와 정답이 필요합니다.")
    if [q["after"] for q in data["quizzes"]] != [2,4,6]: raise ValueError("본문 퀴즈는 기사 2·4·6 뒤에 등장해야 합니다.")
    s=data["settings"]
    if sorted(s["thresholds"]) != s["thresholds"] or len(s["thresholds"]) != 5 or s["thresholds"][0] != 0: raise ValueError("성장 기준은 0부터 시작하는 5개 숫자여야 합니다.")
    for name in ("multipliers","roulette"):
        if sum(x["weight"] for x in s[name]) != 100 or any(x["weight"] < 0 for x in s[name]): raise ValueError(name+" 확률 합계는 100이어야 합니다.")
    if s["base_views"] < 0 or s["boss_views"] < 0: raise ValueError("조회수 보상은 음수가 될 수 없습니다.")


def students_report(db):
    result=[]
    for row in db.execute("SELECT * FROM students ORDER BY class_name,student_no"):
        s=json.loads(row["state"])
        finals=db.execute("SELECT COUNT(*) n,COALESCE(SUM(CASE WHEN first_correct=1 THEN 1 ELSE 0 END),0) wins FROM final_entries WHERE student_id=?",(row["id"],)).fetchone()
        result.append({"id":row["id"],"class_name":row["class_name"],"student_no":row["student_no"],"nickname":row["nickname"],"article":s["article"],"score":s["score"],"attempts":sum(v["count"] for v in s["attempts"].values()),"views":s["views"],"level":level(s["views"],content_for(db,row)["settings"]),"completed":s["completed"],"questions":s["attempts"],"final_assigned":finals["n"],"final_first_correct":finals["wins"]})
    return result


def csv_safe(value):
    text=str(value)
    return "'"+text if text.lstrip().startswith(("=","+","-","@")) else text


class Handler(BaseHTTPRequestHandler):
    protocol_version="HTTP/1.1"

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/"): super().log_message(fmt,*args)

    def send(self, status, data, cookie=None, content_type="application/json; charset=utf-8"):
        body=data if isinstance(data,bytes) else json.dumps(data,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type",content_type)
        self.send_header("Content-Length",str(len(body)))
        self.send_header("Cache-Control","no-store")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("X-Frame-Options","DENY")
        if cookie: self.send_header("Set-Cookie",cookie)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n=int(self.headers.get("Content-Length","0"))
        if n>2_000_000: raise ValueError("요청이 너무 큽니다.")
        return json.loads(self.rfile.read(n) or b"{}")

    def session(self, db):
        cookie=SimpleCookie()
        try: cookie.load(self.headers.get("Cookie","")); token=cookie["session"].value
        except (KeyError, Exception): return None
        return db.execute("SELECT * FROM sessions WHERE token_hash=? AND expires>?",(hashlib.sha256(token.encode()).hexdigest(),int(time.time()))).fetchone()

    def student(self, db):
        sess=self.session(db)
        if not sess or sess["role"] != "student": raise PermissionError("학생 로그인이 필요합니다.")
        return db.execute("SELECT * FROM students WHERE id=?",(sess["student_id"],)).fetchone()

    def admin(self, db):
        sess=self.session(db)
        if not sess or sess["role"] != "admin": raise PermissionError("교사 로그인이 필요합니다.")

    def new_session(self, db, role, sid=None):
        token=secrets.token_urlsafe(32)
        db.execute("INSERT INTO sessions VALUES(?,?,?,?)",(hashlib.sha256(token.encode()).hexdigest(),role,sid,int(time.time())+60*60*24*14))
        return f"session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600"

    def do_GET(self):
        path=urlparse(self.path).path
        if path in ("/","/index.html","/app.js","/style.css"):
            file=ROOT/("index.html" if path=="/" else path.lstrip("/"))
            mime="text/html; charset=utf-8" if file.suffix==".html" else "text/javascript; charset=utf-8" if file.suffix==".js" else "text/css; charset=utf-8"
            return self.send(200,file.read_bytes(),content_type=mime)
        if path.startswith("/api/"):
            try:
                with connect() as db:
                    if path=="/api/bootstrap":
                        _,c=latest_content(db)
                        sess=self.session(db)
                        student=db.execute("SELECT * FROM students WHERE id=?",(sess["student_id"],)).fetchone() if sess and sess["role"]=="student" else None
                        return self.send(200,{"classes":c["classes"],"game_open":c["settings"]["open"],"game":response_state(db,student) if student else None,"admin":bool(sess and sess["role"]=="admin")})
                    if path=="/api/admin/state":
                        self.admin(db); version,c=latest_content(db)
                        students=students_report(db)
                        return self.send(200,{"version":version,"content":c,"students":students,"awards":[dict(x) for x in db.execute("SELECT * FROM awards")],"finals":[dict(x) for x in db.execute("SELECT * FROM finals ORDER BY id")],"final_entries":[dict(x) for x in db.execute("SELECT * FROM final_entries")],"versions":[dict(x) for x in db.execute("SELECT id,created FROM content ORDER BY id DESC LIMIT 30")]})
                    if path=="/api/admin/export":
                        self.admin(db)
                        rows=students_report(db)
                        selected=parse_qs(urlparse(self.path).query).get("class",[""])[0]
                        if selected: rows=[row for row in rows if row["class_name"]==selected]
                        out=io.StringIO(); writer=csv.writer(out)
                        writer.writerow(["반","번호","닉네임","기사","학습점수","시도횟수","조회수","레벨","완료","문항별 시도(JSON)"])
                        for x in rows: writer.writerow([csv_safe(x["class_name"]),x["student_no"],csv_safe(x["nickname"]),x["article"],x["score"],x["attempts"],x["views"],x["level"],x["completed"],json.dumps(x["questions"],ensure_ascii=False)])
                        return self.send(200,"\ufeff".encode()+out.getvalue().encode(),content_type="text/csv; charset=utf-8")
                    if path=="/api/admin/backup":
                        self.admin(db); _,c=latest_content(db)
                        return self.send(200,c)
            except PermissionError as e: return self.send(403,{"error":str(e)})
            return self.send(404,{"error":"찾을 수 없습니다."})
        return self.send(404,b"Not found",content_type="text/plain")

    def do_POST(self):
        path=urlparse(self.path).path
        try:
            data=self.read_json()
            with LOCK, connect() as db:
                db.execute("BEGIN IMMEDIATE")
                result,cookie=self.action(db,path,data)
                db.commit()
            self.send(200,result,cookie)
        except PermissionError as e: self.send(403,{"error":str(e)})
        except (ValueError,KeyError,IndexError,TypeError) as e: self.send(400,{"error":str(e)})
        except sqlite3.IntegrityError: self.send(409,{"error":"이미 등록된 반과 번호입니다. 복구 코드를 사용하세요."})
        except Exception as e:
            print("server error:",repr(e),flush=True)
            self.send(500,{"error":"서버 오류가 발생했습니다."})

    def action(self, db, path, data):
        if path=="/api/register":
            _,content=latest_content(db)
            if not content["settings"]["open"]: raise PermissionError("게임 시작이 닫혀 있습니다.")
            cls=str(data["class_name"]); no=int(data["student_no"]); nick=str(data["nickname"]).strip()[:20]
            if cls not in content["classes"] or not 1<=no<=35 or not nick: raise ValueError("반, 번호, 닉네임을 확인하세요.")
            code="-".join(secrets.token_hex(3).upper() for _ in range(2)); salt=secrets.token_hex(16)
            vid=db.execute("SELECT id FROM content ORDER BY id DESC LIMIT 1").fetchone()[0]
            cur=db.execute("INSERT INTO students(class_name,student_no,nickname,recovery_hash,version,state,created) VALUES(?,?,?,?,?,?,?)",(cls,no,nick,salt+":"+hash_code(code,salt),vid,json.dumps(state_new()),now()))
            student=db.execute("SELECT * FROM students WHERE id=?",(cur.lastrowid,)).fetchone()
            return {"recovery_code":code,"game":response_state(db,student)},self.new_session(db,"student",student["id"])
        if path=="/api/recover":
            row=db.execute("SELECT * FROM students WHERE class_name=? AND student_no=?",(data["class_name"],int(data["student_no"]))).fetchone()
            if not row: raise PermissionError("기록 또는 복구 코드가 맞지 않습니다.")
            salt,digest=row["recovery_hash"].split(":")
            if not hmac.compare_digest(hash_code(str(data["code"]).strip().upper(),salt),digest): raise PermissionError("기록 또는 복구 코드가 맞지 않습니다.")
            return {"game":response_state(db,row)},self.new_session(db,"student",row["id"])
        if path=="/api/admin/login":
            if not ADMIN_PASSWORD: raise PermissionError("서버에 ADMIN_PASSWORD를 설정해야 합니다.")
            address=self.client_address[0]
            failures=[stamp for stamp in LOGIN_FAILURES.get(address,[]) if time.time()-stamp<900]
            LOGIN_FAILURES[address]=failures
            if len(failures)>=5: raise PermissionError("로그인 시도가 너무 많습니다. 15분 뒤 다시 시도하세요.")
            if not hmac.compare_digest(str(data.get("password","")),ADMIN_PASSWORD):
                failures.append(time.time())
                raise PermissionError("암호가 맞지 않습니다.")
            LOGIN_FAILURES.pop(address,None)
            return {"ok":True},self.new_session(db,"admin")
        if path=="/api/logout":
            cookie=SimpleCookie()
            try: cookie.load(self.headers.get("Cookie","")); token=cookie["session"].value; db.execute("DELETE FROM sessions WHERE token_hash=?",(hashlib.sha256(token.encode()).hexdigest(),))
            except Exception: pass
            return {"ok":True},"session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
        if path.startswith("/api/admin/"): return self.admin_action(db,path,data)
        student=self.student(db); sid=student["id"]
        if not latest_content(db)[1]["settings"]["open"]: raise PermissionError("교사가 게임을 종료했습니다.")
        rid=str(data.get("request_id",""))
        if not 8<=len(rid)<=100: raise ValueError("요청 ID가 필요합니다.")
        cached=db.execute("SELECT response FROM requests WHERE student_id=? AND request_id=?",(sid,rid)).fetchone()
        if cached: return json.loads(cached[0]),None
        state=json.loads(student["state"]); content=content_for(db,student); settings=content["settings"]
        if path=="/api/final/answer":
            if not state["completed"]: raise ValueError("본 게임 완료 후 결승에 참여할 수 있습니다.")
            final_id=int(data["final_id"]); choice=int(data["choice"])
            if choice not in range(4): raise ValueError("선택지를 확인하세요.")
            row=db.execute("SELECT f.body,e.attempts,e.complete FROM final_entries e JOIN finals f ON e.final_id=f.id WHERE e.student_id=? AND e.final_id=?",(sid,final_id)).fetchone()
            if not row or row["complete"]: raise ValueError("참여할 수 없는 결승 문제입니다.")
            q=json.loads(row["body"]); correct=choice==q["answer"]; first=not row["attempts"]
            db.execute("UPDATE final_entries SET attempts=attempts+1,first_correct=CASE WHEN attempts=0 THEN ? ELSE first_correct END,complete=? WHERE student_id=? AND final_id=?",(int(correct),int(correct),sid,final_id))
            result={"correct":correct,"first_correct":correct and first,"explanation":q["explanation"],"game":response_state(db,student)}
        elif path=="/api/answer":
            key=current_key(state)
            if key!=data.get("key") or key in ("publish","spin","complete"): raise ValueError("현재 풀 수 있는 문제가 아닙니다.")
            q=question_for(content,key); choice=int(data["choice"])
            if choice not in range(4): raise ValueError("선택지를 확인하세요.")
            entry=state["attempts"].setdefault(key,{"count":0,"wrong":0,"first_correct":None,"complete":False,"first_correct_at":None,"completed_at":None,"choices":[]})
            entry["count"]+=1; entry["choices"].append(choice)
            correct=choice==q["answer"]
            if entry["count"]==1:
                entry["first_correct"]=correct
                if correct: state["score"]+=points(key); entry["first_correct_at"]=now()
            if correct:
                entry["complete"]=True; entry["completed_at"]=now(); state["solved"].append(key)
                if key.startswith("boss:"):
                    state["boss_stage"]+=1
                    if state["boss_stage"]==3:
                        before=level(state["views"],settings); gain=settings["boss_views"]*state["pending_multiplier"]; state["views"]+=gain; state["pending_multiplier"]=1; state["completed"]=True; state["title"]="전설의 편집장"; state["events"].append({"type":"boss","views":gain,"level_from":before,"level_to":level(state["views"],settings)})
            else: entry["wrong"]+=1
            result={"correct":correct,"explanation":q["explanation"],"hint":q.get("hint",""),"game":None}
        elif path=="/api/publish":
            if current_key(state)!="publish": raise ValueError("아직 발행할 수 없습니다.")
            before=level(state["views"],settings); rolled=weighted(settings["multipliers"])["value"]; applied=max(rolled,state["pending_multiplier"]); gain=settings["base_views"]*applied
            state["views"]+=gain; state["pending_multiplier"]=1; state["article"]+=1; state["published"].append({"article":state["article"],"random_multiplier":rolled,"applied_multiplier":applied,"views":gain,"at":now()})
            result={"reward":{"type":"publish","views":gain,"random_multiplier":rolled,"applied_multiplier":applied,"level_from":before,"level_to":level(state["views"],settings)},"game":None}
        elif path=="/api/spin":
            if current_key(state)!="spin": raise ValueError("지금은 룰렛을 돌릴 수 없습니다.")
            before=level(state["views"],settings); prize=dict(weighted(settings["roulette"]))
            if prize["type"]=="views": state["views"]+=prize["value"]
            else: state["pending_multiplier"]=max(state["pending_multiplier"],prize["value"])
            state["roulette"][str(state["article"])]=prize
            result={"reward":{"type":"spin","prize":prize,"level_from":before,"level_to":level(state["views"],settings)},"game":None}
        else: raise ValueError("지원하지 않는 요청입니다.")
        db.execute("UPDATE students SET state=? WHERE id=?",(json.dumps(state,ensure_ascii=False),sid))
        student=db.execute("SELECT * FROM students WHERE id=?",(sid,)).fetchone(); result["game"]=response_state(db,student)
        db.execute("INSERT INTO requests VALUES(?,?,?)",(sid,rid,json.dumps(result,ensure_ascii=False)))
        return result,None

    def admin_action(self, db, path, data):
        self.admin(db)
        if path=="/api/admin/content":
            content=data["content"]; validate_content(content)
            cur=db.execute("INSERT INTO content(body,created) VALUES(?,?)",(json.dumps(content,ensure_ascii=False),now()))
            return {"version":cur.lastrowid},None
        if path=="/api/admin/version/restore":
            row=db.execute("SELECT body FROM content WHERE id=?",(int(data["version"]),)).fetchone()
            if not row: raise ValueError("문제 버전을 찾을 수 없습니다.")
            cur=db.execute("INSERT INTO content(body,created) VALUES(?,?)",(row["body"],now()))
            return {"version":cur.lastrowid},None
        if path=="/api/admin/award":
            kind=str(data["kind"])
            if kind not in ("star","analysis"): raise ValueError("시상 부문을 확인하세요.")
            sid=data.get("student_id")
            if sid is not None and not db.execute("SELECT 1 FROM students WHERE id=?",(sid,)).fetchone(): raise ValueError("학생을 찾을 수 없습니다.")
            db.execute("INSERT INTO awards(kind,student_id,note) VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET student_id=excluded.student_id,note=excluded.note",(kind,sid,str(data.get("note",""))[:200]))
            return {"ok":True},None
        if path=="/api/admin/final":
            q=data["question"]; validate_content({**latest_content(db)[1],"finals":[q]})
            cur=db.execute("INSERT INTO finals(content_id,body,created) VALUES(?,?,?)",(latest_content(db)[0],json.dumps(q,ensure_ascii=False),now()))
            for sid in data.get("student_ids",[]):
                db.execute("INSERT INTO final_entries(student_id,final_id) VALUES(?,?)",(int(sid),cur.lastrowid))
            return {"id":cur.lastrowid},None
        if path=="/api/admin/final/assign":
            final=int(data["final_id"])
            if not db.execute("SELECT 1 FROM finals WHERE id=?",(final,)).fetchone(): raise ValueError("결승 문제를 찾을 수 없습니다.")
            for sid in data.get("student_ids",[]): db.execute("INSERT OR IGNORE INTO final_entries(student_id,final_id) VALUES(?,?)",(int(sid),final))
            return {"ok":True},None
        if path=="/api/admin/final/edit":
            fid=int(data["final_id"]); q=data["question"]
            validate_content({**latest_content(db)[1],"finals":[q]})
            if db.execute("SELECT 1 FROM final_entries WHERE final_id=? AND attempts>0",(fid,)).fetchone(): raise ValueError("이미 제출된 결승 문제는 수정할 수 없습니다. 새 문제를 추가하세요.")
            if not db.execute("UPDATE finals SET body=? WHERE id=?",(json.dumps(q,ensure_ascii=False),fid)).rowcount: raise ValueError("결승 문제를 찾을 수 없습니다.")
            return {"ok":True},None
        if path=="/api/admin/final/delete":
            fid=int(data["final_id"])
            if db.execute("SELECT 1 FROM final_entries WHERE final_id=? AND attempts>0",(fid,)).fetchone(): raise ValueError("이미 제출된 결승 문제는 삭제할 수 없습니다.")
            db.execute("DELETE FROM final_entries WHERE final_id=?",(fid,)); db.execute("DELETE FROM finals WHERE id=?",(fid,))
            return {"ok":True},None
        raise ValueError("지원하지 않는 요청입니다.")


if __name__=="__main__":
    init()
    host=os.environ.get("GAME_HOST","127.0.0.1"); port=int(os.environ.get("PORT","8766"))
    print(f"Serving game on {host}:{port}; teacher login {'enabled' if ADMIN_PASSWORD else 'disabled (set ADMIN_PASSWORD)'}",flush=True)
    ThreadingHTTPServer((host,port),Handler).serve_forever()
