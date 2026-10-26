import http.cookiejar
import json
import os
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class Client:
    def __init__(self, port):
        self.base = f"http://127.0.0.1:{port}/api/"
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def get(self, path):
        return json.load(self.opener.open(self.base + path))

    def post(self, path, **data):
        req = urllib.request.Request(self.base + path, json.dumps(data).encode(), {"Content-Type": "application/json"})
        try:
            return json.load(self.opener.open(req))
        except urllib.error.HTTPError as exc:
            raise AssertionError(f"{path}: HTTP {exc.code} {exc.read().decode()}")

    def action(self, path, **data):
        return self.post(path, request_id=str(uuid.uuid4()), **data)


class GameTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        env = dict(os.environ, GAME_DATA_DIR=cls.temp.name, PORT=str(cls.port), ADMIN_PASSWORD="test-password")
        cls.proc = subprocess.Popen(["python3", "server.py"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/")
                break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError("test server did not start")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=5)
        cls.temp.cleanup()

    def test_full_game_security_and_teacher_version(self):
        student = Client(self.port)
        initial = student.post("register", class_name="1반", student_no=1, nickname="기자")
        code = initial["recovery_code"]
        game = initial["game"]
        self.assertNotIn("answer", game["content"]["articles"][0]["select"])
        self.assertEqual(game["next"], "article:0:select")
        wrong = student.action("answer", key=game["next"], choice=1)
        self.assertFalse(wrong["correct"])
        self.assertEqual(wrong["game"]["state"]["score"], 0)
        game = student.action("answer", key=game["next"], choice=0)["game"]
        self.assertEqual(game["state"]["attempts"]["article:0:select"]["count"], 2)

        while game["next"] != "complete":
            key = game["next"]
            if key == "publish":
                rid = str(uuid.uuid4())
                result = student.post("publish", request_id=rid)
                same = student.post("publish", request_id=rid)
                self.assertEqual(result, same)
                game = result["game"]
            elif key == "spin":
                rid = str(uuid.uuid4())
                result = student.post("spin", request_id=rid)
                self.assertEqual(result, student.post("spin", request_id=rid))
                game = result["game"]
            else:
                game = student.action("answer", key=key, choice=0)["game"]
        self.assertEqual(game["state"]["score"], 95)
        self.assertEqual(sum(x["count"] for x in game["state"]["attempts"].values()), 19)
        self.assertEqual(len(game["state"]["roulette"]), 3)
        self.assertEqual(len(game["state"]["published"]), 6)
        self.assertTrue(game["state"]["completed"])

        other = Client(self.port)
        with self.assertRaises(AssertionError):
            other.post("recover", class_name="1반", student_no=1, code="wrong")
        resumed = other.post("recover", class_name="1반", student_no=1, code=code)["game"]
        self.assertEqual(resumed["state"], game["state"])

        teacher = Client(self.port)
        with self.assertRaises(urllib.error.HTTPError):
            student.get("admin/state")
        teacher.post("admin/login", password="test-password")
        admin = teacher.get("admin/state")
        self.assertEqual(admin["students"][0]["score"], 95)
        edited = admin["content"]
        edited["articles"][0]["title"] = "수정된 기사"
        teacher.post("admin/content", content=edited)
        self.assertNotEqual(teacher.get("admin/state")["version"], admin["version"])
        self.assertNotEqual(other.get("bootstrap")["game"]["content"]["articles"][0]["title"], "수정된 기사")
        teacher.post("admin/final", question={"prompt": "결승 문제", "choices": ["맞음", "틀림", "틀림", "틀림"], "answer": 0, "explanation": "해설", "hint": ""}, student_ids=[admin["students"][0]["id"]])
        final = other.get("bootstrap")["game"]["finals"][0]
        self.assertNotIn("answer", final["question"])
        result = other.action("final/answer", final_id=final["id"], choice=0)
        self.assertTrue(result["first_correct"])
        self.assertEqual(result["game"]["state"]["score"], 95)

    def test_concurrent_students_have_separate_records(self):
        def play(number):
            client = Client(self.port)
            registered = client.post("register", class_name="2반", student_no=number, nickname=f"학생{number}")
            key = registered["game"]["next"]
            result = client.action("answer", key=key, choice=0)
            return registered["game"]["profile"]["student_no"], result["game"]["state"]["score"]

        with ThreadPoolExecutor(max_workers=35) as pool:
            results = list(pool.map(play, range(1, 36)))
        self.assertEqual(len({no for no, score in results}), 35)
        self.assertTrue(all(score == 5 for no, score in results))


if __name__ == "__main__":
    unittest.main()
