/* ---------------------------------------------------------------------------
   admin.js — the teacher console.
--------------------------------------------------------------------------- */

import { initDb, db, get, set, del, list, bulkSet, watchDoc, watchList, delCollection, dumpLocal, loadLocal, explain, signInTeacher } from './db.js';
import {
  DEFAULT_SETTINGS, QUESTION_TYPES, parseStudents, parseQuestions, drawStudents,
  computeAwards, toCsv, download, slug, rid
} from './model.js';
import { grade, score, preview, DIFFICULTY_NAMES, brierMean, calibrationBuckets } from './scoring.js';
import { el, $, $$, answerWidget, confidenceWidget, questionMeta, typeLabel, describeAnswer, sfx, toast, LETTERS } from './render.js';

const state = {
  classes: [],
  classId: null,
  cls: null,
  settings: { ...DEFAULT_SETTINGS },
  students: [],
  questions: [],
  keys: {},
  live: null,
  responses: [],
  results: [],
  prizes: [],
  seats: [],
  responseError: null,
  chosen: [],
  section: 'run',
  filters: { topic: '', difficulty: '', type: '' },
  teacherEntry: {}          // studentId -> { answer, confidence } when typing for the class
};

let unsubs = [];

/* ---------- boot -------------------------------------------------------- */

// A refused or failed write used to disappear into the console, which made a
// rules problem look like the app doing nothing at all. Now it says so.
window.addEventListener('unhandledrejection', (e) => {
  const info = explain(e.reason);
  if (info.code === 'permission-denied') {
    toast('Firebase refused that. This device may not be a teacher yet — check the home page.', 'bad');
  } else if (info.code === 'unavailable') {
    toast('Cannot reach Firebase right now. Nothing was saved.', 'bad');
  } else {
    toast(`That did not save: ${info.message.slice(0, 120)}`, 'bad');
  }
  console.error('Quiz Arena write failed:', info, e.reason);
});

await initDb();

if (db.mode === 'cloud' && db.lastError) {
  document.querySelector('.main').prepend(
    el('div', { class: 'notice notice-bad' }, [
      el('div', { text: `Firebase answered with "${db.lastError.code}" while ${db.lastError.stage}, so nothing here will save.` }),
      db.lastError.hint ? el('div', { class: 'tiny', style: 'margin-top:5px', text: db.lastError.hint }) : null,
      el('a', { href: 'diagnose.html', class: 'tiny', text: 'Run the connection check' })
    ])
  );
}

$('#mode-note').textContent = db.mode === 'cloud'
  ? (db.isAdmin
      ? `Teacher${db.email ? ': ' + db.email : ' on this device'}`
      : 'Signed in, but not a teacher')
  : 'This device only';

/* The console does not open at all without a teacher account. Firestore rules
   refuse the writes anyway, but a console that loads and then silently fails
   is worse than one that asks you to sign in. */
if (db.mode === 'cloud' && !db.isAdmin) {
  showGate();
} else {
  wireUp();
  await loadClasses();
}

