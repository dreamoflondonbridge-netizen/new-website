const DB_KEY='newsroom-static-v1';
const SESSION_KEY='newsroom-session-v1';
function copyStaticData(value){return typeof window.structuredClone==='function'?window.structuredClone(value):JSON.parse(JSON.stringify(value))}
let memoryDb;

async function loadDb(){
  if(memoryDb)return memoryDb;
  try{memoryDb=JSON.parse(localStorage.getItem(DB_KEY)||'null')}catch{}
  const response=await fetch(new URL('./seed.json',location.href),{cache:'no-store'});if(!response.ok)throw Error('게임 자료를 불러오지 못했습니다.');const published=await response.json();
  if(!memoryDb)memoryDb={content:published,publishedVersion:published.version||1,students:[],requests:{}};
  else if(memoryDb.publishedVersion!==(published.version||1)){memoryDb.content=published;memoryDb.publishedVersion=published.version||1}
  for(const student of memoryDb.students){const s=student.state,i=s.article||0;if(s.planning_revision!==3){const oldStage=s.planning_stage||0;if(s.completed)s.planning_stage=4;else if(oldStage>=3){s.planning_stage=2;s.solved=(s.solved||[]).filter(k=>k!=='plan:2');if(s.attempts)delete s.attempts['plan:2']}s.planning_revision=3}if(s.planning_stage===undefined)s.planning_stage=0;if(s.reader_interest===undefined)s.reader_interest=Number(!!s.attempts?.['plan:0']?.first_correct)+Number(!!s.attempts?.['plan:1']?.first_correct);if(s.verification_stage===undefined)s.verification_stage=s.completed?4:0;if(!s.draft_mode){if(i<6&&s.solved?.includes(`article:${i}:select`)&&s.solved?.includes(`article:${i}:effect`))s.article=i+1;s.draft_mode=true}if(s.pending_multiplier_article===undefined)s.pending_multiplier_article=s.pending_multiplier>1?i:null;if(!Array.isArray(s.pending_article_multipliers)){s.pending_article_multipliers=[];if(s.pending_multiplier>1)s.pending_article_multipliers.push({article:s.pending_multiplier_article??i,value:s.pending_multiplier})}if(s.roulette_pending===undefined)s.roulette_pending=s.article>=1&&s.article<=6&&s.solved?.includes(`quiz:${s.article}`)&&!Object.prototype.hasOwnProperty.call(s.roulette||{},String(s.article));if(!Array.isArray(s.roulette_events))s.roulette_events=[]}
  save();
  return memoryDb;
}
function save(){localStorage.setItem(DB_KEY,JSON.stringify(memoryDb))}
function makeId(){return window.crypto&&typeof window.crypto.randomUUID==='function'?window.crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`}
function newState(){return {article:0,planning_stage:0,planning_revision:3,reader_interest:0,verification_stage:0,draft_mode:true,views:0,score:0,solved:[],attempts:{},published:[],roulette:{},roulette_pending:false,roulette_events:[],pending_multiplier:1,pending_multiplier_article:null,pending_article_multipliers:[],boss_stage:0,completed:false,events:[]}}
function syncPendingMultiplier(s){const list=s.pending_article_multipliers||[];s.pending_multiplier=list.length?Math.max(...list.map(x=>x.value)):1;s.pending_multiplier_article=list.length?list[list.length-1].article:null}
function level(views,settings){let n=1;settings.thresholds.forEach((t,i)=>{if(views>=t)n=i+1});return n}
function currentKey(s){if((s.planning_stage||0)<4)return `plan:${s.planning_stage||0}`;const n=s.article;if(n<6){if(!s.solved.includes(`article:${n}:select`))return `article:${n}:select`;if(!s.solved.includes(`article:${n}:effect`))return `article:${n}:effect`;return 'publish'}if(s.boss_stage<3)return `boss:${s.boss_stage}`;return (s.verification_stage||0)<4?`verify:${s.verification_stage||0}`:'complete'}
function choose(items){let target=Math.random()*items.reduce((sum,x)=>sum+x.weight,0);for(const item of items){target-=item.weight;if(target<0)return item}return items[items.length-1]}
function question(content,key){const [kind,index,part]=key.split(':');if(kind==='article')return content.articles[+index][part];if(kind==='quiz')return content.quizzes.find(q=>q.after===+index);if(kind==='plan')return content.planning[+index];if(kind==='verify')return content.verification[+index];return content.boss[+index]}
function score(key,q){if(key.startsWith('plan:')||key.startsWith('verify:'))return 0;if(key.startsWith('article:'))return 5;if(key.startsWith('quiz:'))return q?.score??2;return [8,8,9][+key.split(':')[1]]}
function publicContent(content){const out=copyStaticData(content);for(const a of out.articles)for(const k of ['select','effect'])for(const f of ['answer','explanation','hint'])delete a[k][f];for(const q of [...out.quizzes,...out.boss,...(out.planning||[]),...(out.verification||[])])for(const f of ['answer','explanation','hint','score'])delete q[f];return out}
function currentStudent(){const id=localStorage.getItem(SESSION_KEY);return memoryDb.students.find(x=>x.id===id)||null}
function gameView(student){const s=student.state,c=memoryDb.content;return {profile:{class_name:student.class_name,student_no:student.student_no,nickname:student.nickname},state:s,next:currentKey(s),content:publicContent(c),level:level(s.views,c.settings),finals:[],history:student.history||[]}}
function profileError(text){throw Error(text)}

window.staticApi=async function(path,body){
  const db=await loadDb();memoryDb=db;
  if(path==='bootstrap'){const student=currentStudent();return {classes:db.content.classes,game_open:db.content.settings.open,game:student?gameView(student):null,admin:false}}
  if(path==='admin/state')return {version:db.content.version||1,content:copyStaticData(db.content),students:[],awards:[],finals:[],versions:[]};
  if(path==='admin/content'){
    db.content=copyStaticData(body.content);db.content.version=(memoryDb.content.version||1)+1;save();return {version:db.content.version};
  }
  if(path==='register'){
    if(!db.content.settings.open)profileError('게임 시작이 닫혀 있습니다.');
    const cls=String(body.class_name),num=Number(body.student_no),nickname=String(body.nickname||'').trim().slice(0,20);
    if(!db.content.classes.includes(cls)||num<1||num>37||!nickname)profileError('반, 번호, 닉네임을 확인하세요.');
    if(db.students.some(x=>x.class_name===cls&&x.student_no===num))profileError('이 브라우저에 해당 번호의 기록이 있습니다. 이어서 접속을 선택하세요.');
    const code=`${makeId().replace(/-/g,'').slice(0,8)}-${makeId().replace(/-/g,'').slice(0,8)}`.toUpperCase();
    const student={id:makeId(),class_name:cls,student_no:num,nickname,recovery_code:code,state:newState()};db.students.push(student);localStorage.setItem(SESSION_KEY,student.id);save();return {recovery_code:code,game:gameView(student)};
  }
  if(path==='recover'){
    const student=db.students.find(x=>x.class_name===body.class_name&&x.student_no===Number(body.student_no)&&x.recovery_code===String(body.code||'').trim().toUpperCase());
    if(!student)profileError('반, 번호 또는 복구 코드가 맞지 않습니다.');localStorage.setItem(SESSION_KEY,student.id);return {game:gameView(student)};
  }
  if(path==='logout'){localStorage.removeItem(SESSION_KEY);return {ok:true}}
  const student=currentStudent();if(!student)profileError('학생 등록 또는 기록 복구가 필요합니다.');
  if(!db.content.settings.open)profileError('교사가 게임을 종료했습니다.');
  const rid=String(body?.request_id||'');if(rid&&db.requests[student.id]?.[rid])return db.requests[student.id][rid];
  const s=student.state,c=db.content,settings=c.settings,before=level(s.views,settings);let result;
  if(path==='restart'){
    student.history||=[];student.history.push({run:student.history.length+1,views:s.views,score:s.score,completed:s.completed,articles:s.article,boss_stage:s.boss_stage,attempts:Object.values(s.attempts||{}).reduce((n,a)=>n+(a.count||0),0),completed_at:new Date().toISOString()});student.state=newState();result={ok:true,game:gameView(student)};
  }else if(path==='answer'){
    const key=String(body.key||''),independentReader=key.startsWith('quiz:')&&c.quizzes.some(q=>q.after===Number(key.split(':')[1]))&&!s.solved.includes(key);if((currentKey(s)!==key&&!independentReader)||['publish','spin','complete'].includes(key))profileError('현재 풀 수 있는 문제가 아닙니다.');
    const q=question(c,key),submitted=Array.isArray(body.choice)?body.choice.map(Number):[Number(body.choice)],multi=Array.isArray(q?.answer);if(!q||!submitted.length||submitted.some(x=>!Number.isInteger(x)||x<0||x>=q.choices.length)||new Set(submitted).size!==submitted.length||(!multi&&submitted.length!==1))profileError('선택지를 확인하세요.');const choice=multi?submitted:submitted[0],entry=s.attempts[key]||={count:0,wrong:0,first_correct:null,complete:false,first_correct_at:null,completed_at:null,choices:[]};
    entry.count++;entry.choices.push(choice);const correct=multi?submitted.length===q.answer.length&&q.answer.every(x=>submitted.includes(x)):choice===q.answer;let interest_increased=false;if(entry.count===1){entry.first_correct=correct;if(correct){s.score+=score(key,q);entry.first_correct_at=new Date().toISOString();if(key==='plan:0'||key==='plan:1'){s.reader_interest=Math.min(2,(s.reader_interest||0)+1);interest_increased=true}}}
    let view_penalty=0;if(correct){entry.complete=true;entry.completed_at=new Date().toISOString();s.solved.push(key);if(key.startsWith('plan:'))s.planning_stage++;if(key.startsWith('verify:'))s.verification_stage++;if(key.startsWith('article:')&&key.endsWith(':effect'))s.article=Math.min(6,s.article+1);if(key.startsWith('boss:')){s.boss_stage++;if(s.boss_stage===3){const list=s.pending_article_multipliers||[],idx=list.findIndex(x=>x.article===6),bonus=idx>=0?list[idx].value:(s.pending_multiplier_article===6?s.pending_multiplier:1),interest_percent=(s.reader_interest||0)*10,gain=Math.round(settings.boss_views*bonus*(1+interest_percent/100));s.views+=gain;if(idx>=0)list.splice(idx,1);syncPendingMultiplier(s);s.events.push({type:'boss',views:gain,level_from:before,level_to:level(s.views,settings)})}}if(key.startsWith('verify:')&&s.verification_stage===4){s.completed=true;s.title='전설의 편집장'}}else{entry.wrong++;const requestedPenalty=(Math.floor(Math.random()*10)+1)*500;view_penalty=Math.min(s.views,requestedPenalty);s.views-=view_penalty;s.events.push({type:'wrong_answer',key,views:-view_penalty,at:new Date().toISOString()})}
    const roulette_popup=correct&&(key.startsWith('article:')||key.startsWith('quiz:'))&&!s.roulette_pending&&Math.random()<.25;if(roulette_popup)s.roulette_pending=true;
    result={correct,view_penalty,roulette_popup,interest_increased,reader_interest:s.reader_interest||0,explanation:q.explanation,hint:q.hint||'',game:null};
  }else if(path==='publish'){
    const pending=Math.max(0,s.article-s.published.length);if(!pending)profileError('발행할 기사가 아직 없습니다.');const articleIndex=s.published.length,rolled=choose(settings.multipliers).value,list=s.pending_article_multipliers||[],bonusIndex=list.findIndex(x=>x.article===articleIndex),bonus=bonusIndex>=0?list[bonusIndex].value:(s.pending_multiplier_article===articleIndex?s.pending_multiplier:1),applied=Math.max(rolled,bonus),interest_percent=(s.reader_interest||0)*10,gain=Math.round(settings.base_views*applied*(1+interest_percent/100));s.published.push({article:articleIndex+1,random_multiplier:rolled,applied_multiplier:applied,views:gain,at:new Date().toISOString()});if(bonusIndex>=0)list.splice(bonusIndex,1);s.views+=gain;syncPendingMultiplier(s);result={reward:{type:'publish',article_count:1,views:gain,random_multipliers:[rolled],applied_multipliers:[applied],interest_percent,level_from:before,level_to:level(s.views,settings)},game:null};
  }else if(path==='spin'){
    if(!s.roulette_pending)profileError('지금은 룰렛을 돌릴 수 없습니다.');const prize={...choose(settings.roulette)};if(prize.type==='views')s.views+=prize.value;else{const list=s.pending_article_multipliers||=[],existing=list.find(x=>x.article===s.article);if(existing)existing.value=Math.max(existing.value,prize.value);else list.push({article:s.article,value:prize.value});s.pending_article_multipliers=list;syncPendingMultiplier(s)}s.roulette_pending=false;s.roulette_events||=[];s.roulette_events.push({article:s.article,prize,at:new Date().toISOString()});result={reward:{type:'spin',prize,level_from:before,level_to:level(s.views,settings)},game:null};
  }else profileError('지원하지 않는 요청입니다.');
  result.game=gameView(student);db.requests[student.id]||={};if(rid)db.requests[student.id][rid]=copyStaticData(result);save();return result;
};
