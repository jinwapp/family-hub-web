// 우리 집 웹 화면. iOS 앱(ios/FamilyHub)을 그대로 옮겼다. 빌드 도구 없이 정적 파일로 GitHub Pages 에 올린다.
// 서버 주소는 같은 폴더의 api.txt 에서 읽는다 (맥미니가 터널을 켤 때마다 새 주소로 바꾼다).
import { html, render, useState, useEffect, useRef } from 'https://unpkg.com/htm@3.1.1/preact/standalone.module.js'

// ───────── 서버 ─────────
let API = ''
async function api(method, path, body, timeout = 20000) {
  if (!API) {
    try { API = (await (await fetch('api.txt', { cache: 'no-store' })).text()).trim().replace(/\/$/, '') } catch { return { status: 0 } }
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const headers = {}
    if (S.token) headers.Authorization = 'Bearer ' + S.token
    if (body) headers['Content-Type'] = 'application/json'
    const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal })
    let json = null
    try { json = await res.json() } catch {}
    return { status: res.status, json }
  } catch {
    API = '' // 터널 주소가 바뀌었을 수 있다 → 다음에 api.txt 를 다시 읽는다
    return { status: 0 }
  } finally { clearTimeout(timer) }
}

// ───────── 상태 (AppModel.swift) ─────────
const OFFLINE = '오프라인이에요. 보이는 목록은 마지막으로 받은 내용이에요'
const store = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch {} }
const load = k => { try { return localStorage.getItem(k) } catch { return null } }
const S = {
  token: load('token'), me: null, tasks: [], checklists: {}, members: [], contacts: [], facts: [], shopping: [], shifts: [], devices: [],
  message: null, undoNote: null, weather: null, briefing: null, homePlace: null, push: null,
  chat: [], pending: null, thinking: false, draft: '', listening: false, heard: '', micDenied: false,
}
let rerender = () => {}
const set = p => { Object.assign(S, p); rerender() }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const uid = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => ((Math.random() * 16) | (c === 'x' ? 0 : 8)).toString(16))
const isGuardian = () => S.me?.role === 'GUARDIAN' && !!S.me?.memberId
const isTablet = () => S.me?.kind === 'TABLET'
const nameOf = id => S.members.find(m => m.id === id)?.name
const colorIdx = id => { const i = S.members.findIndex(m => m.id === id); return i < 0 ? null : i }
const MEMBER_COLORS = ['#2b8be6', '#7c5ce6', '#e0559c', '#2fa36c', '#e07a12']
const memberColor = i => MEMBER_COLORS[i % MEMBER_COLORS.length]
/** 받침이 있으면 "을", 없으면 "를" */
const obj = w => { const c = w.charCodeAt(w.length - 1); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0 ? '을' : '를' }
const subj = w => obj(w) === '을' ? '이' : '가'

let msgToken = 0
function setMessage(m) {
  const t = ++msgToken
  set({ message: m })
  if (m && m !== OFFLINE) setTimeout(() => { if (msgToken === t) set({ message: null }) }, 8000)
}

let gen = 0 // 다시 등록하면 앞 기기의 감시 루프를 멈춘다
function logout() {
  store('token', null); gen++
  set({ token: null, me: null, tasks: [], checklists: {}, members: [], contacts: [], facts: [], shopping: [], shifts: [], devices: [], undoNote: null, message: null, weather: null, chat: [], pending: null })
}

async function pair(code) {
  const r = await api('POST', '/pair', { code: code.trim().toUpperCase() })
  if (r.status === 200) { store('token', r.json.token); S.token = r.json.token; await refresh(); start() }
  else if (r.status === 0) setMessage('서버에 닿지 않아요. 맥미니가 켜져 있는지 확인해 주세요')
  else setMessage(r.json?.reason || '등록하지 못했어요')
}

async function refresh() {
  if (!S.token) return
  if (!S.me) {
    const r = await api('GET', '/me')
    if (r.status === 401) return logout()
    if (r.status === 200) S.me = r.json
  }
  if (S.me) {
    const get = async (p, k) => { const r = await api('GET', p); return r.status === 200 ? r.json[k] : null }
    const [contacts, facts, shopping, shifts] = await Promise.all([get('/contacts', 'contacts'), get('/memory', 'facts'), get('/shopping', 'items'), get('/attendance', 'shifts')])
    if (contacts) S.contacts = contacts
    if (facts) S.facts = facts
    if (shopping) S.shopping = shopping
    if (shifts) S.shifts = shifts
    if (isGuardian()) { const d = await get('/devices', 'devices'); if (d) S.devices = d }
  }
  const m = await api('GET', '/members')
  if (m.status === 200) S.members = m.json.members
  const t = await api('GET', '/tasks')
  if (t.status === 200) {
    S.tasks = t.json.tasks; S.checklists = t.json.checklists || {}
    if (S.message === OFFLINE) S.message = null
  } else if (t.status === 401) return logout()
  else S.message = OFFLINE
  rerender()
}

/** 다른 기기에서 바뀐 것을 바로 받는다 (long polling) */
async function watchChanges(g) {
  let since = -1
  while (g === gen && S.token) {
    const r = await api('GET', '/changes?since=' + since, null, 35000)
    if (g !== gen) return
    if (r.status === 200) { if (r.json.version !== since) { since = r.json.version; await refresh() } }
    else if (r.status === 401) return logout()
    else await sleep(5000)
  }
}

function handle(r) {
  if (r.status === 401) { logout(); return false }
  const st = r.json?.status
  if (st === 'done') { setMessage(null); return true }
  if (st === 'needs_confirm') setMessage('확인이 필요한 일이에요')
  else if (r.status === 0) setMessage('오프라인이라 지금은 처리하지 못했어요')
  else setMessage(r.json?.reason || '처리하지 못했어요')
  return false
}

/** 쓰기. confirmed: 화면에서 이미 확인을 받은 일 */
async function act(tool, args, { confirmed = false, note } = {}) {
  const r = await api('POST', '/commands', { tool, args, confirmed })
  const done = handle(r)
  await refresh()
  if (done && note) showUndo(note)
  return done
}

/** 실패를 화면에 알린다 (가족 관리) */
function report(r) {
  if (r.status === 401) return logout()
  if (r.status === 0) setMessage('오프라인이라 지금은 처리하지 못했어요')
  else if (r.status >= 400) setMessage(r.json?.reason || '처리하지 못했어요')
}

let undoToken = 0, undoCount = 1
function showUndo(note, count = 1) {
  const t = ++undoToken; undoCount = count
  set({ undoNote: note })
  setTimeout(() => { if (undoToken === t) set({ undoNote: null }) }, 5000)
}
async function undo() {
  for (let i = 0; i < Math.max(1, undoCount); i++) handle(await api('POST', '/undo'))
  set({ undoNote: null })
  await refresh()
}

const complete = t => act('tasks.complete', { id: t.id, expectedVersion: t.version }, { note: `${t.title}${obj(t.title)} 끝냄으로 바꿨어요` })
const reopen = t => act('tasks.reopen', { id: t.id, expectedVersion: t.version })

// ───────── 비서 ─────────
const YES = ['응', '네', '그래', '좋아', '해 줘', '해줘', '응 해 줘', '응 해줘', '어']
const NO = ['아니', '아니야', '아냐', '취소', '하지 마', '하지마', '됐어']

/** 지금 있는 곳 (대략). 3초 안에 못 받으면 없이 보낸다 → 서버가 집 날씨로 답한다 */
function here() {
  return new Promise(ok => {
    if (!navigator.geolocation) return ok(null)
    const t = setTimeout(() => ok(null), 3000)
    navigator.geolocation.getCurrentPosition(
      p => { clearTimeout(t); ok({ lat: p.coords.latitude, lon: p.coords.longitude }) },
      () => { clearTimeout(t); ok(null) },
      { enableHighAccuracy: false, maximumAge: 600000, timeout: 3000 })
  })
}