function showGate() {
  $('#shell').classList.add('hidden');
  const gate = $('#gate');
  gate.classList.remove('hidden');

  if (db.lastError) {
    $('#gate-why').textContent = `Firebase answered with "${db.lastError.code}" while ${db.lastError.stage}.`;
    $('#g-note').innerHTML = `${db.lastError.hint || ''} <a href="diagnose.html">Run the connection check</a>.`;
  } else if (!db.isAnonymous) {
    $('#gate-why').textContent = `Signed in as ${db.email}, but that account is not on the teacher list.`;
    $('#g-note').innerHTML = `Its ID is <code>${db.uid}</code>. Someone with Firebase console access needs to add that as a document in the <code>admins</code> collection.`;
  }

  const attempt = async () => {
    const email = $('#g-email').value.trim();
    const pw = $('#g-pw').value;
    if (!email || !pw) { toast('Enter the email and password.', 'warn'); return; }
    const btn = $('#g-signin');
    btn.disabled = true;
    try {
      await signInTeacher(email, pw);
      if (db.isAdmin) location.reload();
      else {
        btn.disabled = false;
        $('#gate-why').textContent = 'That account signed in, but it is not on the teacher list.';
        $('#g-note').innerHTML = `Its ID is <code>${db.uid}</code>. Add that as a document in the <code>admins</code> collection in the Firebase console.`;
      }
    } catch (err) {
      btn.disabled = false;
      const said = {
        'auth/invalid-credential': 'That email and password do not match an account on this project.',
        'auth/wrong-password': 'Wrong password.',
        'auth/user-not-found': 'No account with that email.',
        'auth/invalid-email': 'That does not look like an email address.',
        'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
        'auth/operation-not-allowed': 'Email sign-in is switched off in the Firebase console.'
      }[err?.code];
      toast(said || err?.message || 'Could not sign in', 'bad');
    }
  };
  $('#g-signin').addEventListener('click', attempt);
  $('#g-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
}

function wireUp() {

  $$('.rail button[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));
  $('#new-class').addEventListener('click', createClass);
  $('#first-class').addEventListener('click', createClass);
  $('#class-picker').addEventListener('change', (e) => selectClass(e.target.value));
}

/* ---------- classes ----------------------------------------------------- */

async function loadClasses() {
  state.classes = await list('classes');
  state.classes.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const picker = $('#class-picker');
  picker.textContent = '';
  state.classes.forEach((c) => picker.appendChild(el('option', { value: c.id, text: c.name || c.id })));

  const remembered = localStorage.getItem('quizarena:class');
  const pick = state.classes.find((c) => c.id === remembered) || state.classes[0];
  if (pick) { picker.value = pick.id; await selectClass(pick.id); }
  else {
    $('#no-class').classList.remove('hidden');
    $$('.sec').forEach((s) => s.classList.add('hidden'));
  }
}

async function createClass() {
  const name = prompt('Class name, for example "Year 9 Science" or "Grade 7B"');
  if (!name || !name.trim()) return;
  const id = slug(name, 'class');
  try {
    await set(`classes/${id}`, { name: name.trim(), settings: { ...DEFAULT_SETTINGS }, createdAt: Date.now() });
  } catch (err) {
    const info = explain(err);
    toast(info.hint || `Could not create the class: ${info.code}`, 'bad');
    console.error(err);
    return;
  }
  $('#no-class').classList.add('hidden');
  await loadClasses();
  $('#class-picker').value = id;
  await selectClass(id);
  show('students');
  toast(`${name.trim()} is ready. Add the class list next.`);
}

async function selectClass(id) {
  unsubs.forEach((u) => { try { u(); } catch {} });
  unsubs = [];
  state.classId = id;
  localStorage.setItem('quizarena:class', id);
  state.cls = await get(`classes/${id}`);
  state.settings = { ...DEFAULT_SETTINGS, ...(state.cls?.settings || {}) };
  sfx.enabled = state.settings.sound !== false;

  unsubs.push(watchList(`classes/${id}/students`, (rows) => {
    state.students = rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    updatePoolNote();
    if (['run', 'students', 'awards', 'reports'].includes(state.section)) render();
  }));
  unsubs.push(watchList(`classes/${id}/questions`, (rows) => {
    state.questions = rows;
    if (['run', 'questions', 'reports'].includes(state.section)) render();
  }));
  unsubs.push(watchDoc(`classes/${id}/live/now`, (doc) => {
    state.live = doc;
    watchResponses();
    armAutoReveal(doc);
    if (state.section === 'run') render();
  }));
  unsubs.push(watchList(`classes/${id}/seats`, (rows) => {
    state.seats = rows;
    if (state.section === 'students') render();
  }));
  unsubs.push(watchList(`classes/${id}/prizes`, (rows) => {
    state.prizes = rows;
    if (state.section === 'awards') render();
  }));

  state.keys = {};
  if (db.isAdmin) {
    (await list(`classes/${id}/keys`)).forEach((k) => { state.keys[k.id] = k; });
  }
  state.results = await list(`classes/${id}/results`);
  render();
}

let respUnsub = null;
function watchResponses() {
  if (respUnsub) { respUnsub(); respUnsub = null; }
  const roundId = state.live?.roundId;
  if (!roundId) { state.responses = []; return; }
  state.responseError = null;
  respUnsub = watchList(
    `classes/${state.classId}/rounds/${roundId}/responses`,
    (rows) => {
      state.responses = rows;
      state.responseError = null;
      if (state.section === 'run') render();
    },
    (info) => {
      state.responseError = info;
      if (state.section === 'run') render();
    }
  );
}

function updatePoolNote() {
  const active = state.students.filter((s) => s.active !== false);
  const resting = active.filter((s) => s.resting);
  $('#pool-note').textContent = state.students.length
    ? `${active.length - resting.length} in the draw · ${resting.length} sitting out · ${state.questions.length} questions`
    : '';
}

/**
 * When the clock runs out the round marks itself, so the console shows who was
 * right without anyone having to press anything. Only the teacher's own
 * session does this, and only once per round.
 */
let autoRevealTimer = null;
let autoRevealedRound = null;

function armAutoReveal(live) {
  clearTimeout(autoRevealTimer);
  autoRevealTimer = null;
  if (!db.isAdmin) return;
  if (!live || live.phase !== 'asking' || !live.endsAt) return;
  if (autoRevealedRound === live.roundId) return;

  const wait = live.endsAt - Date.now();
  const fire = async () => {
    if (state.live?.roundId !== live.roundId || state.live?.phase !== 'asking') return;
    autoRevealedRound = live.roundId;
    await reveal({ auto: true });
  };
  autoRevealTimer = setTimeout(fire, Math.max(0, wait) + 400);
}

/* ---------- section switching ------------------------------------------- */

function show(name) {
  state.section = name;
  $$('.rail button[data-go]').forEach((b) => b.setAttribute('aria-current', b.dataset.go === name ? 'page' : 'false'));
  $$('.sec').forEach((s) => s.classList.toggle('hidden', s.id !== `sec-${name}`));
  render();
}

function render() {
  if (!state.classId) return;
  updatePoolNote();
  ({
    run: renderRun, students: renderStudents, questions: renderQuestions,
    awards: renderAwards, reports: renderReports, settings: renderSettings
  }[state.section] || renderRun)();
}

/* ---------- run the quiz ------------------------------------------------ */

function renderRun() {
  const root = $('#sec-run');
  root.textContent = '';

  if (!state.students.length || !state.questions.length) {
    root.appendChild(el('div', { class: 'empty' }, [
      el('h3', { text: 'Two things to load first' }),
      el('p', { text: `This class has ${state.students.length} students and ${state.questions.length} questions.` }),
      el('div', { class: 'row', style: 'justify-content:center' }, [
        el('button', { class: 'btn-primary', onclick: () => show('students'), text: 'Add the class list' }),
        el('button', { onclick: () => show('questions'), text: 'Add questions' })
      ])
    ]));
    return;
  }

  const live = state.live || { phase: 'idle' };
  const set = live.questions || [];
  const stage = el('div', { class: 'stage' });

  /* ---- left: who is up ---- */
  const left = el('div', { class: 'stack' });
  left.appendChild(el('h2', { text: live.phase === 'idle'
    ? 'Who is next'
    : (set.length > 1 ? `Round ${live.roundNo || 1}, ${set.length} questions` : `Round ${live.roundNo || 1}`) }));

  if (live.phase === 'idle') {
    const per = Math.max(1, Number(state.settings.questionsPerRound) || 1);
    left.appendChild(el('p', { class: 'muted tiny', text:
      `${state.settings.drawCount} students, drawn ${state.settings.drawMode === 'fair' ? 'with a nudge towards whoever has had fewest turns' : 'at random'}` +
      (per > 1 ? `, facing ${per} questions each.` : '.') }));
    left.appendChild(el('button', { class: 'btn-primary btn-big', onclick: doDraw, text: 'Draw students' }));
  } else {
    (live.drawn || []).forEach((p, i) => {
      const resp = state.responses.find((r) => r.id === p.id);
      const done = resp ? Object.keys(resp.answers || {}).length : 0;
      const result = (live.results || []).find((r) => r.studentId === p.id);
      const cls = ['podium-slot'];
      if (result) cls.push(result.correctCount > 0 ? 'is-correct' : 'is-wrong');
      else if (done < set.length && live.phase === 'asking') cls.push('waiting');
      left.appendChild(el('div', { class: cls.join(' ') }, [
        el('span', { class: 'seat', text: String(i + 1) }),
        el('span', { class: 'grow' }, [
          el('div', { class: 'who', text: p.name }),
          el('div', { class: 'tiny muted', text: result
            ? `${result.correctCount} of ${set.length} right · ${result.total > 0 ? '+' : ''}${result.total}`
            : live.phase === 'asking'
              ? (set.length > 1 ? `${done} of ${set.length} answered` : (done ? 'Answer locked in' : 'Thinking…'))
              : 'Ready' })
        ])
      ]));
    });
    if (live.phase !== 'revealed') {
      left.appendChild(el('button', { class: 'btn-ghost tiny', onclick: doDraw, text: 'Draw again' }));
    }
  }

  left.appendChild(attendancePanel());

  const resting = state.students.filter((s) => s.resting);
  if (resting.length) {
    left.appendChild(el('div', { class: 'panel', style: 'padding:14px 16px' }, [
      el('h3', { text: 'Sitting out' }),
      el('p', { class: 'tiny muted', text: 'They answered correctly, so the draw skips them until you bring them back.' }),
      ...resting.map((s) => el('div', { class: 'row', style: 'justify-content:space-between' }, [
        el('span', { text: s.name }),
        el('button', { class: 'tiny', onclick: () => wake(s.id), text: 'Back in' })
      ])),
      el('button', { class: 'tiny', onclick: wakeAll, text: 'Bring everyone back' })
    ]));
  }

  /* ---- centre ---- */
  const centre = el('div');
  centre.appendChild(set.length && live.phase !== 'idle' ? liveRoundCard(live) : questionSetPicker());

  /* ---- right: scoreboard ---- */
  const right = el('div', { class: 'panel' }, [el('h3', { text: 'Scoreboard' })]);
  const board = el('div', { class: 'lb' });
  const ranked = [...state.students]
    .filter((s) => s.active !== false)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  ranked.slice(0, 14).forEach((s, i) => {
    board.appendChild(el('div', { class: `lb-row ${i === 0 && s.score ? 'lead' : ''} ${s.resting ? 'rest' : ''}` }, [
      el('span', { class: 'rk', text: String(i + 1) }),
      el('span', { text: s.name }),
      el('span', { class: 'pts', text: String(s.score || 0) })
    ]));
  });
  right.appendChild(board);
  if (ranked.length > 14) right.appendChild(el('p', { class: 'tiny muted', text: `and ${ranked.length - 14} more` }));

  stage.append(left, centre, right);
  root.appendChild(stage);
}

/**
 * Marking who is absent belongs at the start of a lesson, next to the draw,
 * not three screens away on the class list. Held-out students are skipped by
 * the draw and keep the score they already had.
 */
function attendancePanel() {
  const away = state.students.filter((s) => s.active === false);
  const here = state.students.filter((s) => s.active !== false);

  const box = el('details', { class: 'panel', style: 'padding:14px 16px' });
  box.appendChild(el('summary', { style: 'cursor:pointer;font-weight:600' },
    `Who is here — ${here.length} in, ${away.length} away`));
  box.appendChild(el('p', { class: 'tiny muted', style: 'margin-top:8px',
    text: 'Tap a name to hold them out of the draw. Their score is kept.' }));

  const chips = el('div', { class: 'row wrap', style: 'gap:6px' });
  state.students.forEach((s) => {
    const out = s.active === false;
    chips.appendChild(el('button', {
      class: 'tiny',
      style: out
        ? 'opacity:.55;text-decoration:line-through'
        : 'border-color:var(--jade);color:var(--jade)',
      title: out ? 'Bring back into the draw' : 'Hold out of the draw',
      onclick: () => set(`classes/${state.classId}/students/${s.id}`, { active: out }),
      text: s.name
    }));
  });
  box.appendChild(chips);

  if (away.length) {
    box.appendChild(el('button', {
      class: 'tiny', style: 'margin-top:10px',
      onclick: async () => {
        for (const s of away) await set(`classes/${state.classId}/students/${s.id}`, { active: true });
        toast('Everyone is back in.');
      },
      text: 'Everyone is here today'
    }));
  }
  return box;
}

/* ---------- choosing the questions -------------------------------------- */

function questionSetPicker() {
  const per = Math.max(1, Number(state.settings.questionsPerRound) || 1);
  const box = el('div', { class: 'panel' });
  box.appendChild(el('div', { class: 'panel-head' }, [
    el('div', {}, [
      el('h3', { text: per > 1 ? `The ${per} questions for this round` : 'The question' }),
      el('p', { text: per > 1
        ? 'All of them go to the drawn students at once, and they answer at their own pace.'
        : 'Pick one, or let the app take the least-used question that matches.' })
    ])
  ]));

  const topics = [...new Set(state.questions.map((q) => q.topic).filter(Boolean))].sort();
  box.appendChild(el('div', { class: 'field-row' }, [
    el('div', {}, [
      el('label', { text: 'Topic' }),
      el('select', { onchange: (e) => { state.filters.topic = e.target.value; state.chosen = []; render(); } }, [
        el('option', { value: '', text: 'Any topic' }),
        ...topics.map((t) => el('option', { value: t, text: t, selected: state.filters.topic === t }))
      ])
    ]),
    el('div', {}, [
      el('label', { text: 'Difficulty' }),
      el('select', { onchange: (e) => { state.filters.difficulty = e.target.value; state.chosen = []; render(); } }, [
        el('option', { value: '', text: 'Any difficulty' }),
        ...[1, 2, 3, 4, 5].map((d) => el('option', { value: d, text: DIFFICULTY_NAMES[d], selected: String(state.filters.difficulty) === String(d) }))
      ])
    ]),
    el('div', {}, [
      el('label', { text: 'Type' }),
      el('select', { onchange: (e) => { state.filters.type = e.target.value; state.chosen = []; render(); } }, [
        el('option', { value: '', text: 'Any type' }),
        ...Object.entries(QUESTION_TYPES).map(([k, v]) => el('option', { value: k, text: v, selected: state.filters.type === k }))
      ])
    ])
  ]));

  const pool = filteredQuestions();
  if (!pool.length) {
    box.appendChild(el('p', { class: 'muted', text: 'Nothing matches those filters.' }));
    return box;
  }
  if (pool.length < per) {
    box.appendChild(el('div', { class: 'notice notice-warn',
      text: `Only ${pool.length} question${pool.length === 1 ? '' : 's'} match, and the round is set to ${per}. Widen the filters or lower the setting.` }));
  }

  const chosen = state.chosen.map((id) => state.questions.find((q) => q.id === id)).filter(Boolean);

  const send = el('div', { class: 'row wrap', style: 'margin:6px 0 16px' }, [
    el('button', {
      class: 'btn-go btn-big',
      onclick: () => askSet(chosen.length ? chosen : pickLeastUsed(pool, per)),
      text: chosen.length
        ? `Ask ${chosen.length === 1 ? 'this question' : `these ${chosen.length} questions`}`
        : (per > 1 ? `Ask the next ${per} questions` : 'Ask the next question')
    }),
    chosen.length ? el('button', { onclick: () => { state.chosen = []; render(); }, text: 'Clear the picks' }) : null
  ]);
  box.appendChild(send);

  if (chosen.length) {
    box.appendChild(el('p', { class: 'tiny muted', text: chosen.map((q, i) => `${i + 1}. ${q.text.slice(0, 48)}`).join('   ') }));
  }

  const table = el('table');
  table.appendChild(el('thead', {}, el('tr', {}, [
    el('th', { text: per > 1 ? 'Pick' : '' }), el('th', { text: 'Question' }), el('th', { text: 'Type' }),
    el('th', { text: 'Level' }), el('th', { class: 'num', text: 'Asked' }), el('th', {})
  ])));
  const body = el('tbody');
  pool.slice(0, 40).forEach((q) => {
    const at = state.chosen.indexOf(q.id);
    body.appendChild(el('tr', {}, [
      el('td', {}, per > 1
        ? el('button', {
            class: 'tiny',
            style: at >= 0 ? 'border-color:var(--jade);color:var(--jade)' : '',
            onclick: () => {
              if (at >= 0) state.chosen.splice(at, 1);
              else if (state.chosen.length < per) state.chosen.push(q.id);
              else toast(`This round takes ${per} questions. Remove one first.`, 'warn');
              render();
            },
            text: at >= 0 ? `#${at + 1}` : 'add'
          })
        : null),
      el('td', { text: q.text.length > 72 ? q.text.slice(0, 72) + '…' : q.text }),
      el('td', {}, el('span', { class: 'tag', text: typeLabel(q.type) })),
      el('td', { text: DIFFICULTY_NAMES[q.difficulty] }),
      el('td', { class: 'num', text: String(q.asked || 0) }),
      el('td', {}, per === 1 ? el('button', { class: 'tiny', onclick: () => askSet([q]), text: 'Ask this' }) : null)
    ]));
  });
  table.appendChild(body);
  box.appendChild(table);
  return box;
}

function filteredQuestions() {
  const f = state.filters;
  return state.questions.filter((q) =>
    (!f.topic || q.topic === f.topic) &&
    (!f.difficulty || String(q.difficulty) === String(f.difficulty)) &&
    (!f.type || q.type === f.type));
}

/** Takes the n least-used questions, breaking ties at random. */
function pickLeastUsed(pool, n) {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  shuffled.sort((a, b) => (a.asked || 0) - (b.asked || 0));
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

/* ---------- the live round ----------------------------------------------- */

function liveRoundCard(live) {
  const set = live.questions || [];
  const card = el('div', { class: 'qcard' });

  card.appendChild(el('div', { class: 'spread', style: 'margin-bottom:14px' }, [
    el('h3', { text: set.length > 1 ? `${set.length} questions in play` : 'In play' }),
    live.phase === 'asking' && live.endsAt ? countdownChip(live.endsAt) : null
  ]));

  if (live.phase === 'revealed') {
    card.appendChild(revealPanel(live));
  } else if (state.settings.answerMode === 'teacher') {
    card.appendChild(teacherEntryPanel(live));
  } else {
    if (state.responseError) {
      card.appendChild(el('div', { class: 'notice notice-bad' }, [
        el('div', { text: `Cannot read the answers coming in: ${state.responseError.code}. Do not reveal yet — everyone would be marked wrong.` }),
        state.responseError.hint ? el('div', { class: 'tiny', style: 'margin-top:5px', text: state.responseError.hint }) : null
      ]));
    }
    card.appendChild(progressTable(live));
    set.forEach((q, i) => card.appendChild(questionPreview(q, i, set.length, live)));
  }

  const controls = el('div', { class: 'row wrap', style: 'margin-top:20px' });
  if (live.phase === 'asking' || live.phase === 'drawn') {
    controls.append(
      el('button', { class: 'btn-primary btn-big', onclick: () => reveal(), text: 'Lock and show the answers' }),
      el('button', { onclick: cancelRound, text: 'Cancel this round' })
    );
  } else if (live.phase === 'revealed') {
    controls.append(
      el('button', { class: 'btn-go btn-big', onclick: nextRound, text: 'Next round' }),
      el('button', { onclick: undoRound, class: 'btn-danger', text: 'Undo the scoring' })
    );
  }
  card.appendChild(controls);
  return card;
}

/** Who has answered what, updating as it arrives. */
function progressTable(live) {
  const set = live.questions || [];
  const box = el('div', { class: 'stack' });
  const table = el('table');
  table.appendChild(el('thead', {}, el('tr', {}, [
    el('th', { text: 'Student' }),
    ...set.map((q, i) => el('th', { text: set.length > 1 ? `Q${i + 1}` : 'Their answer' })),
    el('th', { class: 'num', text: 'Done' })
  ])));
  const body = el('tbody');
  (live.drawn || []).forEach((p) => {
    const r = state.responses.find((x) => x.id === p.id);
    const done = r ? Object.keys(r.answers || {}).length : 0;
    body.appendChild(el('tr', {}, [
      el('td', { text: p.name }),
      ...set.map((q) => {
        const given = r?.answers?.[q.id];
        if (given === undefined) return el('td', { class: 'muted tiny', text: '—' });
        return el('td', { class: 'tiny', title: describeAnswer(q, given) }, [
          el('div', { text: describeAnswer(q, given).slice(0, 28) }),
          el('div', { class: 'muted', text: state.settings.rule === 'calibration'
            ? `${r.confidence?.[q.id] ?? '?'}%`
            : ['', 'not sure', 'fairly sure', 'certain'][r.confidence?.[q.id]] || '' })
        ]);
      }),
      el('td', { class: 'num', text: `${done}/${set.length}` })
    ]));
  });
  table.appendChild(body);
  box.appendChild(table);
  return box;
}

/** The teacher's own view of a question, with the answer tucked away. */
function questionPreview(q, i, total, live) {
  const key = state.keys[q.id];
  const wrap = el('details', { style: 'border-top:1px solid var(--line-soft);padding:10px 0' });
  wrap.appendChild(el('summary', { style: 'cursor:pointer' },
    total > 1 ? `Q${i + 1}. ${q.text}` : q.text));
  wrap.appendChild(questionMeta(q));
  if (key && db.isAdmin) wrap.appendChild(el('p', { class: 'tiny', text: `Answer: ${keyText(q, key)}` }));
  if (q.explanation) wrap.appendChild(el('p', { class: 'tiny muted', text: q.explanation }));
  return wrap;
}

function countdownChip(endsAt) {
  const chip = el('span', { class: 'tag tag-gold' });
  const tick = () => {
    const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    chip.textContent = left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : 'time is up';
    if (left && chip.isConnected) setTimeout(tick, 500);
  };
  tick();
  return chip;
}

function keyText(q, key) {
  switch (q.type) {
    case 'true_false': return key.answer === 'true' ? 'True' : 'False';
    case 'mcq_single': return `${LETTERS[key.answer]}. ${q.options[key.answer]}`;
    case 'mcq_multi': return key.answer.map((i) => `${LETTERS[i]}. ${q.options[i]}`).join(' · ');
    case 'matching': return key.answer.map((j, i) => `${q.left[i]} → ${q.right[j]}`).join(' · ');
    case 'ordering': return key.answer.map((i) => q.items[i]).join(' · ');
    default: return (key.answer || []).join(' / ');
  }
}

function teacherEntryPanel(live) {
  const set = live.questions || [];
  const box = el('div', { class: 'stack' });
  box.appendChild(el('p', { class: 'tiny muted', text: 'Ask each student how sure they are, then record what they say.' }));

  (live.drawn || []).forEach((p) => {
    const entry = (state.teacherEntry[p.id] ||= { answers: {}, confidence: {} });
    const panel = el('div', { class: 'panel', style: 'padding:16px 18px' }, [el('h3', { text: p.name })]);
    set.forEach((q, i) => {
      panel.appendChild(el('div', { style: 'border-top:1px solid var(--line-soft);margin-top:12px;padding-top:12px' }, [
        el('div', { style: 'font-weight:500;margin-bottom:8px', text: set.length > 1 ? `Q${i + 1}. ${q.text}` : q.text })
      ]));
      panel.appendChild(el('label', { text: 'How sure?' }));
      panel.appendChild(confidenceWidget(q, state.settings, {
        value: entry.confidence[q.id] ?? (state.settings.rule === 'calibration' ? 60 : 2),
        onChange: (v) => { entry.confidence[q.id] = v; }
      }));
      entry.confidence[q.id] ??= state.settings.rule === 'calibration' ? 60 : 2;
      panel.appendChild(el('div', { style: 'height:10px' }));
      panel.appendChild(answerWidget(q, {
        value: entry.answers[q.id],
        onChange: (v) => { entry.answers[q.id] = v; }
      }));
    });
    box.appendChild(panel);
  });
  return box;
}

function revealPanel(live) {
  const set = live.questions || [];
  const box = el('div', { class: 'stack' });

  if (live.autoRevealed) {
    box.appendChild(el('div', { class: 'notice notice-warn', text: 'Time ran out, so the round was marked automatically.' }));
  }

  const totals = el('table');
  totals.appendChild(el('thead', {}, el('tr', {}, [
    el('th', { text: 'Student' }), el('th', { class: 'num', text: 'Right' }), el('th', { class: 'num', text: 'Points' })
  ])));
  const tbody = el('tbody');
  [...(live.results || [])].sort((a, b) => b.total - a.total).forEach((r) => {
    tbody.appendChild(el('tr', {}, [
      el('td', { text: r.name }),
      el('td', { class: 'num' }, el('span', {
        class: `tag ${r.correctCount === set.length ? 'tag-jade' : r.correctCount ? 'tag-gold' : 'tag-rose'}`,
        text: `${r.correctCount} of ${set.length}`
      })),
      el('td', { class: 'num', style: `color:${r.total >= 0 ? 'var(--jade)' : 'var(--rose)'}`, text: `${r.total > 0 ? '+' : ''}${r.total}` })
    ]));
  });
  totals.appendChild(tbody);
  box.appendChild(totals);

  set.forEach((q, i) => {
    const key = (live.revealKeys || {})[q.id];
    const block = el('div', { style: 'border-top:1px solid var(--line);margin-top:18px;padding-top:14px' });
    block.appendChild(el('div', { style: 'font-weight:500;margin-bottom:6px', text: set.length > 1 ? `Q${i + 1}. ${q.text}` : q.text }));
    if (key) block.appendChild(el('div', { class: 'notice notice-ok', text: `Answer: ${keyText(q, key)}` }));
    if (q.explanation) block.appendChild(el('p', { class: 'tiny muted', text: q.explanation }));

    const t = el('table');
    t.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Student' }), el('th', { text: 'Said' }), el('th', { text: 'How sure' }),
      el('th', { text: 'Result' }), el('th', { class: 'num', text: 'Points' })
    ])));
    const tb = el('tbody');
    (live.results || []).forEach((r) => {
      const cell = (r.perQuestion || []).find((x) => x.questionId === q.id);
      if (!cell) return;
      tb.appendChild(el('tr', {}, [
        el('td', { text: r.name }),
        el('td', { text: describeAnswer(q, cell.answer) }),
        el('td', { text: state.settings.rule === 'calibration'
          ? `${cell.confidence}%`
          : ['', 'not sure', 'fairly sure', 'certain'][cell.confidence] || '—' }),
        el('td', {}, el('span', {
          class: `tag ${cell.fraction === 1 ? 'tag-jade' : cell.fraction > 0 ? 'tag-gold' : 'tag-rose'}`,
          text: cell.fraction === 1 ? 'Correct' : cell.fraction > 0 ? `${Math.round(cell.fraction * 100)}%` : 'Wrong'
        })),
        el('td', { class: 'num', style: `color:${cell.points >= 0 ? 'var(--jade)' : 'var(--rose)'}`, text: `${cell.points > 0 ? '+' : ''}${cell.points}` })
      ]));
    });
    t.appendChild(tb);
    block.appendChild(t);
    box.appendChild(block);
  });

  if (live.classStat) {
    box.appendChild(el('p', { class: 'tiny muted', text:
      `${live.classStat.right} of ${live.classStat.answers} practice answers from the rest of the class were right. They do not count towards anyone's score.` }));
  }
  return box;
}

