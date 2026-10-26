import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const port = await new Promise(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
});
const temp = mkdtempSync(join(tmpdir(), 'newsroom-worker-'));
const base = `http://127.0.0.1:${port}/api/`;
const processHandle = spawn('./node_modules/.bin/wrangler', ['dev', '--local', '--port', String(port), '--var', 'ADMIN_PASSWORD:test-password', '--persist-to', temp], {
  cwd: process.cwd(), env: { ...process.env, XDG_CONFIG_HOME: join(temp, 'config'), WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe']
});
let serverOutput = '';
for (const stream of [processHandle.stdout, processHandle.stderr]) stream.on('data', chunk => { serverOutput += chunk.toString().slice(0, 1000); });

class Client {
  cookie = '';
  async get(path) { return this.call(path); }
  async post(path, body) { return this.call(path, body); }
  async action(path, body = {}) { return this.post(path, { ...body, request_id: randomUUID() }); }
  async call(path, body) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const cookie = response.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';')[0];
    const data = await response.json();
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(data)}`);
    return data;
  }
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(base + 'bootstrap'); if (response.ok) { ready = true; break; } }
    catch { /* wait for workerd */ }
    if (processHandle.exitCode != null) break;
    await delay(100);
  }
  if (!ready) throw new Error(`Worker failed to start: ${serverOutput.slice(-2000)}`);

  await test('Cloudflare Worker: complete game, persistence, permissions, 35 students', async () => {
    const student = new Client();
    const registered = await student.post('register', { class_name: '1반', student_no: 1, nickname: '편집자' });
    assert.ok(registered.recovery_code);
    let game = registered.game;
    assert.equal(game.next, 'article:0:select');
    assert.equal(Object.hasOwn(game.content.articles[0].select, 'answer'), false);
    const wrong = await student.action('answer', { key: game.next, choice: 1 });
    assert.equal(wrong.correct, false);
    game = (await student.action('answer', { key: game.next, choice: 0 })).game;
    while (game.next !== 'complete') {
      const key = game.next;
      if (key === 'publish' || key === 'spin') {
        const rid = randomUUID();
        const result = await student.post(key, { request_id: rid });
        assert.deepEqual(result, await student.post(key, { request_id: rid }));
        game = result.game;
      } else game = (await student.action('answer', { key, choice: 0 })).game;
    }
    assert.equal(game.state.score, 95);
    assert.equal(game.state.published.length, 6);
    assert.equal(Object.keys(game.state.roulette).length, 3);
    assert.equal(Object.values(game.state.attempts).reduce((n, x) => n + x.count, 0), 19);
    assert.equal(game.state.completed, true);

    const other = new Client();
    await assert.rejects(other.post('recover', { class_name: '1반', student_no: 1, code: 'WRONG' }));
    const resumed = await other.post('recover', { class_name: '1반', student_no: 1, code: registered.recovery_code });
    assert.deepEqual(resumed.game.state, game.state);
    await assert.rejects(student.get('admin/state'));

    const teacher = new Client();
    await teacher.post('admin/login', { password: 'test-password' });
    const old = await teacher.get('admin/state');
    assert.equal(old.students[0].score, 95);
    old.content.articles[0].title = '수정된 기사';
    await teacher.post('admin/content', { content: old.content });
    assert.notEqual((await teacher.get('admin/state')).version, old.version);
    assert.notEqual((await other.get('bootstrap')).game.content.articles[0].title, '수정된 기사');
    const final = await teacher.post('admin/final', { question: { prompt: '결승', choices: ['정답', '오답', '오답', '오답'], answer: 0, explanation: '해설', hint: '' }, student_ids: [old.students[0].id] });
    const assigned = (await other.get('bootstrap')).game.finals[0];
    assert.equal(assigned.id, final.id);
    assert.equal(Object.hasOwn(assigned.question, 'answer'), false);
    const answered = await other.action('final/answer', { final_id: final.id, choice: 0 });
    assert.equal(answered.first_correct, true);
    assert.equal(answered.game.state.score, 95);

    const attacker = new Client();
    for (let i = 0; i < 5; i++) await assert.rejects(attacker.post('admin/login', { password: 'wrong' }));
    await assert.rejects(attacker.post('admin/login', { password: 'test-password' }), /15분/);

    const created = await Promise.all(Array.from({ length: 35 }, async (_, i) => {
      const client = new Client();
      const profile = await client.post('register', { class_name: '2반', student_no: i + 1, nickname: `학생${i+1}` });
      const result = await client.action('answer', { key: 'article:0:select', choice: 0 });
      return [profile.game.profile.student_no, result.game.state.score];
    }));
    assert.equal(new Set(created.map(x => x[0])).size, 35);
    assert.ok(created.every(x => x[1] === 5));
  });
} finally {
  processHandle.kill('SIGTERM');
  await Promise.race([new Promise(resolve => processHandle.once('exit', resolve)), delay(5000)]);
  rmSync(temp, { recursive: true, force: true });
}