function card(actions) {
  if (!actions?.length) return null
  const arg = (a, k) => a.args?.[k] != null ? String(a.args[k]) : null
  if (actions.length > 1) return { title: actions.map(a => arg(a, 'title') ?? arg(a, 'name') ?? arg(a, 'text') ?? a.tool).join(' · '), meta: `${actions.length}가지 했어요` }
  const a = actions[0]
  const name = arg(a, 'title') ?? arg(a, 'name') ?? arg(a, 'text') ?? ''
  const due = arg(a, 'dueDate')
  const what = {
    'tasks.create': '할 일에 넣음' + (due ? ` · ${due.slice(5).replace('-', '/')}까지` : ''),
    'tasks.create_for': '할 일을 만들어 맡김', 'tasks.complete': '끝냄', 'tasks.assign': '담당 바꿈',
    'shopping.add': '장보기에 넣음', 'memory.remember': '기억해 둠',
    'attendance.in': '이모님 출근 기록', 'attendance.out': '이모님 퇴근 기록', 'attendance.edit': '이모님 출퇴근 시각 고침',
  }[a.tool] ?? '했어요'
  return name ? { title: name, meta: what } : { title: what, meta: '' }
}

const say = (mine, text, c = null) => { S.chat = [...S.chat, { id: uid(), mine, text, card: c }] }

async function ask(text) {
  if (S.thinking) return
  if (S.pending) {
    const t = text.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
    if (YES.includes(t)) return answer(true)
    if (NO.includes(t)) return answer(false)
  }
  const history = S.chat.slice(-60).map(l => ({ mine: l.mine, text: l.text }))
  say(true, text)
  set({ pending: null, thinking: true })
  const pos = await here()
  const r = await api('POST', '/assistant', { text, history, ...(pos || {}) }, 70000)
  S.thinking = false
  if (r.status === 200) {
    const res = r.json
    say(false, res.reply, card(res.done))
    if (res.status === 'needs_confirm') S.pending = res
    rerender()
    if (res.done?.length) showUndo(res.reply, res.done.length)
    await refresh()
  } else if (r.status === 401) return logout()
  else { say(false, r.status === 0 ? '맥미니에 닿지 않아요. 잠시 뒤에 다시 말해 주세요' : (r.json?.reason || '처리하지 못했어요')); rerender() }
}

async function answer(yes) {
  const p = S.pending
  if (!p?.actions?.length) return
  S.pending = null
  say(true, yes ? '응' : '아니')
  if (!yes) { say(false, '알겠어요, 그만둘게요'); return rerender() }
  rerender()
  const done = [], notes = []
  for (const a of p.actions) {
    const r = await api('POST', '/commands', { tool: a.tool, args: a.args, confirmed: true })
    if (r.json?.status === 'done') done.push(a)
    else notes.push(r.json?.reason || '하지 못한 일이 있어요')
  }
  const text = [...(done.length ? ['했어요'] : []), ...new Set(notes)].join(' ')
  say(false, text, card(done))
  rerender()
  if (done.length) showUndo('비서가 한 일을 되돌릴 수 있어요', done.length)
  await refresh()
}

function newChat() { cancelVoice(); set({ chat: [], pending: null, draft: '' }) }

// ───────── 음성 (Voice.swift) ─────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition
let rec = null, committed = '', stopping = false, discard = false

/** 받아쓰기: 누르면 시작, 말하는 대로 입력칸에 쌓인다. 다시 누르면 멈춘다(보내지 않는다) */
function startVoice() {
  if (S.listening || S.thinking) return
  if (!SR) return setMessage('이 브라우저는 음성 인식을 못 해요. 글자로 써 주세요')
  try { speechSynthesis.cancel() } catch {}
  committed = ''; stopping = false; discard = false
  set({ listening: true, heard: '', micDenied: false })
  const go = () => {
    rec = new SR()
    rec.lang = 'ko-KR'; rec.continuous = true; rec.interimResults = true
    rec.onresult = e => {
      let now = ''
      for (const r of e.results) now += r[0].transcript
      S.heard = [committed, now.trim()].filter(Boolean).join(' ')
      rerender()
    }
    rec.onerror = e => { if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) { stopping = true; discard = true; S.micDenied = true } }
    // 말이 끊기면 브라우저가 듣기를 끝낸다 → 사람이 멈출 때까지 다시 듣고 앞말을 이어 붙인다
    rec.onend = () => { if (!stopping) { committed = S.heard; try { go() } catch { finishVoice() } } else finishVoice() }
    rec.start()
  }
  try { go() } catch { stopping = true; finishVoice() }
}
function finishVoice() {
  const t = discard ? '' : S.heard.trim()
  rec = null
  set({ listening: false, heard: '', draft: t ? (S.draft ? S.draft + ' ' + t : t) : S.draft })
}
function stopVoice() { stopping = true; if (rec) rec.stop(); else finishVoice() }
function cancelVoice() { if (!S.listening) return; stopping = true; discard = true; if (rec) rec.abort(); else finishVoice() }

function speak(text) {
  return new Promise(done => {
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'ko-KR'; u.onend = done; u.onerror = done
      speechSynthesis.speak(u)
    } catch { done() }
  })
}
/** iOS 는 사람이 누른 뒤에만 소리를 낸다 → 누를 때 빈 말을 한 번 해 둔다 */
function unlockSpeech() { try { speechSynthesis.speak(new SpeechSynthesisUtterance('')) } catch {} }

async function sendDraft() {
  const t = S.draft.trim()
  if (!t || S.thinking || S.listening) return
  unlockSpeech()
  const before = S.chat.length
  set({ draft: '' })
  await ask(t)
  // 태블릿은 답을 소리 내어 읽는다
  const last = S.chat[S.chat.length - 1]
  if (isTablet() && S.chat.length > before && last && !last.mine) speak(last.text)
}

// ───────── 마감 알림 (Reminders.swift → 서버 Web Push) ─────────
// 서버가 매일 9시에 내 담당 할 일의 "오늘까지"·"내일 마감"을 보낸다. iPhone 은 홈 화면에 추가한 앱에서만 받는다 (iOS 16.4+)
const pushable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const b64bytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0))

async function subscribePush() {
  try {
    const reg = await navigator.serviceWorker.ready
    const k = await api('GET', '/push-key')
    if (k.status !== 200) return
    const key = b64bytes(k.json.publicKey)
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) }
      catch { const old = await reg.pushManager.getSubscription(); if (old) await old.unsubscribe(); sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) }
    }
    const j = sub.toJSON()
    const r = await api('POST', '/push-subscription', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth })
    set({ push: r.status === 204 ? 'on' : 'off' })
  } catch { set({ push: 'off' }) }
}

/** 사람이 "켜기"를 눌렀을 때 (iOS 는 누른 순간에만 권한을 물을 수 있다) */
async function enablePush() {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return set({ push: 'denied' })
  await subscribePush()
}

function startPush() {
  if (!pushable()) return set({ push: 'unsupported' })
  navigator.serviceWorker.register('sw.js').catch(() => {})
  if (Notification.permission === 'granted') subscribePush() // 이미 켰으면 조용히 다시 알린다 (서버 키·기기가 바뀌었을 수 있다)
  else set({ push: Notification.permission === 'denied' ? 'denied' : 'off' })
}

function PushBanner() {
  if (S.push === 'off') return html`<div class="glass banner"><span>마감 알림을 받으려면 켜 주세요 (매일 오전 9시)</span><button class="pill primary" onClick=${enablePush}>알림 켜기</button></div>`
  if (S.push === 'denied') return html`<p class="muted small banner-text">알림이 꺼져 있어요. 설정 > 알림에서 켜면 마감 알림을 받아요</p>`
  if (S.push === 'unsupported') return html`<p class="muted small banner-text">Safari 공유 버튼 → "홈 화면에 추가"로 열면 마감 알림을 받을 수 있어요</p>`
  return null
}

// ───────── 날짜 ─────────
const pad = n => String(n).padStart(2, '0')
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const WEEK = ['일', '월', '화', '수', '목', '금', '토']
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d) }
const dayTitle = k => { const d = fromKey(k); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})` }
function dueLabel(due) {
  if (!due) return ''
  const now = new Date()
  if (due === dayKey(now)) return '오늘'
  if (due === dayKey(addDays(now, 1))) return '내일'
  return due.slice(5).replace('-', '/')
}
const doneToday = t => t.status === 'DONE' && t.completedAt && dayKey(new Date(t.completedAt)) === dayKey(new Date())
const toInput = ms => { const d = new Date(ms); return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}` }
const openShift = () => S.shifts.find(s => s.outAt == null)