/* ---------- round actions ------------------------------------------------ */

async function doDraw() {
  const { picked, poolSize } = drawStudents(state.students, {
    count: state.settings.drawCount,
    mode: state.settings.drawMode
  });
  if (!picked.length) { toast('Nobody is available. Bring some students back into the draw.', 'warn'); return; }
  if (poolSize < state.settings.drawCount) toast(`Only ${poolSize} students were available.`, 'warn');

  sfx.draw();
  state.chosen = [];
  await set(`classes/${state.classId}/live/now`, {
    phase: 'drawn',
    roundNo: (state.live?.roundNo || 0) + 1,
    roundId: null,
    questions: [],
    results: null,
    revealKeys: null,
    classStat: null,
    autoRevealed: false,
    drawn: picked.map((s) => ({ id: s.id, name: s.name })),
    settings: state.settings,
    drawnAt: Date.now()
  }, { merge: false });
}

/** Sends the whole set of questions to the drawn students at once. */
async function askSet(questions) {
  if (!questions || !questions.length) return;
  let live = state.live;
  if (!live || live.phase === 'idle' || live.phase === 'revealed' || !live.drawn?.length) {
    await doDraw();
    live = await get(`classes/${state.classId}/live/now`);
    if (!live?.drawn?.length) return;
  }

  const roundId = rid('round');
  state.teacherEntry = {};
  state.chosen = [];

  const seconds = questions.reduce((t, q) => t + (q.timeLimitSec || state.settings.timeLimitSec || 0), 0);

  await set(`classes/${state.classId}/rounds/${roundId}`, {
    questionIds: questions.map((q) => q.id),
    participants: live.drawn.map((d) => d.id),
    startedAt: Date.now()
  });
  await set(`classes/${state.classId}/live/now`, {
    phase: 'asking',
    roundId,
    questions,
    results: null,
    revealKeys: null,
    classStat: null,
    autoRevealed: false,
    startedAt: Date.now(),
    endsAt: seconds ? Date.now() + seconds * 1000 : null,
    settings: state.settings
  });
  sfx.tick();
}

