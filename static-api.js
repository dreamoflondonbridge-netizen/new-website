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
  for(const student of memoryDb.students){const s=student.state,i=s.article||0;if(s.planning_revision!==3){const oldStage=s.planning_stage||0;if(s.completed)s.planning_stage=4;else if(oldStage>=3){s.planning_stage=2;s.solved=(s.solved||[]).filter(k=>k!=='plan:2');if(s.attempts)delete s.attempts['plan:2']}s.planning_revision=3}if(s.planning_stage===undefined)s.planning_stage=0;delete s.reader_interest;if(s.verification_stage===undefined)s.verification_stage=s.completed?4:0;if(!s.draft_mode){if(i<6&&s.solved?.includes(`article:${i}:select`)&&s.solved?.includes(`article:${i}:effect`))s.article=i+1;s.draft_mode=true}if(!Array.isArray(s.pending_view_claims))s.pending_view_claims=[];const oldQuizClaim=s.pending_view_claims.find(key=>key.startsWith('quiz:'));if(!s.pending_postcard_gift&&oldQuizClaim)s.pending_postcard_gift={key:oldQuizClaim,rewards:Array.from({length:3},()=>Math.floor(Math.random()*49001)+1000)};s.pending_view_claims=s.pending_view_claims.filter(key=>!key.startsWith('plan:')&&!key.startsWith('quiz:'));if(!s.pending_postcard_gift)s.pending_postcard_gift=null;if(s.roulette_pending===undefined)s.roulette_pending=false;if(!Array.isArray(s.pending_article_multipliers))s.pending_article_multipliers=[];if(!Number.isFinite(s.pending_boss_multiplier))s.pending_boss_multiplier=1;if(!Number.isFinite(s.pending_postcards))s.pending_postcards=0;delete s.roulette_events;delete s.pending_multiplier;delete s.pending_multiplier_article}
  save();
  return memoryDb;
}
function save(){localStorage.setItem(DB_KEY,JSON.stringify(memoryDb))}
function makeId(){return window.crypto&&typeof window.crypto.randomUUID==='function'?window.crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`}
function newState(){return {article:0,planning_stage:0,planning_revision:3,verification_stage:0,draft_mode:true,views:0,score:0,solved:[],attempts:{},published:[],pending_view_claims:[],pending_postcard_gift:null,roulette_pending:false,pending_postcards:0,pending_article_multipliers:[],pending_boss_multiplier:1,boss_stage:0,completed:false,events:[]}}
function level(views,settings){let n=1;settings.thresholds.forEach((t,i)=>{if(views>=t)n=i+1});return n}
function unlockedQuizCount(state,content){const published=Math.min(6,state.published?.length||0),milestones=[0,0,0,3,6,8,10];return Math.min(content.quizzes.length,milestones[published])}
function currentKey(s){if((s.planning_stage||0)<4)return `plan:${s.planning_stage||0}`;const n=s.article;if(n<6){if(!s.solved.includes(`article:${n}:select`))return `article:${n}:select`;if(!s.solved.includes(`article:${n}:effect`))return `article:${n}:effect`;return 'publish'}if(s.boss_stage<3)return `boss:${s.boss_stage}`;return (s.verification_stage||0)<4?`verify:${s.verification_stage||0}`:'complete'}
function choose(items){let target=Math.random()*items.reduce((sum,x)=>sum+x.weight,0);for(const item of items){target-=item.weight;if(target<0)return item}return items[items.length-1]}
function question(content,key){const [kind,index,part]=key.split(':');if(kind==='article')return content.articles[+index][part];if(kind==='quiz')return content.quizzes.find(q=>q.after===+index);if(kind==='plan')return content.planning[+index];if(kind==='verify')return content.verification[+index];return content.boss[+index]}
function score(key,q){if(key.startsWith('plan:')||key.startsWith('verify:'))return 0;if(key.startsWith('article:'))return 5;if(key.startsWith('quiz:'))return q?.score??2;return [8,8,9][+key.split(':')[1]]}
function publicContent(content){const out=copyStaticData(content);for(const a of out.articles)for(const k of ['select','effect'])for(const f of ['answer','explanation','hint'])delete a[k][f];for(const q of [...out.quizzes,...out.boss,...(out.planning||[]),...(out.verification||[])])for(const f of ['answer','explanation','hint','score'])delete q[f];return out}
function currentStudent(){const id=localStorage.getItem(SESSION_KEY);return memoryDb.students.find(x=>x.id===id)||null}
function gameView(student){const s=student.state,c=memoryDb.content,visibleState=copyStaticData(s);if(visibleState.pending_postcard_gift)delete visibleState.pending_postcard_gift.rewards;return {profile:{class_name:student.class_name,student_no:student.student_no,nickname:student.nickname},state:visibleState,next:currentKey(s),content:publicContent(c),level:level(s.views,c.settings),unlocked_quizzes:unlockedQuizCount(s,c),finals:[],history:student.history||[]}}
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
  const s=student.state,c=db.content,settings=c.settings,before=level(s.views,settings);let result;if(s.pending_postcard_gift&&path!=='claim_postcard'&&path!=='restart')profileError('독자의 선물 상자를 먼저 골라 주세요.');if(s.roulette_pending&&path!=='spin'&&path!=='restart'&&path!=='claim_postcard')profileError('기사 발행 룰렛을 먼저 돌려 주세요.');
  if(path==='restart'){
    student.history||=[];student.history.push({run:student.history.length+1,views:s.views,score:s.score,completed:s.completed,articles:s.article,boss_stage:s.boss_stage,attempts:Object.values(s.attempts||{}).reduce((n,a)=>n+(a.count||0),0),completed_at:new Date().toISOString()});student.state=newState();result={ok:true,game:gameView(student)};
  }else if(path==='answer'){
    const key=String(body.key||''),quizIndex=c.quizzes.findIndex(q=>q.after===Number(key.split(':')[1])),independentReader=key.startsWith('quiz:')&&quizIndex>=0&&quizIndex<unlockedQuizCount(s,c)&&!s.solved.includes(key);if((currentKey(s)!==key&&!independentReader)||['publish','spin','complete'].includes(key))profileError('엽서는 기사 3편을 발행한 뒤 순서대로 열립니다.');
    const q=question(c,key),submitted=Array.isArray(body.choice)?body.choice.map(Number):[Number(body.choice)],multi=Array.isArray(q?.answer);if(!q||!submitted.length||submitted.some(x=>!Number.isInteger(x)||x<0||x>=q.choices.length)||new Set(submitted).size!==submitted.length||(!multi&&submitted.length!==1))profileError('선택지를 확인하세요.');const choice=multi?submitted:submitted[0],entry=s.attempts[key]||={count:0,wrong:0,first_correct:null,complete:false,first_correct_at:null,completed_at:null,choices:[]};
    entry.count++;entry.choices.push(choice);const correct=multi?submitted.length===q.answer.length&&q.answer.every(x=>submitted.includes(x)):choice===q.answer;if(entry.count===1){entry.first_correct=correct;if(correct){s.score+=score(key,q);entry.first_correct_at=new Date().toISOString()}}
    let article_multiplier=1,view_penalty=0;if(correct){entry.complete=true;entry.completed_at=new Date().toISOString();s.solved.push(key);if(!key.startsWith('plan:')&&!key.startsWith('quiz:'))s.pending_view_claims.push(key);if(key.startsWith('quiz:'))s.pending_postcard_gift={key,rewards:Array.from({length:3},()=>Math.floor(Math.random()*49001)+1000)};if(key.startsWith('plan:'))s.planning_stage++;if(key.startsWith('verify:'))s.verification_stage++;if(key.startsWith('article:')&&key.endsWith(':effect')){const article=Number(key.split(':')[1]),rolled=choose(settings.multipliers).value,pending=s.pending_article_multipliers.find(x=>x.article===article);article_multiplier=Math.max(rolled,pending?.value||1);if(pending){pending.value=article_multiplier;pending.random_multiplier=rolled}else s.pending_article_multipliers.push({article,value:article_multiplier,random_multiplier:rolled});s.article=Math.min(6,s.article+1)}if(key.startsWith('boss:'))s.boss_stage++;if(key.startsWith('verify:')&&s.verification_stage===4){s.completed=true;s.title='전설의 편집장'}}else{entry.wrong++;const requestedPenalty=(Math.floor(Math.random()*9)+1)*100;view_penalty=Math.min(s.views,requestedPenalty);s.views-=view_penalty;s.events.push({type:'wrong_answer',key,views:-view_penalty,at:new Date().toISOString()})}
    result={correct,view_penalty,article_multiplier,level_from:before,level_to:level(s.views,settings),explanation:q.explanation,hint:q.hint||'',game:null};
  }else if(path==='claim_postcard'){
    const key=String(body.key||''),box=Number(body.box),gift=s.pending_postcard_gift;if(!gift||gift.key!==key||!Number.isInteger(box)||box<0||box>=3)profileError('열 수 있는 독자 선물 상자가 없습니다.');const views=gift.rewards[box];s.views+=views;s.pending_postcard_gift=null;s.events.push({type:'postcard_gift',key,box,views,at:new Date().toISOString()});result={reward:{type:'postcard_gift',views,box,level_from:before,level_to:level(s.views,settings)},game:null};
  }else if(path==='claim'){
    const key=String(body.key||'');let views=Number(body.views);if(!s.pending_view_claims.includes(key))profileError('이미 조회수를 받았거나 진행 중인 획득 기회가 없습니다.');if(!Number.isSafeInteger(views)||views<1||views>50000)profileError('그래프에서 획득할 조회수를 확인해 주세요.');let applied_multiplier=1;if(key.startsWith('article:')&&key.endsWith(':effect')){const article=Number(key.split(':')[1]),pending=s.pending_article_multipliers.find(x=>x.article===article);applied_multiplier=pending?.value||1;s.pending_article_multipliers=s.pending_article_multipliers.filter(x=>x.article!==article)}else if(key.startsWith('boss:')&&s.pending_boss_multiplier>1){applied_multiplier=s.pending_boss_multiplier;s.pending_boss_multiplier=1}views=Math.round(views*applied_multiplier);s.pending_view_claims=s.pending_view_claims.filter(x=>x!==key);s.views+=views;s.events.push({type:'view_graph',key,views,applied_multiplier,at:new Date().toISOString()});result={reward:{type:'view_graph',views,applied_multiplier,level_from:before,level_to:level(s.views,settings)},game:null};
  }else if(path==='publish'){
    const pending=Math.max(0,s.article-s.published.length);if(!pending)profileError('발행할 기사가 아직 없습니다.');const unlockedBefore=unlockedQuizCount(s,c),articleIndex=s.published.length;s.published.push({article:articleIndex+1,views:0,at:new Date().toISOString()});s.roulette_pending=true;s.pending_postcards=unlockedQuizCount(s,c)-unlockedBefore;result={reward:{type:'publish',article_count:1,views:0,postcards_unlocked:s.pending_postcards,roulette_pending:true,level_from:before,level_to:level(s.views,settings)},game:null};
  }else if(path==='spin'){
    if(!s.roulette_pending)profileError('지금 돌릴 수 있는 룰렛이 없습니다.');const prizes=settings.roulette||[],prize=choose(prizes),prize_index=prizes.indexOf(prize);let views_delta=0,multiplier_target='';if(prize.type==='views'){views_delta=prize.value;s.views+=views_delta}else if(prize.type==='penalty'){views_delta=-Math.min(s.views,prize.value);s.views+=views_delta}else if(prize.type==='multiplier'){if(s.published.length<6){const article=s.published.length,old=s.pending_article_multipliers.find(x=>x.article===article);if(old)old.value=Math.max(old.value,prize.value);else s.pending_article_multipliers.push({article,value:prize.value});multiplier_target=`기사 ${article+1} 제작 조회수`}else{s.pending_boss_multiplier=Math.max(s.pending_boss_multiplier||1,prize.value);multiplier_target='최종 보스전 그래프'}}s.roulette_pending=false;s.events.push({type:'roulette',article:s.published.length,prize:{...prize},views:views_delta,at:new Date().toISOString()});result={reward:{type:'roulette',prize:{...prize},prize_index,views_delta,multiplier_target,postcards_unlocked:s.pending_postcards||0,level_from:before,level_to:level(s.views,settings)},game:null};s.pending_postcards=0;
  }else profileError('지원하지 않는 요청입니다.');
  result.game=gameView(student);db.requests[student.id]||={};if(rid)db.requests[student.id][rid]=copyStaticData(result);save();return result;
};