// ───────── 아이콘 ─────────
const I = {
  mic: html`<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>`,
  stop: html`<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
  up: html`<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  plus: html`<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  x: html`<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  check: html`<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>`,
  left: html`<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>`,
  right: html`<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>`,
  grid: html`<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/></svg>`,
}

// ───────── 공통 조각 ─────────
const Message = () => S.message ? html`<p class="message">${S.message}</p>` : null

function Assignee({ task, size = 15 }) {
  const i = colorIdx(task.assigneeId)
  return html`<span class="assignee" style=${{ fontSize: size + 'px' }}>
    ${i != null ? html`<i class="dot" style=${{ background: memberColor(i) }}></i>` : html`<i class="dot hollow"></i>`}
    ${nameOf(task.assigneeId) ?? '우리 집'}</span>`
}

function CheckCircle({ task, size = 30 }) {
  const done = task.status === 'DONE'
  return html`<button class=${'check' + (done ? ' on' : '')} style=${{ width: size + 'px', height: size + 'px', fontSize: size * 0.5 + 'px' }}
    aria-label=${done ? `${task.title} 끝냄, 누르면 되살려요` : `${task.title} 끝내기`}
    onClick=${() => done ? reopen(task) : complete(task)}>${done ? I.check : ''}</button>`
}

function UndoToast() {
  if (!S.undoNote) return null
  return html`<div class="toast" role="status"><span class="ok">${I.check}</span><span class="note">${S.undoNote}</span>
    <button class="pill primary" onClick=${undo}>방금 거 취소</button></div>`
}

function Modal({ title, onClose, children, actions }) {
  return html`<div class="modal-back" onClick=${e => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-label=${title}>
      <header><button class="link" onClick=${onClose}>닫기</button><b>${title}</b><span>${actions}</span></header>
      <div class="modal-body">${children}</div>
    </div></div>`
}

// ───────── 기기 등록 (PairView.swift) ─────────
function PairView() {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  return html`<div class="sky t-morning center">
    <div class="glass pair">
      <h1>이 기기를 우리 집에 연결해요</h1>
      <p class="muted">보호자 휴대폰에서 받은 8자리 등록 코드를 넣어 주세요. 10분 동안만 쓸 수 있어요.</p>
      <input class="code" aria-label="등록 코드" placeholder="예: K7M2QX9P" autocapitalize="characters" autocomplete="off" spellcheck="false"
        value=${code} onInput=${e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))} />
      <${Message} />
      <button class="pill primary big" disabled=${code.length < 8 || busy}
        onClick=${async () => { setBusy(true); await pair(code); setBusy(false) }}>${busy ? '연결하는 중…' : '연결하기'}</button>
    </div></div>`
}

// ───────── 휴대폰 탭 (PhoneView.swift) ─────────
const TABS = [['달력', '📅'], ['출석부', '⏰'], ['연락처', '📞'], ['장보기', '🛒'], ['기억', '🧠'], ['가족', '👪']]

function PhoneView({ start = 0, onHub }) {
  const [tab, setTab] = useState(start)
  const [talking, setTalking] = useState(false)
  const tabs = TABS.filter((_, i) => i < 5 || isGuardian())
  const Page = [CalendarTab, AttendanceView, ContactsView, ShoppingView, MemoryView, FamilyView][tab]
  const openTalk = () => { setTalking(true); startVoice() } // 누른 순간 듣기 시작 (iOS 는 손댄 때만 마이크를 연다)
  return html`<div class="phone t-morning">
    ${onHub && html`<button class="pill primary hub-back" onClick=${onHub}>🏠 허브로</button>`}
    <main class="page"><${Page} openTalk=${openTalk} /></main>
    <nav class="tabbar">${tabs.map(([name, icon], i) => html`<button class=${tab === i ? 'on' : ''} onClick=${() => setTab(i)}><span>${icon}</span>${name}</button>`)}</nav>
    <div class="toast-wrap bottom"><${UndoToast} /></div>
    ${talking && html`<${AssistantView} onClose=${() => setTalking(false)} />`}
  </div>`
}

function TitleBar({ title, children }) {
  return html`<header class="titlebar"><h2>${title}</h2><div class="tools">${children}</div></header>`
}

// 달력 탭: 한 달 달력 + 고른 날 · 날짜 없는 일
function CalendarTab({ openTalk }) {
  const [offset, setOffset] = useState(0)
  const [picked, setPicked] = useState(null)
  const [adding, setAdding] = useState(false)
  const [detail, setDetail] = useState(null)
  const now = new Date()
  const month = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const lead = month.getDay()
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const open = S.tasks.filter(t => t.status === 'OPEN')
  const byDay = {}
  for (const t of open) if (t.dueDate) (byDay[t.dueDate] ||= []).push(t)
  const today = dayKey(now)
  const undated = open.filter(t => !t.dueDate)
  const Row = t => html`<button class="row" key=${t.id} onClick=${() => setDetail(t.id)}><span class="title">${t.title}</span><${Assignee} task=${t} size=${16} /><span class="chev">${I.right}</span></button>`
  return html`
    <${TitleBar} title="달력">
      <button class="icon" aria-label="말로 부탁하기" onClick=${openTalk}>${I.mic}</button>
      <button class="icon" aria-label="할 일 추가" onClick=${() => setAdding(true)}>${I.plus}</button>
    <//>
    <${Message} />
    <${PushBanner} />
    <section class="glass month">
      <div class="month-head">
        <h3>${month.getFullYear()}년 ${month.getMonth() + 1}월</h3>
        ${offset !== 0 && html`<button class="pill" onClick=${() => { setOffset(0); setPicked(null) }}>이번 달</button>`}
        <button class="pill icon-pill" aria-label="지난달" onClick=${() => { setOffset(offset - 1); setPicked(null) }}>${I.left}</button>
        <button class="pill icon-pill" aria-label="다음 달" onClick=${() => { setOffset(offset + 1); setPicked(null) }}>${I.right}</button>
      </div>
      <div class="grid7">
        ${WEEK.map((w, i) => html`<div class=${'wk' + (i === 0 ? ' sun' : '')}>${w}</div>`)}
        ${Array.from({ length: lead }, () => html`<div></div>`)}
        ${Array.from({ length: days }, (_, k) => {
          const key = dayKey(new Date(month.getFullYear(), month.getMonth(), k + 1))
          const list = byDay[key] || []
          return html`<button class=${'cell' + (key === picked ? ' picked' : '')} aria-label=${`${k + 1}일${key === today ? ', 오늘' : ''}, 마감 ${list.length}개`}
            onClick=${() => setPicked(picked === key ? null : key)}>
            <span class=${'num' + (key === today ? ' today' : (lead + k) % 7 === 0 ? ' sun' : '')}>${k + 1}</span>
            ${list.slice(0, 2).map(t => html`<span class="mini"><i class="dot" style=${{ background: colorIdx(t.assigneeId) != null ? memberColor(colorIdx(t.assigneeId)) : 'var(--faint)' }}></i>${t.title}</span>`)}
            ${list.length > 2 && html`<span class="more">+${list.length - 2}</span>`}
          </button>`
        })}
      </div>
    </section>
    ${picked && html`<section class="glass list"><h3>${dueLabel(picked)}까지 · ${(byDay[picked] || []).length}개</h3>
      ${(byDay[picked] || []).length === 0 && html`<p class="muted">마감인 할 일이 없어요</p>`}
      ${(byDay[picked] || []).map(Row)}</section>`}
    ${undated.length > 0 && html`<section class="glass list"><h3>날짜 없는 일 · ${undated.length}개</h3>${undated.map(Row)}</section>`}
    ${adding && html`<${AddTask} onClose=${() => setAdding(false)} />`}
    ${detail && html`<${TaskDetail} taskId=${detail} onClose=${() => setDetail(null)} />`}`
}