/**
 * Marks everything. Called by the teacher, or on its own when the clock runs
 * out — waiting for someone to press a button while the class watches a dead
 * timer helps nobody.
 */
async function reveal({ auto = false } = {}) {
  const live = state.live;
  const qset = live?.questions || [];
  if (!qset.length || live.phase === 'revealed') return;

  if (state.responseError) {
    toast('The answers cannot be read right now. Fix that before revealing, or everyone will be scored as wrong.', 'bad');
    return;
  }

  const keys = {};
  for (const q of qset) {
    keys[q.id] = state.keys[q.id] || await get(`classes/${state.classId}/keys/${q.id}`);
    if (!keys[q.id]) { toast(`The answer key for "${q.text.slice(0, 30)}" is missing.`, 'bad'); return; }
  }

  if (!auto && state.settings.answerMode === 'devices') {
    const short = (live.drawn || []).filter((p) => {
      const r = state.responses.find((x) => x.id === p.id);
      return Object.keys(r?.answers || {}).length < qset.length;
    });
    if (short.length && !confirm(
      `${short.map((p) => p.name).join(' and ')} ${short.length > 1 ? 'have' : 'has'} not finished. ` +
      'Anything unanswered is scored as wrong. Carry on?')) return;
  }

  const results = [];
  for (const p of live.drawn || []) {
    const fromPhone = state.responses.find((x) => x.id === p.id);
    const typed = state.teacherEntry[p.id];
    const perQuestion = [];
    let total = 0, correctCount = 0;

    for (const q of qset) {
      const answer = state.settings.answerMode === 'teacher'
        ? typed?.answers?.[q.id] ?? null
        : fromPhone?.answers?.[q.id] ?? null;
      const confidence = (state.settings.answerMode === 'teacher'
        ? typed?.confidence?.[q.id]
        : fromPhone?.confidence?.[q.id]) ?? (state.settings.rule === 'calibration' ? 50 : 1);

      const { fraction, correct } = grade(q, keys[q.id], answer);
      const points = score(q, fraction, confidence, state.settings);
      total = Math.round((total + points) * 10) / 10;
      if (correct) correctCount++;
      perQuestion.push({ questionId: q.id, answer, confidence, fraction, correct, points });
    }
    results.push({ studentId: p.id, name: p.name, total, correctCount, perQuestion });
  }

  for (const r of results) {
    const s = state.students.find((x) => x.id === r.studentId);
    if (!s) continue;
    const streak = r.correctCount === qset.length ? (s.streak || 0) + qset.length : 0;
    await set(`classes/${state.classId}/students/${r.studentId}`, {
      score: round1((s.score || 0) + r.total),
      turns: (s.turns || 0) + qset.length,
      correct: (s.correct || 0) + r.correctCount,
      wrong: (s.wrong || 0) + (qset.length - r.correctCount),
      streak,
      bestStreak: Math.max(s.bestStreak || 0, streak),
      resting: r.correctCount > 0 && state.settings.restOnCorrect ? true : (s.resting || false),
      lastRound: live.roundId
    });
    for (const cell of r.perQuestion) {
      await set(`classes/${state.classId}/results/${live.roundId}--${r.studentId}--${cell.questionId}`, {
        studentId: r.studentId, questionId: cell.questionId, roundId: live.roundId,
        topic: qset.find((q) => q.id === cell.questionId)?.topic || null,
        difficulty: qset.find((q) => q.id === cell.questionId)?.difficulty,
        fraction: cell.fraction, points: cell.points,
        tier: state.settings.rule === 'calibration' ? null : cell.confidence,
        confidencePct: state.settings.rule === 'calibration' ? cell.confidence : cell.confidence * 33,
        at: Date.now()
      });
    }
  }

  let classStat = null;
  try {
    const shadow = await list(`classes/${state.classId}/rounds/${live.roundId}/shadow`);
    if (shadow.length) {
      let answers = 0, right = 0;
      shadow.forEach((r) => qset.forEach((q) => {
        if (r.answers?.[q.id] === undefined) return;
        answers++;
        if (grade(q, keys[q.id], r.answers[q.id]).correct) right++;
      }));
      if (answers) classStat = { answers, right, students: shadow.length };
    }
  } catch { /* nobody answered along */ }

  for (const q of qset) {
    await set(`classes/${state.classId}/questions/${q.id}`, { asked: (q.asked || 0) + 1 });
  }
  await set(`classes/${state.classId}/live/now`, {
    phase: 'revealed', results, revealKeys: keys, classStat, autoRevealed: auto
  });

  state.results = await list(`classes/${state.classId}/results`);
  results.some((r) => r.correctCount) ? sfx.right() : sfx.wrong();
}

