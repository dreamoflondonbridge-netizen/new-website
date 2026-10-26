import seed from './seed.json';

const enc = new TextEncoder();
let initPromise;
const tables = [
  'CREATE TABLE IF NOT EXISTS content(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, created TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS students(id INTEGER PRIMARY KEY AUTOINCREMENT, class_name TEXT NOT NULL, student_no INTEGER NOT NULL, nickname TEXT NOT NULL, recovery_hash TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, UNIQUE(class_name,student_no))',
  'CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, student_id INTEGER, expires INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS requests(student_id INTEGER NOT NULL, request_id TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(student_id,request_id))',
  'CREATE TABLE IF NOT EXISTS finals(id INTEGER PRIMARY KEY AUTOINCREMENT, content_id INTEGER NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS final_entries(student_id INTEGER NOT NULL, final_id INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, first_correct INTEGER, complete INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(student_id,final_id))',
  "CREATE TABLE IF NOT EXISTS awards(kind TEXT PRIMARY KEY, student_id INTEGER, note TEXT NOT NULL DEFAULT '')",
  'CREATE TABLE IF NOT EXISTS login_failures(address TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)'
];
const now = () => new Date().toISOString();
const unix = () => Math.floor(Date.now()/1000);
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const json = (value,status=200,extra={}) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',...extra}});
const parse = value => JSON.parse(value);
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const hash = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))));
async function codeHash(code,salt){
  const key=await crypto.subtle.importKey('raw',enc.encode(code),'PBKDF2',false,['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode(salt),iterations:20000},key,256)));
}
async function same(a,b){const aa=await hash(a),bb=await hash(b);let diff=0;for(let i=0;i<aa.length;i++)diff|=aa.charCodeAt(i)^bb.charCodeAt(i);return diff===0;}
function randomInt(max){const limit=Math.floor(4294967296/max)*max;let value;do{value=crypto.getRandomValues(new Uint32Array(1))[0]}while(value>=limit);return value%max;}
function weighted(items){let point=randomInt(items.reduce((n,x)=>n+x.weight,0));for(const item of items){point-=item.weight;if(point<0)return item;}throw Error('invalid weights')}
function initial(){return {article:0,views:0,score:0,solved:[],attempts:{},published:[],roulette:{},pending_multiplier:1,boss_stage:0,completed:false,events:[]}}
function level(views,settings){let n=1;settings.thresholds.forEach((threshold,i)=>{if(views>=threshold)n=i+1});return n}
function currentKey(state){const n=state.article;if([2,4,6].includes(n)&&!state.solved.includes(`quiz:${n}`))return `quiz:${n}`;if([2,4,6].includes(n)&&!Object.hasOwn(state.roulette,String(n)))return 'spin';if(n<6){if(!state.solved.includes(`article:${n}:select`))return `article:${n}:select`;if(!state.solved.includes(`article:${n}:effect`))return `article:${n}:effect`;return 'publish'}return state.boss_stage<3?`boss:${state.boss_stage}`:'complete'}
function question(content,key){const [kind,index,part]=key.split(':');if(kind==='article')return content.articles[+index][part];if(kind==='quiz')return content.quizzes.find(q=>q.after===+index);if(kind==='boss')return content.boss[+index];fail(400,'문제를 찾을 수 없습니다.')}
function points(key){if(key.startsWith('article:')||key.startsWith('quiz:'))return 5;return [8,8,9][+key.split(':')[1]]}
function safeContent(content){const out=structuredClone(content);for(const article of out.articles)for(const part of ['select','effect'])for(const field of ['answer','explanation','hint'])delete article[part][field];for(const q of [...out.quizzes,...out.boss,...(out.finals||[])])for(const field of ['answer','explanation','hint'])delete q[field];return out}
function validate(content){
  if(!content||content.articles?.length!==6||content.quizzes?.length!==3||content.boss?.length!==3)fail(400,'기사 6개, 퀴즈 3개, 보스 문제 3개가 필요합니다.');
  if(!content.classes?.length||new Set(content.classes).size!==content.classes.length)fail(400,'반 목록을 확인하세요.');
  const qs=[...content.articles.flatMap(a=>[a.select,a.effect]),...content.quizzes,...content.boss,...(content.finals||[])];
  if(content.articles.some(a=>!a.title||!a.body)||qs.some(q=>!q||q.choices?.length!==4||!Number.isInteger(q.answer)||q.answer<0||q.answer>3))fail(400,'모든 문제에는 선택지 4개와 정답이 필요합니다.');
  if(content.quizzes.map(q=>q.after).join(',')!=='2,4,6')fail(400,'본문 퀴즈는 기사 2·4·6 뒤에 등장해야 합니다.');
  const s=content.settings;
  if(!s||s.thresholds?.length!==5||s.thresholds[0]!==0||s.thresholds.some((v,i)=>i&&v<=s.thresholds[i-1]))fail(400,'성장 기준은 0부터 시작하는 오름차순 숫자 5개여야 합니다.');
  for(const name of ['multipliers','roulette'])if(!s[name]?.length||s[name].some(x=>!Number.isInteger(x.weight)||x.weight<0)||s[name].reduce((n,x)=>n+x.weight,0)!==100)fail(400,`${name} 확률 합계는 100이어야 합니다.`);
  if(!Number.isInteger(s.base_views)||s.base_views<0||!Number.isInteger(s.boss_views)||s.boss_views<0)fail(400,'조회수 보상을 확인하세요.');
}
async function init(db){
  await db.batch(tables.map(sql=>db.prepare(sql)));
  await db.prepare('INSERT INTO content(body,created) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM content)').bind(JSON.stringify(seed),now()).run();
}
async function latest(db){const row=await db.prepare('SELECT id,body FROM content ORDER BY id DESC LIMIT 1').first();return {id:row.id,body:parse(row.body)}}
async function contentFor(db,student){const row=await db.prepare('SELECT body FROM content WHERE id=?').bind(student.version).first();return parse(row.body)}
function cookieValue(req){const cookies=req.headers.get('Cookie')||'';const match=cookies.match(/(?:^|;\s*)session=([^;]+)/);return match?.[1]||''}
async function session(req,db){const token=cookieValue(req);if(!token)return null;return db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires>?').bind(await hash(token),unix()).first()}
async function newSession(db,role,studentId,url){const token=randomHex(32);await db.prepare('INSERT INTO sessions(token_hash,role,student_id,expires) VALUES(?,?,?,?)').bind(await hash(token),role,studentId,unix()+1209600).run();return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600${url.protocol==='https:'?'; Secure':''}`}
async function studentAuth(req,db){const sess=await session(req,db);if(sess?.role!=='student')fail(403,'학생 로그인이 필요합니다.');return db.prepare('SELECT * FROM students WHERE id=?').bind(sess.student_id).first()}
async function adminAuth(req,db){const sess=await session(req,db);if(sess?.role!=='admin')fail(403,'교사 로그인이 필요합니다.')}
async function gameState(db,student,contentOverride=null,stateOverride=null){
  const state=stateOverride||parse(student.state),content=contentOverride||await contentFor(db,student);
  const rows=(await db.prepare('SELECT f.id,f.body,e.attempts,e.first_correct,e.complete FROM final_entries e JOIN finals f ON f.id=e.final_id WHERE e.student_id=? ORDER BY f.id').bind(student.id).all()).results;
  const finals=rows.map(row=>{const q=parse(row.body);for(const field of ['answer','explanation','hint'])delete q[field];return {id:row.id,question:q,attempts:row.attempts,first_correct:row.first_correct,complete:!!row.complete}});
  return {profile:{class_name:student.class_name,student_no:student.student_no,nickname:student.nickname},state,next:currentKey(state),content:safeContent(content),level:level(state.views,content.settings),finals};
}
async function studentsReport(db){
  const students=(await db.prepare('SELECT * FROM students ORDER BY class_name,student_no').all()).results;
  const versions=new Map((await db.prepare('SELECT id,body FROM content').all()).results.map(x=>[x.id,parse(x.body)]));
  const finals=(await db.prepare('SELECT student_id,COUNT(*) n,COALESCE(SUM(CASE WHEN first_correct=1 THEN 1 ELSE 0 END),0) wins FROM final_entries GROUP BY student_id').all()).results;
  const finalMap=new Map(finals.map(x=>[x.student_id,x]));
  return students.map(row=>{const s=parse(row.state),f=finalMap.get(row.id)||{n:0,wins:0};return {id:row.id,class_name:row.class_name,student_no:row.student_no,nickname:row.nickname,article:s.article,score:s.score,attempts:Object.values(s.attempts).reduce((n,x)=>n+x.count,0),views:s.views,level:level(s.views,versions.get(row.version).settings),completed:s.completed,questions:s.attempts,final_assigned:f.n,final_first_correct:f.wins,version:row.version}});
}
const csvCell=value=>{const text=String(value);return /^[\s]*[=+@-]/.test(text)?`'${text}`:text};
function csv(rows){return '\ufeff'+rows.map(row=>row.map(value=>`"${csvCell(value).replaceAll('"','""')}"`).join(',')).join('\r\n')+'\r\n'}
async function readBody(req){const length=Number(req.headers.get('Content-Length')||0);if(length>2000000)fail(413,'요청이 너무 큽니다.');const text=await req.text();if(text.length>2000000)fail(413,'요청이 너무 큽니다.');try{return JSON.parse(text||'{}')}catch{fail(400,'JSON 요청을 확인하세요.')}}

async function get(req,env,path,url){const db=env.DB;
  if(path==='/api/bootstrap'){
    const {body}=await latest(db),sess=await session(req,db),student=sess?.role==='student'?await db.prepare('SELECT * FROM students WHERE id=?').bind(sess.student_id).first():null;
    return json({classes:body.classes,game_open:body.settings.open,game:student?await gameState(db,student):null,admin:sess?.role==='admin'});
  }
  await adminAuth(req,db);
  if(path==='/api/admin/state'){
    const {id,body}=await latest(db);return json({version:id,content:body,students:await studentsReport(db),awards:(await db.prepare('SELECT * FROM awards').all()).results,finals:(await db.prepare('SELECT * FROM finals ORDER BY id').all()).results,final_entries:(await db.prepare('SELECT * FROM final_entries').all()).results,versions:(await db.prepare('SELECT id,created FROM content ORDER BY id DESC LIMIT 30').all()).results});
  }
  if(path==='/api/admin/backup')return json((await latest(db)).body);
  if(path==='/api/admin/export'){
    let rows=await studentsReport(db);const selected=url.searchParams.get('class');if(selected)rows=rows.filter(x=>x.class_name===selected);
    const data=csv([['반','번호','닉네임','기사','학습점수','시도횟수','조회수','레벨','완료','문항별 시도(JSON)'],...rows.map(x=>[x.class_name,x.student_no,x.nickname,x.article,x.score,x.attempts,x.views,x.level,x.completed,JSON.stringify(x.questions)])]);
    return new Response(data,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="newsroom-results.csv"','Cache-Control':'no-store'}});
  }
  fail(404,'찾을 수 없습니다.');
}

async function post(req,env,path,url,data){const db=env.DB;
  if(path==='/api/register'){
    const {id,body}=await latest(db);
    if(!body.settings.open)fail(403,'게임 시작이 닫혀 있습니다.');
    const cls=String(data.class_name||''),num=Number(data.student_no),nickname=String(data.nickname||'').trim().slice(0,20);
    if(!body.classes.includes(cls)||!Number.isInteger(num)||num<1||num>35||!nickname)fail(400,'반, 번호, 닉네임을 확인하세요.');
    const code=`${randomHex(4)}-${randomHex(4)}`.toUpperCase(),salt=randomHex(16),digest=await codeHash(code,salt);
    let result;try{result=await db.prepare('INSERT INTO students(class_name,student_no,nickname,recovery_hash,version,state,created) VALUES(?,?,?,?,?,?,?)').bind(cls,num,nickname,`${salt}:${digest}`,id,JSON.stringify(initial()),now()).run()}catch(e){if(String(e).includes('UNIQUE'))fail(409,'이미 등록된 반과 번호입니다. 복구 코드를 사용하세요.');throw e}
    const student=await db.prepare('SELECT * FROM students WHERE id=?').bind(result.meta.last_row_id).first();
    return json({recovery_code:code,game:await gameState(db,student)},200,{'Set-Cookie':await newSession(db,'student',student.id,url)});
  }
  if(path==='/api/recover'){
    const student=await db.prepare('SELECT * FROM students WHERE class_name=? AND student_no=?').bind(data.class_name,Number(data.student_no)).first();
    if(!student)fail(403,'기록 또는 복구 코드가 맞지 않습니다.');
    const [salt,digest]=student.recovery_hash.split(':');if(!await same(await codeHash(String(data.code||'').trim().toUpperCase(),salt),digest))fail(403,'기록 또는 복구 코드가 맞지 않습니다.');
    return json({game:await gameState(db,student)},200,{'Set-Cookie':await newSession(db,'student',student.id,url)});
  }
  if(path==='/api/admin/login'){
    if(!env.ADMIN_PASSWORD)fail(403,'서버에 ADMIN_PASSWORD를 설정해야 합니다.');
    const address=req.headers.get('CF-Connecting-IP')||'local';
    const failures=await db.prepare('SELECT count,expires FROM login_failures WHERE address=?').bind(address).first();
    if(failures&&failures.count>=5&&failures.expires>unix())fail(403,'로그인 시도가 너무 많습니다. 15분 뒤 다시 시도하세요.');
    if(!await same(String(data.password||''),env.ADMIN_PASSWORD)){
      await db.prepare('INSERT INTO login_failures(address,count,expires) VALUES(?,1,?) ON CONFLICT(address) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END,expires=?').bind(address,unix()+900,unix(),unix()+900).run();
      fail(403,'암호가 맞지 않습니다.');
    }
    await db.prepare('DELETE FROM login_failures WHERE address=?').bind(address).run();
    return json({ok:true},200,{'Set-Cookie':await newSession(db,'admin',null,url)});
  }
  if(path==='/api/logout'){
    const token=cookieValue(req);if(token)await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await hash(token)).run();
    return json({ok:true},200,{'Set-Cookie':`session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${url.protocol==='https:'?'; Secure':''}`});
  }
  if(path.startsWith('/api/admin/')){await adminAuth(req,db);return adminPost(db,path,data)}
  const student=await studentAuth(req,db),{body:latestBody}=await latest(db);
  if(!latestBody.settings.open)fail(403,'교사가 게임을 종료했습니다.');
  const rid=String(data.request_id||'');if(rid.length<8||rid.length>100)fail(400,'요청 ID가 필요합니다.');
  const cache=await db.prepare('SELECT response FROM requests WHERE student_id=? AND request_id=?').bind(student.id,rid).first();if(cache)return json(parse(cache.response));
  const content=await contentFor(db,student),settings=content.settings,state=parse(student.state),beforeLevel=level(state.views,settings);
  let result;
  if(path==='/api/final/answer'){
    if(!state.completed)fail(400,'본 게임 완료 후 결승에 참여할 수 있습니다.');
    const id=Number(data.final_id),choice=Number(data.choice),row=await db.prepare('SELECT f.body,e.attempts,e.complete FROM final_entries e JOIN finals f ON e.final_id=f.id WHERE e.student_id=? AND e.final_id=?').bind(student.id,id).first();
    if(!row||row.complete)fail(400,'참여할 수 없는 결승 문제입니다.');if(!Number.isInteger(choice)||choice<0||choice>3)fail(400,'선택지를 확인하세요.');
    const q=parse(row.body),correct=choice===q.answer,first=!row.attempts;
    const game=await gameState(db,student,content,state),entry=game.finals.find(f=>f.id===id);
    entry.attempts++;entry.complete=correct;if(first)entry.first_correct=correct?1:0;
    result={correct,first_correct:correct&&first,explanation:q.explanation,game};
    const outcome=await db.batch([
      db.prepare('UPDATE final_entries SET attempts=attempts+1,first_correct=CASE WHEN attempts=0 THEN ? ELSE first_correct END,complete=? WHERE student_id=? AND final_id=? AND attempts=? AND complete=0').bind(correct?1:0,correct?1:0,student.id,id,row.attempts),
      db.prepare('INSERT INTO requests(student_id,request_id,response) SELECT ?,?,? WHERE changes()>0').bind(student.id,rid,JSON.stringify(result))
    ]);
    if(outcome[0].meta.changes!==1)fail(409,'기록이 갱신됐습니다. 새로고침해 주세요.');
    return json(result);
  }
  if(path==='/api/answer'){
    const key=currentKey(state),choice=Number(data.choice);
    if(key!==data.key||['publish','spin','complete'].includes(key))fail(400,'현재 풀 수 있는 문제가 아닙니다.');
    if(!Number.isInteger(choice)||choice<0||choice>3)fail(400,'선택지를 확인하세요.');
    const q=question(content,key),entry=state.attempts[key]||={count:0,wrong:0,first_correct:null,complete:false,first_correct_at:null,completed_at:null,choices:[]};
    entry.count++;entry.choices.push(choice);const correct=choice===q.answer;
    if(entry.count===1){entry.first_correct=correct;if(correct){state.score+=points(key);entry.first_correct_at=now()}}
    if(correct){entry.complete=true;entry.completed_at=now();state.solved.push(key);if(key.startsWith('boss:')){state.boss_stage++;if(state.boss_stage===3){const gain=settings.boss_views*state.pending_multiplier;state.views+=gain;state.pending_multiplier=1;state.completed=true;state.title='전설의 편집장';state.events.push({type:'boss',views:gain,level_from:beforeLevel,level_to:level(state.views,settings)})}}}else entry.wrong++;
    result={correct,explanation:q.explanation,hint:q.hint||'',game:null};
  }else if(path==='/api/publish'){
    if(currentKey(state)!=='publish')fail(400,'아직 발행할 수 없습니다.');
    const rolled=weighted(settings.multipliers).value,applied=Math.max(rolled,state.pending_multiplier),gain=settings.base_views*applied;
    state.views+=gain;state.pending_multiplier=1;state.article++;state.published.push({article:state.article,random_multiplier:rolled,applied_multiplier:applied,views:gain,at:now()});
    result={reward:{type:'publish',views:gain,random_multiplier:rolled,applied_multiplier:applied,level_from:beforeLevel,level_to:level(state.views,settings)},game:null};
  }else if(path==='/api/spin'){
    if(currentKey(state)!=='spin')fail(400,'지금은 룰렛을 돌릴 수 없습니다.');
    const prize={...weighted(settings.roulette)};if(prize.type==='views')state.views+=prize.value;else state.pending_multiplier=Math.max(state.pending_multiplier,prize.value);
    state.roulette[String(state.article)]=prize;result={reward:{type:'spin',prize,level_from:beforeLevel,level_to:level(state.views,settings)},game:null};
  }else fail(404,'지원하지 않는 요청입니다.');
  result.game=await gameState(db,student,content,state);
  const outcome=await db.batch([
    db.prepare('UPDATE students SET state=?,revision=revision+1 WHERE id=? AND revision=?').bind(JSON.stringify(state),student.id,student.revision),
    db.prepare('INSERT INTO requests(student_id,request_id,response) SELECT ?,?,? WHERE changes()>0').bind(student.id,rid,JSON.stringify(result))
  ]);
  if(outcome[0].meta.changes!==1){const existing=await db.prepare('SELECT response FROM requests WHERE student_id=? AND request_id=?').bind(student.id,rid).first();if(existing)return json(parse(existing.response));fail(409,'기록이 갱신됐습니다. 새로고침해 주세요.')}
  return json(result);
}

async function adminPost(db,path,data){
  if(path==='/api/admin/content'){
    validate(data.content);const result=await db.prepare('INSERT INTO content(body,created) VALUES(?,?)').bind(JSON.stringify(data.content),now()).run();return json({version:result.meta.last_row_id});
  }
  if(path==='/api/admin/version/restore'){
    const row=await db.prepare('SELECT body FROM content WHERE id=?').bind(Number(data.version)).first();if(!row)fail(400,'문제 버전을 찾을 수 없습니다.');
    const result=await db.prepare('INSERT INTO content(body,created) VALUES(?,?)').bind(row.body,now()).run();return json({version:result.meta.last_row_id});
  }
  if(path==='/api/admin/award'){
    if(!['star','analysis'].includes(data.kind))fail(400,'시상 부문을 확인하세요.');
    const sid=data.student_id==null?null:Number(data.student_id);if(sid!=null&&!await db.prepare('SELECT 1 FROM students WHERE id=?').bind(sid).first())fail(400,'학생을 찾을 수 없습니다.');
    await db.prepare('INSERT INTO awards(kind,student_id,note) VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET student_id=excluded.student_id,note=excluded.note').bind(data.kind,sid,String(data.note||'').slice(0,200)).run();return json({ok:true});
  }
  if(path==='/api/admin/final'){
    validate({...((await latest(db)).body),finals:[data.question]});
    const latestId=(await latest(db)).id,result=await db.prepare('INSERT INTO finals(content_id,body,created) VALUES(?,?,?)').bind(latestId,JSON.stringify(data.question),now()).run();
    for(const sid of data.student_ids||[])await db.prepare('INSERT OR IGNORE INTO final_entries(student_id,final_id) VALUES(?,?)').bind(Number(sid),result.meta.last_row_id).run();
    return json({id:result.meta.last_row_id});
  }
  if(path==='/api/admin/final/assign'){
    const fid=Number(data.final_id);if(!await db.prepare('SELECT 1 FROM finals WHERE id=?').bind(fid).first())fail(400,'결승 문제를 찾을 수 없습니다.');
    for(const sid of data.student_ids||[])await db.prepare('INSERT OR IGNORE INTO final_entries(student_id,final_id) VALUES(?,?)').bind(Number(sid),fid).run();
    return json({ok:true});
  }
  if(path==='/api/admin/final/edit'||path==='/api/admin/final/delete'){
    const fid=Number(data.final_id);if(await db.prepare('SELECT 1 FROM final_entries WHERE final_id=? AND attempts>0').bind(fid).first())fail(400,'이미 제출된 결승 문제는 수정하거나 삭제할 수 없습니다.');
    if(path.endsWith('/edit')){validate({...((await latest(db)).body),finals:[data.question]});const result=await db.prepare('UPDATE finals SET body=? WHERE id=?').bind(JSON.stringify(data.question),fid).run();if(result.meta.changes!==1)fail(400,'결승 문제를 찾을 수 없습니다.')}
    else await db.batch([db.prepare('DELETE FROM final_entries WHERE final_id=?').bind(fid),db.prepare('DELETE FROM finals WHERE id=?').bind(fid)]);
    return json({ok:true});
  }
  fail(404,'지원하지 않는 요청입니다.');
}

export default {
  async fetch(req,env){
    const url=new URL(req.url),path=url.pathname;
    if(!path.startsWith('/api/'))return env.ASSETS.fetch(req);
    try{
      initPromise ||= init(env.DB).catch(error=>{initPromise=null;throw error});
      await initPromise;
      if(req.method==='GET')return await get(req,env,path,url);
      if(req.method==='POST')return await post(req,env,path,url,await readBody(req));
      return json({error:'지원하지 않는 메서드입니다.'},405);
    }catch(error){
      if(!error.status)console.error('API error',error);
      return json({error:error.status?error.message:'서버 오류가 발생했습니다.'},error.status||500);
    }
  }
};