function AddTask({ onClose }) {
  const [title, setTitle] = useState('')
  const [hasDue, setHasDue] = useState(false)
  const [due, setDue] = useState(dayKey(new Date()))
  const [repeat, setRepeat] = useState('')
  const [assignee, setAssignee] = useState(S.me?.memberId ?? '')
  const [priv, setPriv] = useState(false)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    const id = uid(), name = title.trim()
    const args = { id, title: name, visibility: priv ? 'PRIVATE' : 'FAMILY' }
    if (hasDue) args.dueDate = due
    if (hasDue && repeat) args.repeatUnit = repeat
    const other = assignee && assignee !== S.me?.memberId ? assignee : null
    // 남에게 맡기면 두 번 실행한다. "방금 거 취소"는 마지막(맡기기)을 되돌리므로 알림도 맡기기 기준으로
    let ok = await act('tasks.create', args, { note: other ? null : `${name}${obj(name)} 추가했어요` })
    if (ok && other) ok = await act('tasks.assign', { id, assigneeId: other, expectedVersion: 1 }, { confirmed: true, note: `${name}${obj(name)} ${nameOf(other) ?? ''}에게 맡겼어요` })
    setSaving(false)
    if (ok) onClose()
  }
  return html`<${Modal} title="할 일 추가" onClose=${onClose}
      actions=${html`<button class="link strong" disabled=${!title.trim() || saving} onClick=${save}>저장</button>`}>
    <${Message} />
    <input class="field" placeholder="무엇을 할까요? 예: 등본 떼기" value=${title} onInput=${e => setTitle(e.target.value)} />
    <label class="line"><span>마감일</span><input type="checkbox" checked=${hasDue} onChange=${e => setHasDue(e.target.checked)} /></label>
    ${hasDue && html`<label class="line"><span>날짜</span><input type="date" value=${due} onInput=${e => setDue(e.target.value)} /></label>
      <label class="line"><span>반복</span><select value=${repeat} onChange=${e => setRepeat(e.target.value)}><option value="">안 함</option><option value="MONTH">매달</option><option value="YEAR">매년</option></select></label>`}
    ${isGuardian() && html`<label class="line"><span>담당</span><select value=${assignee} onChange=${e => setAssignee(e.target.value)}>${S.members.map(m => html`<option value=${m.id}>${m.name}</option>`)}</select></label>`}
    ${!isTablet() && html`<label class="line"><span>나만 보기</span><input type="checkbox" checked=${priv} onChange=${e => setPriv(e.target.checked)} /></label>`}
    ${priv && html`<p class="muted small">다른 가족과 태블릿에는 보이지 않아요</p>`}
  <//>`
}

function TaskDetail({ taskId, onClose }) {
  const [item, setItem] = useState('')
  const task = S.tasks.find(t => t.id === taskId)
  if (!task) return html`<${Modal} title="할 일" onClose=${onClose}><p class="muted">할 일이 없어요. 지워졌거나 다른 기기에서 바뀌었어요</p><//>`
  const items = S.checklists[task.id] || []
  const contact = S.contacts.find(c => c.id === task.contactId)
  const addItem = () => { const t = item.trim(); if (!t) return; setItem(''); act('tasks.checklist.add', { taskId, itemId: uid(), text: t }) }
  return html`<${Modal} title="할 일" onClose=${onClose}>
    <${Message} />
    <h2 class="detail-title">${task.title}</h2>
    ${task.dueDate && html`<div class="line"><span>마감</span><b>${dueLabel(task.dueDate)}</b></div>`}
    <label class="line"><span>담당</span><select value=${task.assigneeId ?? ''} onChange=${e => e.target.value !== (task.assigneeId ?? '') && act('tasks.assign', { id: task.id, assigneeId: e.target.value, expectedVersion: task.version }, { confirmed: true })}>
      ${!task.assigneeId && html`<option value="">우리 집</option>`}${S.members.map(m => html`<option value=${m.id}>${m.name}</option>`)}</select></label>
    <h4>준비물</h4>
    ${items.map(it => html`<div class="row" key=${it.id}>
      <button class="row-main" aria-pressed=${it.done} onClick=${() => act('tasks.checklist.check', { itemId: it.id, done: !it.done, expectedVersion: it.version })}>
        <span class=${'check small' + (it.done ? ' on' : '')}>${it.done ? I.check : ''}</span><span class=${it.done ? 'muted' : ''}>${it.text}</span></button>
      <button class="link danger" onClick=${() => act('tasks.checklist.remove', { itemId: it.id, expectedVersion: it.version }, { note: '준비물을 지웠어요' })}>지우기</button></div>`)}
    <div class="inline"><input class="field" placeholder="준비물 추가" value=${item} onInput=${e => setItem(e.target.value)} onKeyDown=${e => e.key === 'Enter' && addItem()} /><button class="pill" disabled=${!item.trim()} onClick=${addItem}>추가</button></div>
    <h4>연락처</h4>
    <label class="line"><span>연결</span><select value=${task.contactId ?? ''} onChange=${e => e.target.value !== (task.contactId ?? '') && act('tasks.link_contact', { id: task.id, expectedVersion: task.version, contactId: e.target.value || null })}>
      <option value="">없음</option>${S.contacts.map(c => html`<option value=${c.id}>${c.name}</option>`)}</select></label>
    ${contact && html`<a class="pill" href=${'tel:' + contact.phone.replace(/\D/g, '')}>📞 ${contact.name} 전화 걸기 · ${contact.phone}</a>`}
    <div class="actions">
      ${task.status === 'OPEN' ? html`<button class="pill primary" onClick=${() => complete(task)}>끝냄으로 바꾸기</button>`
        : html`<button class="pill" onClick=${() => reopen(task)}>다시 열기</button>`}
      <button class="pill danger" onClick=${async () => {
        if (!confirm('이 할 일을 지울까요?\n방금 거 취소로 되돌릴 수 있어요')) return
        if (await act('tasks.delete', { id: task.id, expectedVersion: task.version }, { confirmed: true, note: `${task.title}${obj(task.title)} 지웠어요` })) onClose()
      }}>지우기</button>
    </div>
  <//>`
}

// ───────── 출석부 (Attendance.swift) ─────────
function AttendanceButton() {
  const open = openShift()
  const go = () => {
    if (!confirm(open ? '이모님 퇴근을 지금 시각으로 기록할까요?' : '이모님 출근을 지금 시각으로 기록할까요?')) return
    open ? act('attendance.out', {}) : act('attendance.in', { id: uid() })
  }
  return html`<button class=${'attend' + (open ? ' on' : '')} aria-label=${open ? '이모님 퇴근' : '이모님 출근'} onClick=${go}>${open ? '← 퇴근하기' : '→ 출근하기'}</button>`
}

function AttendanceView() {
  const [offset, setOffset] = useState(0)
  const [wage, setWage] = useState(Number(load('hourlyWage')) || 0)
  const [editing, setEditing] = useState(null)
  const now = new Date()
  const month = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const list = S.shifts.filter(s => { const d = new Date(s.inAt); return d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth() })
  const hours = list.filter(s => s.outAt != null).reduce((a, s) => a + (s.outAt - s.inAt) / 3600000, 0)
  return html`
    <${TitleBar} title="이모님 출석부" />
    <${Message} />
    <div class="center-row"><${AttendanceButton} /></div>
    <section class="glass list">
      <div class="month-head">
        <button class="pill icon-pill" aria-label="지난달" disabled=${offset <= -2} onClick=${() => setOffset(offset - 1)}>${I.left}</button>
        <h3 class="grow center-text">${month.getFullYear()}년 ${month.getMonth() + 1}월</h3>
        <button class="pill icon-pill" aria-label="다음 달" disabled=${offset >= 0} onClick=${() => setOffset(offset + 1)}>${I.right}</button>
      </div>
      <div class="line"><span>근무 시간</span><b>${hours.toFixed(1)}시간</b></div>
      <label class="line"><span>시급</span><span><input class="num-input" inputmode="numeric" value=${wage || ''} placeholder="0"
        onInput=${e => { const v = Number(e.target.value.replace(/\D/g, '')) || 0; setWage(v); store('hourlyWage', String(v)) }} /> 원</span></label>
      <div class="line"><span>이달 급여</span><b class="big-num">${Math.round(hours * wage).toLocaleString('ko-KR')}원</b></div>
      <p class="muted small">퇴근을 찍은 근무만 더한다. 시급은 이 기기에만 저장된다.</p>
    </section>
    <section class="glass list"><h3>기록 (누르면 고쳐요)</h3>
      ${list.length === 0 && html`<p class="muted">기록이 없어요</p>`}
      ${list.map(s => { const d = new Date(s.inAt); return html`<button class="row" key=${s.id} onClick=${() => setEditing(s)}>
        <span>${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})</span><span class="muted small">${s.kind}</span><span class="grow"></span>
        <span class=${s.outAt == null ? 'warn' : 'muted'}>${hm(s.inAt)} – ${s.outAt != null ? hm(s.outAt) : '근무 중'}</span></button>` })}
    </section>
    ${editing && html`<${ShiftEditor} shift=${editing} onClose=${() => setEditing(null)} />`}`
}