async function nextRound() {
  state.chosen = [];
  await set(`classes/${state.classId}/live/now`, {
    phase: 'idle', drawn: [], results: null, questions: [], roundId: null,
    revealKeys: null, classStat: null, autoRevealed: false, endsAt: null
  });
  state.teacherEntry = {};
}

async function cancelRound() {
  const roundId = state.live?.roundId;
  if (roundId) {
    await delCollection(`classes/${state.classId}/rounds/${roundId}/responses`);
    await delCollection(`classes/${state.classId}/rounds/${roundId}/shadow`);
    await del(`classes/${state.classId}/rounds/${roundId}`);
  }
  await nextRound();
}

/** Puts back the scores from the round just revealed. */
async function undoRound() {
  const live = state.live;
  if (!live?.results) return;
  if (!confirm('Take back the points from this round?')) return;
  const qset = live.questions || [];

  for (const r of live.results) {
    const s = state.students.find((x) => x.id === r.studentId);
    if (!s) continue;
    await set(`classes/${state.classId}/students/${r.studentId}`, {
      score: round1((s.score || 0) - r.total),
      turns: Math.max(0, (s.turns || 0) - qset.length),
      correct: Math.max(0, (s.correct || 0) - r.correctCount),
      wrong: Math.max(0, (s.wrong || 0) - (qset.length - r.correctCount)),
      resting: false
    });
    for (const cell of r.perQuestion || []) {
      await del(`classes/${state.classId}/results/${live.roundId}--${r.studentId}--${cell.questionId}`);
    }
  }
  for (const q of qset) {
    const current = state.questions.find((x) => x.id === q.id);
    if (current) await set(`classes/${state.classId}/questions/${q.id}`, { asked: Math.max(0, (current.asked || 1) - 1) });
  }
  state.results = await list(`classes/${state.classId}/results`);
  await set(`classes/${state.classId}/live/now`, { phase: 'asking', results: null, revealKeys: null, autoRevealed: false });
  toast('Points taken back.');
}

async function wake(id) { await set(`classes/${state.classId}/students/${id}`, { resting: false }); }
async function wakeAll() {
  for (const s of state.students.filter((x) => x.resting)) await wake(s.id);
  toast('Everyone is back in the draw.');
}

function renderStudents() {
  const root = $('#sec-students');
  root.textContent = '';
  root.appendChild(el('header', {}, [
    el('h1', { text: 'Class list' }),
    el('p', { text: 'Paste a list once per class. CSV from a spreadsheet works, so does JSON.' })
  ]));

  const box = el('div', { class: 'panel' });
  box.appendChild(el('div', { class: 'panel-head' }, [
    el('div', {}, [el('h3', { text: 'Import' }), el('p', { text: 'Needs a name and an id for each student. A group or house column is optional.' })])
  ]));
  const ta = el('textarea', { placeholder: 'id,name,group\n9A-01,Aisha Rahman,Blue\n9A-02,Tenzin Dorji,Gold' });
  box.appendChild(ta);
  const report = el('div', { style: 'margin-top:12px' });
  box.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, [
    el('button', { class: 'btn-primary', onclick: () => doImport(false), text: 'Add these students' }),
    el('button', { onclick: () => doImport(true), text: 'Replace the whole list' }),
    el('button', { class: 'btn-ghost', onclick: () => { ta.value = SAMPLE_ROSTER; }, text: 'Paste an example' }),
    el('label', { class: 'row tiny', style: 'margin:0' }, [
      el('input', { type: 'file', accept: '.csv,.json,.txt,.tsv', style: 'max-width:200px',
        onchange: async (e) => { const f = e.target.files[0]; if (f) ta.value = await f.text(); } })
    ])
  ]));
  box.appendChild(report);
  root.appendChild(box);

  async function doImport(replace) {
    const { students, errors } = parseStudents(ta.value);
    report.textContent = '';
    if (errors.length) {
      report.appendChild(el('div', { class: 'notice notice-bad' }, errors.slice(0, 8).join(' ')));
    }
    if (!students.length) return;
    if (replace && !confirm(`Replace all ${state.students.length} students, including their scores?`)) return;
    if (replace) await delCollection(`classes/${state.classId}/students`);
    // keep existing scores when adding to a list
    const existing = Object.fromEntries(state.students.map((s) => [s.id, s]));
    const merged = students.map((s) => (!replace && existing[s.id])
      ? { ...s, score: existing[s.id].score, turns: existing[s.id].turns, correct: existing[s.id].correct, wrong: existing[s.id].wrong, resting: existing[s.id].resting }
      : s);
    await bulkSet(`classes/${state.classId}/students`, merged);
    report.appendChild(el('div', { class: 'notice notice-ok' }, `${merged.length} students saved.`));
    ta.value = '';
    toast(`${merged.length} students in ${state.cls.name}`);
  }

  if (!state.students.length) {
    root.appendChild(el('div', { class: 'empty', style: 'margin-top:18px' }, [
      el('h3', { text: 'No students yet' }),
      el('p', { text: 'Paste the list above and they will appear here.' })
    ]));
    return;
  }

  const listBox = el('div', { class: 'panel' });
  listBox.appendChild(el('div', { class: 'panel-head' }, [
    el('h3', { text: `${state.students.length} students` }),
    el('div', { class: 'row' }, [
      el('button', { class: 'tiny', onclick: exportRoster, text: 'Download as CSV' }),
      el('button', { class: 'tiny', onclick: releaseAll, text: 'Release all phones' }),
      el('button', { class: 'tiny btn-danger', onclick: resetScores, text: 'Reset all scores' })
    ])
  ]));
  const table = el('table');
  table.appendChild(el('thead', {}, el('tr', {}, [
    el('th', { text: 'Name' }), el('th', { text: 'Id' }), el('th', { text: 'Group' }),
    el('th', { class: 'num', text: 'Points' }), el('th', { class: 'num', text: 'Turns' }),
    el('th', { text: 'Attendance' }), el('th', { text: 'Phone' }), el('th', {})
  ])));
  const body = el('tbody');
  state.students.forEach((s) => {
    body.appendChild(el('tr', {}, [
      el('td', { text: s.name }),
      el('td', { class: 'tiny muted', text: s.id }),
      el('td', { text: s.group || '—' }),
      el('td', { class: 'num', text: String(s.score || 0) }),
      el('td', { class: 'num', text: String(s.turns || 0) }),
      el('td', {}, el('div', { class: 'row', style: 'gap:8px' }, [
        el('button', {
          class: 'tiny',
          onclick: () => set(`classes/${state.classId}/students/${s.id}`, { active: s.active === false }),
          text: s.active === false ? 'Mark present' : 'Mark away'
        }),
        s.active === false
          ? el('span', { class: 'tag', text: 'away' })
          : s.resting
            ? el('span', { class: 'tag tag-gold', text: 'sitting out' })
            : el('span', { class: 'tag tag-jade', text: 'in' })
      ])),
      el('td', {}, seatCell(s)),
      el('td', {}, el('button', { class: 'tiny btn-danger', onclick: () => removeStudent(s), text: 'Remove' }))
    ]));
  });
  table.appendChild(body);
  listBox.appendChild(table);
  root.appendChild(listBox);

  /* A name is tied to the first phone that picks it, so nobody can answer as
     someone else. When a student changes phone or clears their browser, the
     old claim has to be let go before they can get back in. */
  function seatCell(s) {
    const seat = state.seats.find((x) => x.id === s.id);
    if (!seat) return el('span', { class: 'tiny muted', text: 'not joined' });
    return el('span', { class: 'row', style: 'gap:6px' }, [
      el('span', { class: 'tag tag-jade', text: 'joined' }),
      el('button', {
        class: 'tiny btn-ghost',
        title: 'Let this student sign in from a different phone',
        onclick: async () => {
          if (!confirm(`Release ${s.name}'s name? They can then join again from any phone.`)) return;
          await del(`classes/${state.classId}/seats/${s.id}`);
          toast(`${s.name} can join again.`);
        },
        text: 'Release'
      })
    ]);
  }

  async function removeStudent(s) {
    if (!confirm(`Remove ${s.name} from ${state.cls.name}?`)) return;
    await del(`classes/${state.classId}/students/${s.id}`);
    await del(`classes/${state.classId}/seats/${s.id}`);
  }
  function exportRoster() {
    download(`${state.classId}-class-list.csv`, toCsv(state.students, [
      { label: 'id', key: 'id' }, { label: 'name', key: 'name' }, { label: 'group', key: 'group' },
      { label: 'points', key: 'score' }, { label: 'turns', key: 'turns' }, { label: 'correct', key: 'correct' }
    ]), 'text/csv');
  }
  async function releaseAll() {
    if (!confirm('Release every name? Students will each pick their name again on their phone.')) return;
    await delCollection(`classes/${state.classId}/seats`);
    toast('All names released.');
  }

  async function resetScores() {
    if (!confirm('Set every score, turn count and streak back to zero?')) return;
    for (const s of state.students) {
      await set(`classes/${state.classId}/students/${s.id}`, { score: 0, turns: 0, correct: 0, wrong: 0, streak: 0, bestStreak: 0, resting: false });
    }
    await delCollection(`classes/${state.classId}/results`);
    state.results = [];
    toast('Scores cleared.');
  }
}