function ShiftEditor({ shift, onClose }) {
  const [kind, setKind] = useState(shift.kind)
  const [inAt, setIn] = useState(toInput(shift.inAt))
  const [working, setWorking] = useState(shift.outAt == null)
  const [outAt, setOut] = useState(toInput(shift.outAt ?? Date.now()))
  const save = async remove => {
    const args = { id: shift.id, inAt: new Date(inAt).getTime(), remove, expectedVersion: shift.version, kind }
    if (!working) args.outAt = new Date(outAt).getTime()
    if (await act('attendance.edit', args, { confirmed: true })) onClose()
  }
  const bad = !working && new Date(outAt) <= new Date(inAt)
  return html`<${Modal} title="기록 고치기" onClose=${onClose} actions=${html`<button class="link strong" disabled=${bad} onClick=${() => save(false)}>저장</button>`}>
    <${Message} />
    <div class="seg">${['등원', '하원'].map(k => html`<button class=${kind === k ? 'on' : ''} onClick=${() => setKind(k)}>${k}</button>`)}</div>
    <label class="line"><span>출근</span><input type="datetime-local" value=${inAt} onInput=${e => setIn(e.target.value)} /></label>
    <label class="line"><span>아직 근무 중</span><input type="checkbox" checked=${working} onChange=${e => setWorking(e.target.checked)} /></label>
    ${!working && html`<label class="line"><span>퇴근</span><input type="datetime-local" value=${outAt} min=${inAt} onInput=${e => setOut(e.target.value)} /></label>`}
    <button class="pill danger" onClick=${() => confirm('이 기록을 지울까요?') && save(true)}>이 기록 지우기</button>
  <//>`
}

// ───────── 연락처 · 장보기 · 기억 ─────────
function ContactsView() {
  const [adding, setAdding] = useState(false)
  return html`
    <${TitleBar} title="연락처"><button class="icon" aria-label="연락처 추가" onClick=${() => setAdding(true)}>${I.plus}</button><//>
    <${Message} />
    <section class="glass list">
      ${S.contacts.length === 0 && html`<p class="muted">저장한 연락처가 없어요</p>`}
      ${S.contacts.map(c => html`<div class="row" key=${c.id}>
        <a class="row-main col" href=${'tel:' + c.phone.replace(/\D/g, '')}><b>${c.name}</b><span class="muted small">${[c.phone, c.category, c.memo].filter(Boolean).join(' · ')}</span></a>
        <button class="link danger" onClick=${() => confirm('이 연락처를 지울까요?') && act('contacts.delete', { id: c.id, expectedVersion: c.version }, { confirmed: true, note: `${c.name} 연락처를 지웠어요` })}>지우기</button></div>`)}
    </section>
    ${adding && html`<${AddContact} onClose=${() => setAdding(false)} />`}`
}

function AddContact({ onClose }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [category, setCategory] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    const args = { id: uid(), name: name.trim(), phone }
    if (category) args.category = category
    setSaving(true)
    if (await act('contacts.create', args)) onClose()
    setSaving(false)
  }
  return html`<${Modal} title="연락처 추가" onClose=${onClose} actions=${html`<button class="link strong" disabled=${!name.trim() || !phone || saving} onClick=${save}>저장</button>`}>
    <${Message} />
    <input class="field" placeholder="이름 예: 관리사무소" value=${name} onInput=${e => setName(e.target.value)} />
    <input class="field" type="tel" placeholder="번호 예: 02-000-0000" value=${phone} onInput=${e => setPhone(e.target.value)} />
    <input class="field" placeholder="분류 (선택) 예: 아파트" value=${category} onInput=${e => setCategory(e.target.value)} />
  <//>`
}

function ShoppingView() {
  const [name, setName] = useState('')
  const add = () => { const t = name.trim(); if (!t) return; setName(''); act('shopping.add', { id: uid(), name: t }) }
  return html`
    <${TitleBar} title="장보기" />
    <${Message} />
    <section class="glass list">
      <div class="inline"><input class="field" placeholder="무엇을 살까요? 예: 우유 2개" value=${name} onInput=${e => setName(e.target.value)} onKeyDown=${e => e.key === 'Enter' && add()} />
        <button class="pill primary" disabled=${!name.trim()} onClick=${add}>넣기</button></div>
      ${S.shopping.length === 0 && html`<p class="muted">살 것이 없어요</p>`}
      ${S.shopping.map(it => html`<div class="row" key=${it.id}>
        <button class="row-main" aria-pressed=${it.bought} onClick=${() => act('shopping.check', { id: it.id, bought: !it.bought, expectedVersion: it.version })}>
          <span class=${'check small' + (it.bought ? ' on' : '')}>${it.bought ? I.check : ''}</span>
          <span class=${it.bought ? 'muted strike' : ''}>${it.name}</span>${it.amount && html`<span class="muted">${it.amount}</span>`}</button>
        <button class="link danger" onClick=${() => act('shopping.remove', { id: it.id, expectedVersion: it.version }, { note: `${it.name}${obj(it.name)} 뺐어요` })}>빼기</button></div>`)}
    </section>`
}

function MemoryView() {
  const [text, setText] = useState('')
  const [onlyMe, setOnlyMe] = useState(false)
  const add = () => { const t = text.trim(); if (!t) return; setText(''); act('memory.remember', { id: uid(), text: t, onlyMe }, { note: '기억해 둘게요' }) }
  return html`
    <${TitleBar} title="기억" />
    <${Message} />
    <section class="glass list">
      <div class="inline"><input class="field" placeholder="예: 관리사무소는 평일 6시까지" value=${text} onInput=${e => setText(e.target.value)} onKeyDown=${e => e.key === 'Enter' && add()} />
        <button class="pill primary" disabled=${!text.trim()} onClick=${add}>기억</button></div>
      ${isGuardian() && html`<label class="line"><span>나만 보기</span><input type="checkbox" checked=${onlyMe} onChange=${e => setOnlyMe(e.target.checked)} /></label>`}
      <p class="muted small">할 일·연락처가 아닌 우리 집 정보를 비서가 기억해요. 비서에게 "…기억해 줘"라고 말해도 돼요.</p>
    </section>
    <section class="glass list"><h3>기억한 것</h3>
      ${S.facts.length === 0 && html`<p class="muted">아직 없어요</p>`}
      ${S.facts.map(f => html`<div class="row" key=${f.id}><div class="row-main col">
          <span>${f.onlyMe ? '🔒 ' : ''}${f.text}</span>
          ${f.saidBy && nameOf(f.saidBy) && html`<span class="muted small">${nameOf(f.saidBy)}${subj(nameOf(f.saidBy))} 알려 줌</span>`}</div>
        ${isGuardian() && html`<button class="link danger" onClick=${() => confirm('이 기억을 지울까요?') && act('memory.forget', { id: f.id, expectedVersion: f.version }, { confirmed: true, note: '기억을 지웠어요' })}>잊기</button>`}</div>`)}
    </section>`
}