/* ---------- questions ---------------------------------------------------- */

function renderQuestions() {
  const root = $('#sec-questions');
  root.textContent = '';
  root.appendChild(el('header', {}, [
    el('h1', { text: 'Questions' }),
    el('p', { text: 'Paste JSON. Answers are stored apart from the questions, so a student who opens the browser console still cannot read them.' })
  ]));

  const box = el('div', { class: 'panel' });
  box.appendChild(el('div', { class: 'panel-head' }, [
    el('div', {}, [el('h3', { text: 'Import' }), el('p', { text: 'True/false, one answer, several answers, matching, ordering, written.' })])
  ]));
  const ta = el('textarea', { placeholder: '{ "questions": [ … ] }', style: 'min-height:200px' });
  box.appendChild(ta);
  const report = el('div', { style: 'margin-top:12px' });
  box.appendChild(el('div', { class: 'row wrap', style: 'margin-top:12px' }, [
    el('button', { class: 'btn-primary', onclick: () => doImport(false), text: 'Add these questions' }),
    el('button', { onclick: () => doImport(true), text: 'Replace the bank' }),
    el('button', { class: 'btn-ghost', onclick: loadSample, text: 'Load the example file' }),
    el('label', { class: 'row tiny', style: 'margin:0' }, [
      el('input', { type: 'file', accept: '.json,.txt', style: 'max-width:200px',
        onchange: async (e) => { const f = e.target.files[0]; if (f) ta.value = await f.text(); } })
    ])
  ]));
  box.appendChild(report);
  root.appendChild(box);

  async function loadSample() {
    try {
      const res = await fetch('samples/questions.sample.json');
      ta.value = await res.text();
    } catch { toast('Could not read the example file.', 'bad'); }
  }

  async function doImport(replace) {
    const { questions, keys, errors, warnings } = parseQuestions(ta.value);
    report.textContent = '';
    if (errors.length) {
      report.appendChild(el('div', { class: 'notice notice-bad' }, [
        el('div', { style: 'font-weight:600;margin-bottom:4px', text: `${errors.length} question${errors.length > 1 ? 's' : ''} could not be read:` }),
        ...errors.slice(0, 10).map((e) => el('div', { text: e }))
      ]));
    }
    if (warnings.length) report.appendChild(el('div', { class: 'notice notice-warn' }, warnings.slice(0, 5).join(' ')));
    if (!questions.length) return;
    if (replace && !confirm(`Replace all ${state.questions.length} questions?`)) return;
    if (replace) {
      await delCollection(`classes/${state.classId}/questions`);
      await delCollection(`classes/${state.classId}/keys`);
    }
    await bulkSet(`classes/${state.classId}/questions`, questions);
    await bulkSet(`classes/${state.classId}/keys`, Object.values(keys));
    Object.assign(state.keys, keys);
    report.appendChild(el('div', { class: 'notice notice-ok' }, `${questions.length} questions saved.`));
    ta.value = '';
    toast(`${questions.length} questions ready`);
  }

  if (!state.questions.length) {
    root.appendChild(el('div', { class: 'empty', style: 'margin-top:18px' }, [
      el('h3', { text: 'The bank is empty' }),
      el('p', { text: 'Load the example file above to see the format, then swap in your own.' })
    ]));
    return;
  }

  const bank = el('div', { class: 'panel' });
  bank.appendChild(el('div', { class: 'panel-head' }, [
    el('h3', { text: `${state.questions.length} questions` }),
    el('div', { class: 'row' }, [
      el('button', { class: 'tiny', onclick: exportQuestions, text: 'Download as JSON' }),
      el('button', { class: 'tiny', onclick: () => resetAsked(), text: 'Reset the asked counts' })
    ])
  ]));
  const table = el('table');
  table.appendChild(el('thead', {}, el('tr', {}, [
    el('th', { text: 'Question' }), el('th', { text: 'Topic' }), el('th', { text: 'Type' }),
    el('th', { text: 'Level' }), el('th', { class: 'num', text: 'Asked' }), el('th', {})
  ])));
  const body = el('tbody');
  state.questions.forEach((q) => {
    body.appendChild(el('tr', {}, [
      el('td', {}, [
        el('div', { text: q.text.length > 90 ? q.text.slice(0, 90) + '…' : q.text }),
        state.keys[q.id] ? el('div', { class: 'tiny muted', text: `answer: ${keyText(q, state.keys[q.id])}` }) : null
      ]),
      el('td', { text: q.topic || '—' }),
      el('td', {}, el('span', { class: 'tag', text: typeLabel(q.type) })),
      el('td', { text: DIFFICULTY_NAMES[q.difficulty] }),
      el('td', { class: 'num', text: String(q.asked || 0) }),
      el('td', {}, el('button', { class: 'tiny btn-danger', onclick: () => removeQuestion(q), text: 'Delete' }))
    ]));
  });
  table.appendChild(body);
  bank.appendChild(table);
  root.appendChild(bank);

  async function removeQuestion(q) {
    if (!confirm('Delete this question?')) return;
    await del(`classes/${state.classId}/questions/${q.id}`);
    await del(`classes/${state.classId}/keys/${q.id}`);
    delete state.keys[q.id];
  }
  function exportQuestions() {
    const out = state.questions.map((q) => {
      const k = state.keys[q.id] || {};
      const { asked, ...rest } = q;
      return { ...rest, answer: k.answer, caseSensitive: k.caseSensitive };
    });
    download(`${state.classId}-questions.json`, JSON.stringify({ class: state.cls.name, questions: out }, null, 2), 'application/json');
  }
  async function resetAsked() {
    for (const q of state.questions) await set(`classes/${state.classId}/questions/${q.id}`, { asked: 0 });
    toast('Counts reset.');
  }
}

/* ---------- prizes ------------------------------------------------------- */

function renderAwards() {
  const root = $('#sec-awards');
  root.textContent = '';
  root.appendChild(el('header', {}, [
    el('h1', { text: 'Prizes' }),
    el('p', { text: 'The podium updates as you play. The named awards spread the recognition further than the top three.' })
  ]));

  const { podium, awards, ranked } = computeAwards(state.students, state.results, state.settings);

  if (!podium.length) {
    root.appendChild(el('div', { class: 'empty' }, [
      el('h3', { text: 'No rounds played yet' }),
      el('p', { text: 'Come back once the class has answered a few questions.' })
    ]));
  } else {
    const box = el('div', { class: 'panel' });
    box.appendChild(el('div', { class: 'panel-head' }, [
      el('h3', { text: 'Standing' }),
      el('button', { class: 'tiny', onclick: () => sfx.fanfare(), text: 'Drum roll' })
    ]));
    const order = [podium[1], podium[0], podium[2]];
    const cls = ['p2', 'p1', 'p3'];
    box.appendChild(el('div', { class: 'podium' }, order.map((s, i) => s
      ? el('div', { class: `plinth ${cls[i]}` }, [
          el('div', { class: 'who', text: s.name }),
          el('div', { class: 'pts', text: String(s.score) }),
          el('div', { class: 'tiny muted', text: `${s.correct || 0} of ${s.turns || 0} right` })
        ])
      : el('div', {}))));
    root.appendChild(box);

    if (awards.length) {
      const ab = el('div', { class: 'panel' }, [
        el('div', { class: 'panel-head' }, el('div', {}, [
          el('h3', { text: 'Named awards' }),
          el('p', { text: 'Worked out from the round-by-round record.' })
        ]))
      ]);
      ab.appendChild(el('div', { class: 'badge-grid' }, awards.map((a) =>
        el('div', { class: 'badge' }, [
          el('div', { class: 'title', text: a.title }),
          el('div', { class: 'who', text: a.who }),
          el('div', { class: 'why', text: a.why })
        ]))));
      root.appendChild(ab);
    }
  }

  /* prize register */
  const pb = el('div', { class: 'panel' });
  pb.appendChild(el('div', { class: 'panel-head' }, [
    el('div', {}, [el('h3', { text: 'What you are giving out' }), el('p', { text: 'Note the prizes here, then assign them when you are ready.' })]),
    el('button', { class: 'tiny', onclick: addPrize, text: 'Add a prize' })
  ]));

  if (!state.prizes.length) {
    pb.appendChild(el('p', { class: 'muted', text: 'Nothing listed yet. A book, a canteen voucher, choice of seat for a week — whatever works in your room.' }));
  } else {
    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Prize' }), el('th', { text: 'Goes to' }), el('th', {})
    ])));
    const body = el('tbody');
    state.prizes.forEach((p) => {
      body.appendChild(el('tr', {}, [
        el('td', {}, [el('div', { text: p.name }), p.note ? el('div', { class: 'tiny muted', text: p.note }) : null]),
        el('td', {}, el('select', {
          onchange: (e) => set(`classes/${state.classId}/prizes/${p.id}`, { awardedTo: e.target.value || null })
        }, [
          el('option', { value: '', text: 'Not yet decided' }),
          ...ranked.map((s) => el('option', { value: s.id, text: `${s.name} — ${s.score}`, selected: p.awardedTo === s.id }))
        ])),
        el('td', {}, el('button', { class: 'tiny btn-danger', onclick: () => del(`classes/${state.classId}/prizes/${p.id}`), text: 'Remove' }))
      ]));
    });
    table.appendChild(body);
    pb.appendChild(table);
    pb.appendChild(el('button', { class: 'tiny', style: 'margin-top:12px', onclick: exportPrizes, text: 'Download the award sheet' }));
  }
  root.appendChild(pb);

  async function addPrize() {
    const name = prompt('What is the prize?');
    if (!name) return;
    const note = prompt('A note for yourself, or leave blank') || '';
    await set(`classes/${state.classId}/prizes/${rid('prize')}`, { name, note, awardedTo: null });
  }
  function exportPrizes() {
    const nameOf = (id) => state.students.find((s) => s.id === id)?.name || '';
    download(`${state.classId}-prizes.csv`, toCsv(state.prizes, [
      { label: 'prize', key: 'name' }, { label: 'note', key: 'note' },
      { label: 'student', get: (p) => nameOf(p.awardedTo) }
    ]), 'text/csv');
  }
}

/* ---------- results ------------------------------------------------------ */

function renderReports() {
  const root = $('#sec-reports');
  root.textContent = '';
  root.appendChild(el('header', {}, [
    el('h1', { text: 'Results' }),
    el('p', { text: 'Everything the class has answered so far, and where it went wrong.' })
  ]));

  if (!state.results.length) {
    root.appendChild(el('div', { class: 'empty' }, [
      el('h3', { text: 'Nothing recorded yet' }),
      el('p', { text: 'Results appear here as soon as you reveal an answer.' })
    ]));
    return;
  }

  const byStudent = {};
  state.results.forEach((r) => { (byStudent[r.studentId] ||= []).push(r); });

  const sb = el('div', { class: 'panel' });
  sb.appendChild(el('div', { class: 'panel-head' }, [
    el('h3', { text: 'By student' }),
    el('button', { class: 'tiny', onclick: exportResults, text: 'Download every answer' })
  ]));
  const table = el('table');
  const cols = [
    el('th', { text: 'Student' }), el('th', { class: 'num', text: 'Points' }),
    el('th', { class: 'num', text: 'Turns' }), el('th', { class: 'num', text: 'Correct' }),
    el('th', { class: 'num', text: 'Avg confidence' })
  ];
  if (state.settings.rule === 'calibration') cols.push(el('th', { class: 'num', text: 'Calibration' }));
  table.appendChild(el('thead', {}, el('tr', {}, cols)));
  const body = el('tbody');
  [...state.students].sort((a, b) => (b.score || 0) - (a.score || 0)).forEach((s) => {
    const rs = byStudent[s.id] || [];
    const avgConf = rs.length ? Math.round(rs.reduce((t, r) => t + (r.confidencePct || 0), 0) / rs.length) : null;
    const b = brierMean(rs);
    const cells = [
      el('td', { text: s.name }),
      el('td', { class: 'num', text: String(s.score || 0) }),
      el('td', { class: 'num', text: String(s.turns || 0) }),
      el('td', { class: 'num', text: s.turns ? `${Math.round(100 * (s.correct || 0) / s.turns)}%` : '—' }),
      el('td', { class: 'num', text: avgConf === null ? '—' : `${avgConf}%` })
    ];
    if (state.settings.rule === 'calibration') {
      cells.push(el('td', { class: 'num', text: b === null ? '—' : b.toFixed(2) }));
    }
    body.appendChild(el('tr', {}, cells));
  });
  table.appendChild(body);
  sb.appendChild(table);
  root.appendChild(sb);

  /* which questions caught people out */
  const byQ = {};
  state.results.forEach((r) => { (byQ[r.questionId] ||= []).push(r); });
  const hard = Object.entries(byQ)
    .map(([qid, rs]) => ({
      q: state.questions.find((x) => x.id === qid),
      n: rs.length,
      rate: rs.reduce((t, r) => t + r.fraction, 0) / rs.length
    }))
    .filter((x) => x.q && x.n >= 2)
    .sort((a, b) => a.rate - b.rate)
    .slice(0, 8);

  if (hard.length) {
    const hb = el('div', { class: 'panel' });
    hb.appendChild(el('div', { class: 'panel-head' }, el('div', {}, [
      el('h3', { text: 'Worth going over again' }),
      el('p', { text: 'The questions this class got least right.' })
    ])));
    const t2 = el('table');
    t2.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Question' }), el('th', { text: 'Topic' }),
      el('th', { class: 'num', text: 'Asked' }), el('th', { class: 'num', text: 'Got it right' })
    ])));
    const b2 = el('tbody');
    hard.forEach((h) => b2.appendChild(el('tr', {}, [
      el('td', { text: h.q.text.length > 80 ? h.q.text.slice(0, 80) + '…' : h.q.text }),
      el('td', { text: h.q.topic || '—' }),
      el('td', { class: 'num', text: String(h.n) }),
      el('td', { class: 'num', text: `${Math.round(h.rate * 100)}%` })
    ])));
    t2.appendChild(b2);
    hb.appendChild(t2);
    root.appendChild(hb);
  }

  /* calibration chart */
  if (state.settings.rule === 'calibration') {
    const buckets = calibrationBuckets(state.results);
    if (buckets.length) {
      const cb = el('div', { class: 'panel' });
      cb.appendChild(el('div', { class: 'panel-head' }, el('div', {}, [
        el('h3', { text: 'Confidence against reality' }),
        el('p', { text: 'When the class says 80%, are they right about 80% of the time? The closer the two bars, the better the class reads itself.' })
      ])));
      buckets.forEach((b) => {
        cb.appendChild(el('div', { style: 'margin-bottom:14px' }, [
          el('div', { class: 'tiny muted', text: `said ${b.label} · ${b.n} answers` }),
          bar(b.stated, 'var(--violet)', 'said'),
          bar(b.actual, 'var(--jade)', 'were right')
        ]));
      });
      root.appendChild(cb);
    }
  }

  function bar(pct, colour, label) {
    return el('div', { class: 'row', style: 'gap:8px;margin-top:3px' }, [
      el('div', { style: `height:12px;border-radius:3px;background:${colour};width:${Math.max(2, pct)}%` }),
      el('span', { class: 'tiny muted', text: `${pct}% ${label}` })
    ]);
  }

  function exportResults() {
    const nameOf = (id) => state.students.find((s) => s.id === id)?.name || id;
    const textOf = (id) => state.questions.find((q) => q.id === id)?.text || id;
    download(`${state.classId}-answers.csv`, toCsv(state.results, [
      { label: 'student', get: (r) => nameOf(r.studentId) },
      { label: 'question', get: (r) => textOf(r.questionId) },
      { label: 'topic', key: 'topic' },
      { label: 'difficulty', key: 'difficulty' },
      { label: 'confidence', key: 'confidencePct' },
      { label: 'how right', get: (r) => Math.round(r.fraction * 100) + '%' },
      { label: 'points', key: 'points' },
      { label: 'when', get: (r) => new Date(r.at).toISOString() }
    ]), 'text/csv');
  }
}