// ───────── 가족 (보호자) ─────────
function FamilyView() {
  const [adding, setAdding] = useState(false)
  const issue = async (kind, memberId, title) => {
    const r = await api('POST', '/pairing-codes', { kind, memberId })
    if (r.status === 200 || r.status === 201) alert(`${title}\n\n${r.json.code}\n\n새 기기에서 10분 안에 넣어 주세요`)
    else { report(r); if (!S.message) setMessage('등록 코드를 받지 못했어요') }
  }
  const revoke = async d => {
    if (!confirm('이 기기의 연결을 끊을까요?\n다시 쓰려면 등록 코드로 새로 연결해야 해요')) return
    report(await api('POST', `/devices/${d.id}/revoke`)); await refresh()
  }
  return html`
    <${TitleBar} title="가족" />
    <${Message} />
    <section class="glass list"><h3>구성원</h3>
      ${S.members.map(m => html`<div class="row" key=${m.id}><b>${m.name}</b><span class="muted small">${m.role === 'GUARDIAN' ? '보호자' : '아이'}</span><span class="grow"></span>
        <button class="pill" onClick=${() => issue('PHONE', m.id, `${m.name} 휴대폰 등록 코드`)}>휴대폰 연결</button></div>`)}
      <button class="link strong" onClick=${() => setAdding(true)}>구성원 추가</button>
    </section>
    <section class="glass list"><h3>연결된 기기</h3>
      ${S.devices.map(d => html`<div class="row" key=${d.id}><div class="row-main col">
          <span>${d.kind === 'TABLET' ? '태블릿' : `${nameOf(d.memberId) ?? ''} 휴대폰`}</span>
          <span class="muted small">${new Date(d.createdAt).toLocaleDateString('ko-KR')} 연결</span></div>
        <button class="link danger" onClick=${() => revoke(d)}>연결 해제</button></div>`)}
      <button class="link strong" onClick=${() => issue('TABLET', null, '태블릿 등록 코드')}>태블릿 연결</button>
      <p class="muted small">잃어버린 기기는 연결을 해제해요</p>
    </section>
    ${adding && html`<${AddMember} onClose=${() => setAdding(false)} />`}`
}

function AddMember({ onClose }) {
  const [name, setName] = useState('')
  const [guardian, setGuardian] = useState(false)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    const r = await api('POST', '/members', { name: name.trim(), role: guardian ? 'GUARDIAN' : 'CHILD' })
    report(r); await refresh(); setSaving(false)
    if (r.status >= 200 && r.status < 300) onClose()
  }
  return html`<${Modal} title="구성원 추가" onClose=${onClose} actions=${html`<button class="link strong" disabled=${!name.trim() || saving} onClick=${save}>추가</button>`}>
    <${Message} />
    <input class="field" placeholder="이름" value=${name} onInput=${e => setName(e.target.value)} />
    <div class="seg"><button class=${!guardian ? 'on' : ''} onClick=${() => setGuardian(false)}>아이</button><button class=${guardian ? 'on' : ''} onClick=${() => setGuardian(true)}>보호자</button></div>
  <//>`
}

// ───────── 비서 대화 (AssistantView.swift) ─────────
let lastTouch = Date.now()
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => { lastTouch = Date.now() }, true)

function AssistantView({ onClose }) {
  const scroller = useRef(null)
  const input = useRef(null)
  const close = () => { cancelVoice(); newChat(); onClose() } // 닫으면 대화 끝 (서버에 남지 않는다)
  useEffect(() => { lastTouch = Date.now() }, [S.chat.length, S.heard, S.listening])
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight }, [S.chat.length, S.thinking])
  useEffect(() => { // 2분 동안 손대지 않으면 닫힌다 (공용 iPad 에서 다음 사람 말이 섞이지 않게)
    const t = setInterval(() => {
      if (!S.listening && !S.thinking && document.activeElement !== input.current && Date.now() - lastTouch > 120000) close()
    }, 10000)
    return () => clearInterval(t)
  }, [])
  const live = [S.draft, S.heard].filter(Boolean).join(' ')
  const canSend = !S.listening && !S.thinking && S.draft.trim()
  const lastId = S.chat[S.chat.length - 1]?.id
  return html`<div class="assistant">
    <header><b class="a-name">비서</b><span class="a-sub">${S.chat.length ? `이 대화 ${Math.ceil(S.chat.length / 2)}턴 · 최근 30턴까지 기억` : '새 대화'}</span>
      <span class="grow"></span>
      <button class="ghost" onClick=${() => { newChat() }}>${I.plus} 새 대화</button>
      <button class="round" aria-label="닫기 (대화 끝)" onClick=${close}>${I.x}</button></header>
    <div class="convo" ref=${scroller}>
      ${S.chat.length === 0 && html`<p class="hint">예: 내일까지 등본 떼기 넣어줘 · 오늘 할 일 뭐야? · 필터 교체 진우한테 넘겨</p>`}
      ${S.chat.map(l => l.mine ? html`<p class="mine" key=${l.id}>“${l.text}”</p>` : html`<div class="answer" key=${l.id}>
        <p>${l.text}</p>
        ${l.card && html`<div class="result"><span class="ok">${I.check}</span><div class="grow"><b>${l.card.title}</b>${l.card.meta && html`<small>${l.card.meta}</small>`}</div>
          ${l.id === lastId && S.undoNote && html`<button class="pill" onClick=${undo}>되돌리기</button>`}</div>`}
        ${S.pending && l.id === lastId && html`<div class="yesno"><button class="yes" onClick=${() => answer(true)}>응, 해 줘</button><button class="no" onClick=${() => answer(false)}>아니</button></div>`}
      </div>`)}
      ${S.thinking && html`<div class="thinking" aria-label="생각하는 중"><i></i><i></i><i></i></div>`}
    </div>
    <footer>
      ${S.micDenied && html`<p class="denied">마이크·음성 인식이 꺼져 있어요. 브라우저 설정에서 마이크를 허용해 주세요</p>`}
      <${Message} />
      <div class="compose">
        ${S.listening ? html`<div class=${'box' + (live ? '' : ' faint')}>${live || '듣고 있어요…'}</div>`
          : html`<textarea class="box" ref=${input} rows="1" placeholder="무엇이든 물어보세요" value=${S.draft}
              onInput=${e => { S.draft = e.target.value; rerender() }}
              onKeyDown=${e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendDraft() } }}></textarea>`}
        <button class=${'roundbig' + (S.listening ? ' rec' : '')} disabled=${S.thinking} aria-label=${S.listening ? '받아쓰기 멈추기' : '말로 받아쓰기'}
          onClick=${() => S.listening ? stopVoice() : startVoice()}>${S.listening ? I.stop : I.mic}</button>
        <button class="roundbig" disabled=${!canSend} aria-label="보내기" onClick=${sendDraft}>${I.up}</button>
      </div>
      <p class="under">${S.listening ? '마이크를 다시 누르면 멈춰요' : S.pending ? '‘응’ 또는 ‘아니’로 답해 주세요' : ' '}</p>
    </footer>
  </div>`
}

// ───────── iPad 허브 (HubView.swift) ─────────
const mins = s => { const m = /^(\d+):(\d+)$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null }
function themeAt(now, sunrise, sunset) {
  const m = now.getHours() * 60 + now.getMinutes()
  const rise = mins(sunrise) ?? 420, down = mins(sunset) ?? 1080
  if (m >= rise && m < down - 60) return 'morning'
  if (m >= down - 60 && m < down + 150) return 'sunset'
  return 'night'
}
const WEATHER = { CLEAR: ['맑음', '☀️', '🌙'], CLOUDY: ['흐림', '☁️', '☁️'], RAIN: ['비', '🌧️', '🌧️'], SNOW: ['눈', '🌨️', '🌨️'] }
function weatherText(w) {
  if (!w) return null
  const t = w.temp != null ? ` · ${w.temp}°` : ''
  return { CLEAR: '맑음' + t, CLOUDY: '흐림' + t, RAIN: '비' + t + ' · 우산 챙기기', SNOW: '눈' + t + ' · 길 미끄러움' }[w.kind]
}

// 개발: ?weather=RAIN|SNOW|CLOUDY|CLEAR 로 배경을 미리 본다
const forcedWeather = new URLSearchParams(location.search).get('weather')
const weatherKind = () => forcedWeather || S.weather?.kind

/** 비·눈 배경층: 칸마다 정해진 자리에서 떨어진다 (같은 칸이면 같은 자리라 깜빡이지 않는다) */
function WeatherLayer({ kind }) {
  const ref = useRef(null)
  useEffect(() => {
    if (kind !== 'RAIN' && kind !== 'SNOW') return
    const cv = ref.current, g = cv.getContext('2d')
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    const hash = n => { const v = Math.sin(n * 12.9898) * 43758.5453; return v - Math.floor(v) }
    const drops = (w, h, cellW, cellH, per, speed, t, draw) => {
      const cols = Math.floor(w / cellW) + 1, rows = Math.floor(h / cellH) + 2, fall = t * speed
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) for (let k = 0; k < per; k++) {
        const n = c * 7919 + r * 104729 + k * 1301, s1 = hash(n), s2 = hash(n + 0.5)
        draw((c + s1) * cellW, ((r + s2) * cellH + fall) % (rows * cellH) - cellH, s1)
      }
    }
    let raf
    const frame = ms => {
      const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr) }
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h)
      const t = still ? 0 : ms / 1000
      if (kind === 'RAIN') {
        g.lineCap = 'round'; g.shadowBlur = 0
        for (const [lw, l0, l1, a0, a1, cw, ch, n, sp] of [[1, 14, 22, .3, .5, 110, 417, 12, 556], [1.4, 22, 32, .6, .85, 140, 278, 9, 660]])
          drops(w, h, cw, ch, n, sp, t, (x, y, s) => {
            const l = l0 + (l1 - l0) * s, a = a0 + (a1 - a0) * s
            const gr = g.createLinearGradient(x, y, x, y + l)
            gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, `rgba(255,255,255,${0.9 * a})`)
            g.strokeStyle = gr; g.lineWidth = lw; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + l); g.stroke()
          })
      } else {
        g.shadowColor = 'rgba(20,50,110,.45)'; g.shadowBlur = 3
        for (const [r0, r1, a, cw, ch, n, sp] of [[1, 2, .45, 170, 417, 12, 35], [2.5, 3.6, .85, 240, 278, 7, 40]])
          drops(w, h, cw, ch, n, sp, t, (x, y, s) => {
            g.fillStyle = `rgba(255,255,255,${a})`; g.beginPath()
            g.arc(x + Math.sin(t * 0.6 + s * 6.28) * 8, y, r0 + (r1 - r0) * s, 0, Math.PI * 2); g.fill() // 살짝 흔들리며
          })
      }
      if (!still) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [kind])
  return kind === 'RAIN' || kind === 'SNOW' ? html`<canvas class="wx" ref=${ref} aria-hidden="true"></canvas>` : null
}

function HubView() {
  const [now, setNow] = useState(new Date())
  const [page, setPage] = useState(0)
  const [full, setFull] = useState(null)
  const [talking, setTalking] = useState(false)
  const pager = useRef(null)
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 20000); return () => clearInterval(t) }, [])
  useEffect(() => { // 2분 동안 손대지 않으면 전체 보기에서 허브로 돌아간다 (글자 입력 중은 빼고)
    const t = setInterval(() => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
      if (full != null && !typing && Date.now() - lastTouch > 120000) setFull(null)
    }, 10000)
    return () => clearInterval(t)
  }, [full])
  const theme = themeAt(now, S.weather?.sunrise, S.weather?.sunset)
  const night = theme === 'night'
  const onScroll = e => setPage(Math.round(e.target.scrollLeft / e.target.clientWidth))
  const wx = weatherKind()
  return html`<div class=${'hub sky t-' + theme + (wx ? ' w-' + wx.toLowerCase() : '')}>
    <${WeatherLayer} kind=${wx} />
    <div class="pager" ref=${pager} onScroll=${onScroll}>
      <section class="hub-page"><${Ambient} now=${now} night=${night} /></section>
      <section class="hub-page"><${HubCalendar} now=${now} /></section>
    </div>
    ${S.briefing && html`<div class="briefing glass">${S.briefing}</div>`}
    <div class="toast-wrap top"><${UndoToast} /></div>
    <div class="controls">
      <${HubMenu} pick=${setFull} />
      <div class="mid"><div class="dots">${[0, 1].map(i => html`<i class=${i === page ? 'on' : ''}></i>`)}</div>
        <button class="mic-big" aria-label="말로 부탁하기" onClick=${() => { setTalking(true); startVoice() }}>${I.mic}</button></div>
      <${AttendanceButton} />
    </div>
    ${full != null && html`<div class="full"><${PhoneView} start=${full} onHub=${() => setFull(null)} /></div>`}
    ${talking && html`<${AssistantView} onClose=${() => setTalking(false)} />`}
  </div>`
}

function Ambient({ now, night }) {
  const list = [...S.tasks.filter(t => t.status === 'OPEN'), ...S.tasks.filter(doneToday)]
  const w = weatherText(S.weather && { ...S.weather, kind: weatherKind() })
  return html`<div class="ambient">
    <div class="left">
      <span class="grow"></span>
      <p class="date">${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEK[now.getDay()]}요일</p>
      <p class="clock">${pad(now.getHours())}:${pad(now.getMinutes())}</p>
      ${w && html`<p class="weather">${WEATHER[weatherKind()]?.[night ? 2 : 1]} ${S.homePlace ? S.homePlace + ' · ' : ''}${w}</p>`}
      <span class="grow"></span><span class="grow"></span>
      <${ShiftChip} />
    </div>
    <${TodayCard} tasks=${list} />
  </div>`
}

function ShiftChip() {
  const open = openShift()
  const today = S.shifts.find(s => dayKey(new Date(s.inAt)) === dayKey(new Date()))
  const text = open ? `이모님 ${open.kind} · 근무 중 ${hm(open.inAt)}부터`
    : today?.outAt != null ? `이모님 · 오늘 ${today.kind} ${hm(today.inAt)}–${hm(today.outAt)}` : '이모님 · 출근 전'
  return html`<div class="chip"><i class="dot" style=${{ background: open ? '#1f9d55' : 'var(--faint)' }}></i>${text}</div>`
}

function TodayCard({ tasks }) {
  const today = dayKey(new Date())
  const [first, ...rest] = tasks
  return html`<div class="glass today-card">
    ${first ? html`
      <p class=${'due-head' + (first.dueDate === today ? ' urgent' : '')}>${first.dueDate === today ? '오늘까지' : first.dueDate ? `${dueLabel(first.dueDate)}까지` : '다음 할 일'}</p>
      <div class="first"><${CheckCircle} task=${first} size=${36} />
        <div><p class=${'big-title' + (first.status === 'DONE' ? ' strike faint' : '')}>${first.title}</p><${Assignee} task=${first} size=${20} /></div></div>
      <div class="rest">${rest.map(t => html`<div class="row" key=${t.id}><${CheckCircle} task=${t} size=${26} />
        <span class=${'title' + (t.status === 'DONE' ? ' strike faint' : '')}>${t.title}</span>
        ${t.dueDate && html`<span class=${'due' + (t.dueDate === today ? ' urgent' : '')}>${dueLabel(t.dueDate)}</span>`}<${Assignee} task=${t} size=${15} /></div>`)}</div>`
      : html`<p class="empty">남은 일이 없어요</p>`}
  </div>`
}