/* ---------- settings ------------------------------------------------------ */

function renderSettings() {
  const root = $('#sec-settings');
  root.textContent = '';
  root.appendChild(el('header', {}, [
    el('h1', { text: 'Settings' }),
    el('p', { text: `These apply to ${state.cls?.name || 'this class'} only, so different year groups can be scored differently.` })
  ]));

  const s = { ...state.settings };
  const save = async () => {
    state.settings = s;
    sfx.enabled = s.sound !== false;
    await set(`classes/${state.classId}`, { settings: s });
    if (state.live) await set(`classes/${state.classId}/live/now`, { settings: s });
    toast('Saved');
    render();
  };

  const scoring = el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, el('div', {}, [
      el('h3', { text: 'How points work' }),
      el('p', { text: 'Both rules use the question difficulty as the base. The difference is how confidence enters.' })
    ]))
  ]);
  scoring.appendChild(el('label', { class: 'check' }, [
    el('input', { type: 'radio', name: 'rule', checked: s.rule === 'tiers', onchange: () => { s.rule = 'tiers'; } }),
    el('span', {}, [
      el('strong', { text: 'Three levels: not sure, fairly sure, certain. ' }),
      el('span', { class: 'muted', text: 'Right answers pay difficulty × level. Wrong ones cost difficulty × (level − 1), so being unsure and wrong is free. Quick to explain to a class that has never done this before.' })
    ])
  ]));
  scoring.appendChild(el('label', { class: 'check' }, [
    el('input', { type: 'radio', name: 'rule', checked: s.rule === 'calibration', onchange: () => { s.rule = 'calibration'; } }),
    el('span', {}, [
      el('strong', { text: 'A percentage from 5 to 99. ' }),
      el('span', { class: 'muted', text: 'Scored so that the way to win over a term is to say what you actually believe. Bluffing high and hedging low both cost points. Zero sits at an honest guess, so nobody is punished for admitting they do not know.' })
    ])
  ]));
  scoring.appendChild(el('div', { class: 'field-row', style: 'margin-top:14px' }, [
    el('div', {}, [
      el('label', { text: 'Wrong-answer penalty (three-level rule only)' }),
      el('input', { type: 'number', min: '0', max: '3', step: '0.5', value: String(s.penalty), onchange: (e) => { s.penalty = Number(e.target.value); } })
    ]),
    el('div', {}, [
      el('label', { text: 'Seconds per question' }),
      el('input', { type: 'number', min: '0', max: '600', value: String(s.timeLimitSec), onchange: (e) => { s.timeLimitSec = Number(e.target.value); } })
    ])
  ]));
  root.appendChild(scoring);

  const draw = el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, el('div', {}, [el('h3', { text: 'The draw' })]))
  ]);
  draw.appendChild(el('div', { class: 'field-row' }, [
    el('div', {}, [
      el('label', { text: 'Students per round' }),
      el('input', { type: 'number', min: '1', max: '8', value: String(s.drawCount), onchange: (e) => { s.drawCount = Number(e.target.value); } })
    ]),
    el('div', {}, [
      el('label', { text: 'Questions per round' }),
      el('input', { type: 'number', min: '1', max: '10', value: String(s.questionsPerRound || 1),
        onchange: (e) => { s.questionsPerRound = Math.max(1, Number(e.target.value) || 1); } })
    ]),
    el('div', {}, [
      el('label', { text: 'How they are picked' }),
      el('select', { onchange: (e) => { s.drawMode = e.target.value; } }, [
        el('option', { value: 'fair', text: 'Leans towards whoever has had fewest turns', selected: s.drawMode === 'fair' }),
        el('option', { value: 'random', text: 'Flat random', selected: s.drawMode === 'random' })
      ])
    ]),
    el('div', {}, [
      el('label', { text: 'Who types the answer' }),
      el('select', { onchange: (e) => { s.answerMode = e.target.value; } }, [
        el('option', { value: 'devices', text: 'Students, on their own phones', selected: s.answerMode === 'devices' }),
        el('option', { value: 'teacher', text: 'You, as they answer out loud', selected: s.answerMode === 'teacher' })
      ])
    ])
  ]));
  draw.appendChild(el('h3', { style: 'margin-top:18px', text: 'How students join' }));
  draw.appendChild(el('label', { class: 'check' }, [
    el('input', { type: 'radio', name: 'join', checked: !s.lockToDevice, onchange: () => { s.lockToDevice = false; } }),
    el('span', {}, [
      el('strong', { text: 'They enter their student ID. ' }),
      el('span', { class: 'muted', text: 'The name list does not show IDs, so picking a classmate\'s name gets them nowhere. A student who changes phone or clears their browser gets back in on their own.' })
    ])
  ]));
  draw.appendChild(el('label', { class: 'check' }, [
    el('input', { type: 'radio', name: 'join', checked: !!s.lockToDevice, onchange: () => { s.lockToDevice = true; } }),
    el('span', {}, [
      el('strong', { text: 'First phone to pick a name keeps it. ' }),
      el('span', { class: 'muted', text: 'Nothing to remember and nothing to guess, but every changed or wiped phone needs you to press Release on the class list.' })
    ])
  ]));

  draw.appendChild(el('label', { class: 'check', style: 'margin-top:12px' }, [
    el('input', { type: 'checkbox', checked: s.restOnCorrect, onchange: (e) => { s.restOnCorrect = e.target.checked; } }),
    el('span', { text: 'A student who answers correctly sits out the next draws until you bring them back. With more than one question per round, this waits until the round is over.' })
  ]));
  draw.appendChild(el('label', { class: 'check' }, [
    el('input', { type: 'checkbox', checked: s.sound !== false, onchange: (e) => { s.sound = e.target.checked; } }),
    el('span', { text: 'Sound cues on the draw and the reveal' })
  ]));
  root.appendChild(draw);

  root.appendChild(el('div', { class: 'row', style: 'margin-top:18px' }, [
    el('button', { class: 'btn-primary', onclick: save, text: 'Save settings' })
  ]));

  const danger = el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, el('div', {}, [
      el('h3', { text: 'Backup and clean-up' }),
      el('p', { text: db.mode === 'local' ? 'This device holds the only copy. Download a backup before you clear your browser data.' : 'Your data lives in Firebase. A download is still handy for records.' })
    ]))
  ]);
  danger.appendChild(el('div', { class: 'row wrap' }, [
    el('button', { onclick: backup, text: 'Download a backup' }),
    db.mode === 'local' ? el('label', { class: 'row tiny', style: 'margin:0' }, [
      el('span', { text: 'Restore:' }),
      el('input', { type: 'file', accept: '.json', style: 'max-width:180px', onchange: restore })
    ]) : null,
    el('button', { class: 'btn-danger', onclick: wipeClass, text: 'Delete this class' })
  ]));
  root.appendChild(danger);

  async function backup() {
    const payload = db.mode === 'local' ? dumpLocal() : {
      class: state.cls, students: state.students, questions: state.questions,
      keys: state.keys, results: state.results, prizes: state.prizes
    };
    download(`quiz-arena-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json');
  }
  async function restore(e) {
    const f = e.target.files[0];
    if (!f || !confirm('Replace everything on this device with the backup?')) return;
    loadLocal(JSON.parse(await f.text()));
    location.reload();
  }
  async function wipeClass() {
    if (!confirm(`Delete ${state.cls.name} with its students, questions and results? This cannot be undone.`)) return;
    for (const c of ['students', 'questions', 'keys', 'results', 'prizes', 'rounds', 'live']) {
      await delCollection(`classes/${state.classId}/${c}`);
    }
    await del(`classes/${state.classId}`);
    localStorage.removeItem('quizarena:class');
    location.reload();
  }
}

/* ---------- misc ---------------------------------------------------------- */

const round1 = (n) => Math.round(n * 10) / 10;

const SAMPLE_ROSTER = `id,name,group
9A-01,Aisha Rahman,Blue
9A-02,Tenzin Dorji,Gold
9A-03,Marcus Oyelaran,Blue
9A-04,Priya Nair,Gold
9A-05,Liam Kavanagh,Blue
9A-06,Sofia Marchetti,Gold`;