function HubCalendar({ now }) {
  const [offset, setOffset] = useState(0)
  const [picked, setPicked] = useState(null)
  const [who, setWho] = useState(null)
  const today = dayKey(now)
  const day = picked ?? today
  const mine = S.tasks.filter(t => who == null || t.assigneeId === who || t.assigneeId == null)
  const open = mine.filter(t => t.status === 'OPEN')
  const byDay = {}
  for (const t of [...open, ...mine.filter(t => t.status === 'DONE')]) if (t.dueDate) (byDay[t.dueDate] ||= []).push(t)
  const month = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const lead = month.getDay()
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const shifts = {}
  for (const s of S.shifts) { const k = dayKey(new Date(s.inAt)); shifts[k] ??= `이모님 ${s.kind} ${hm(s.inAt)}–${s.outAt != null ? hm(s.outAt) : ' 근무 중'}` }
  const list = [...(byDay[day] || []), ...(day === today ? [...open.filter(t => !t.dueDate), ...mine.filter(t => doneToday(t) && !t.dueDate)] : [])]
  const tomorrow = dayKey(addDays(now, 1))
  const next = open.filter(t => (t.dueDate ?? '') > today).sort((a, b) => a.dueDate < b.dueDate ? -1 : 1).slice(0, 3)
  const chip = (name, color, on, go) => html`<button class=${'fchip' + (on ? ' on' : '')} aria-label=${on ? `${name} 보는 중` : `${name} 것만 보기`} onClick=${go}><i class="dot" style=${{ background: color }}></i>${name}</button>`
  return html`<div class="hub-cal">
    <div class="glass cal">
      <div class="month-head"><h3>${month.getFullYear()}년 ${month.getMonth() + 1}월</h3><span class="grow"></span>
        ${chip('전체', 'var(--ink)', who == null, () => setWho(null))}
        ${S.members.map((m, i) => chip(m.name, memberColor(i), who === m.id, () => setWho(m.id)))}
        <button class="pill icon-pill" aria-label="지난달" onClick=${() => { setOffset(offset - 1); setPicked(null) }}>${I.left}</button>
        <button class="pill icon-pill" aria-label="다음 달" onClick=${() => { setOffset(offset + 1); setPicked(null) }}>${I.right}</button></div>
      <div class="grid7 hubgrid">
        ${WEEK.map((w, i) => html`<div class=${'wk' + (i === 0 ? ' sun' : '')}>${w}</div>`)}
        ${Array.from({ length: lead }, () => html`<div></div>`)}
        ${Array.from({ length: days }, (_, k) => {
          const key = dayKey(new Date(month.getFullYear(), month.getMonth(), k + 1))
          const ts = byDay[key] || []
          return html`<button class=${'hcell' + (key === day ? ' picked' : '') + (key < today ? ' past' : '')} onClick=${() => setPicked(key)}
              aria-label=${`${k + 1}일${key === today ? ', 오늘' : ''}, 마감 ${ts.length}개${shifts[key] ? ', ' + shifts[key] : ''}`}>
            <span class=${'num' + (key === today ? ' today' : (lead + k) % 7 === 0 ? ' sun' : '')}>${k + 1}</span>
            ${ts.slice(0, 2).map(t => html`<span class=${'mini' + (t.status === 'DONE' ? ' strike faint' : '')}><i class="dot" style=${{ background: colorIdx(t.assigneeId) != null ? memberColor(colorIdx(t.assigneeId)) : 'var(--faint)' }}></i>${t.title}</span>`)}
            ${ts.length > 2 && html`<span class="more">+${ts.length - 2}</span>`}
            <span class="grow"></span>
            ${shifts[key] && html`<span class="shift">${shifts[key]}</span>`}
          </button>`
        })}
      </div>
    </div>
    <div class="side">
      <div class="glass day-card"><h3>${day === today ? '오늘 할 일' : dayTitle(day)} ${list.length > 0 && html`<small>남은 ${list.filter(t => t.status === 'OPEN').length}개</small>`}</h3>
        ${list.length === 0 && html`<p class="muted">이날은 할 일이 없어요</p>`}
        <div class="scroll">${list.map(t => html`<div class="row" key=${t.id}><${CheckCircle} task=${t} size=${28} />
          <span class=${'title' + (t.status === 'DONE' ? ' strike faint' : '')}>${t.title}</span><${Assignee} task=${t} size=${14} /></div>`)}</div></div>
      <div class="glass upcoming"><h3>다가오는 마감</h3>
        ${next.length === 0 && html`<p class="muted">없어요</p>`}
        ${next.map(t => html`<div class="row" key=${t.id}><b class=${t.dueDate === tomorrow ? 'soon' : 'muted'}>${t.dueDate === tomorrow ? '내일' : dueLabel(t.dueDate)}</b><span class="title">${t.title}</span></div>`)}</div>
    </div>
  </div>`
}

const MENU = [['📅', '달력'], ['⏰', '출석부'], ['📞', '연락처'], ['🛒', '장보기'], ['🧠', '기억']]
function HubMenu({ pick }) {
  const [open, setOpen] = useState(false)
  const R = 170
  return html`<div class=${'fan' + (open ? ' open' : '')}>
    ${open && MENU.map(([icon, name], i) => {
      const a = Math.PI / 2 * i / (MENU.length - 1) // 0 = 위, π/2 = 오른쪽
      return html`<button class="fan-item" aria-label=${name} style=${{ transform: `translate(${R * Math.sin(a) + 4}px, ${-R * Math.cos(a) - 4}px)` }}
        onClick=${() => { setOpen(false); pick(i) }}><span>${icon}</span><small>${name}</small></button>`
    })}
    <button class="fan-toggle" aria-label=${open ? '메뉴 닫기' : '화면 메뉴'} onClick=${() => setOpen(!open)}>${open ? I.x : I.grid}</button>
  </div>`
}

// 허브 일: 날씨·집 위치·브리핑·화면 켜 두기
async function hubJobs(g) {
  // 집 위치를 서버에 알려 주고 그 위치의 날씨를 받는다 (서버가 약 1km 로 반올림해서 저장)
  const pos = await here()
  if (pos) { await api('PUT', '/home-location', pos); placeName(pos) }
  let weatherAt = 0, lastBriefing = ''
  while (g === gen) {
    if (Date.now() - weatherAt > 15 * 60000) {
      const r = await api('GET', '/weather')
      if (r.status === 200) { weatherAt = Date.now(); set({ weather: r.json }) }
    }
    // 아침·저녁 브리핑: 07:30 · 20:00 에 받아서 읽고 10분 보여 준다. 22~7시는 말하지 않는다
    const now = new Date(), t = `${pad(now.getHours())}:${pad(now.getMinutes())}`, key = dayKey(now) + ' ' + t
    const kind = t === '07:30' ? 'MORNING' : t === '20:00' ? 'EVENING' : null
    if (kind && key !== lastBriefing) {
      const r = await api('GET', '/briefing?kind=' + kind)
      if (r.status === 200) {
        lastBriefing = key
        set({ briefing: r.json.text })
        const h = now.getHours()
        if (!(h >= 22 || h < 7) && !S.listening) speak(r.json.text)
        const shown = r.json.text
        setTimeout(() => { if (S.briefing === shown) set({ briefing: null }) }, 600000)
      }
    }
    await sleep(20000)
  }
}

/** 날씨 위치 이름 (예: "서울 중구"). 약 1km 로 줄인 좌표만 OpenStreetMap 에 묻는다 */
async function placeName({ lat, lon }) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=ko&lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`)
    const a = (await r.json()).address || {}
    const city = (a.city || a.town || a.county || a.province || a.state || '').replace(/특별자치시|특별자치도|특별시|광역시/, '')
    const name = [city, a.borough || a.city_district || a.suburb || a.village].filter(Boolean).join(' ')
    if (name) set({ homePlace: name })
  } catch {}
}

let wakeLock = null
async function keepAwake() {
  try { if (navigator.wakeLock && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen') } catch {}
}
document.addEventListener('visibilitychange', () => { if (isTablet() && document.visibilityState === 'visible') keepAwake() })

// ───────── 시작 ─────────
let started = -1
function start() {
  if (!S.token || !S.me || started === gen) return
  started = gen
  watchChanges(gen)
  if (isTablet()) { hubJobs(gen); keepAwake() } else startPush()
}

function App() {
  const [, tick] = useState(0)
  rerender = () => tick(n => n + 1)
  useEffect(() => {
    let alive = true
    ;(async () => { // 이 기기가 휴대폰인지 태블릿인지 서버에 묻는다. 오프라인이면 5초마다 다시
      while (alive && S.token && !S.me) { await refresh(); if (!S.me) await sleep(5000) }
      start()
    })()
    return () => { alive = false }
  }, [S.token])
  if (!S.token) return html`<${PairView} />`
  if (!S.me) return html`<div class="sky t-morning center"><p class="muted">${S.message ?? '연결하는 중…'}</p></div>`
  return isTablet() ? html`<${HubView} />` : html`<${PhoneView} />`
}

render(html`<${App} />`, document.getElementById('app'))
