/* ---------------------------------------------------------------------------
   play.js — what a student sees on their phone.

   Drawn students answer for points. Everyone else can still answer along,
   which is saved separately and never counted, so the other twenty-eight
   people in the room have something to do while two of them are on the spot.
--------------------------------------------------------------------------- */

import { initDb, db, get, set, list, watchDoc } from './db.js';
import { DEFAULT_SETTINGS } from './model.js';
import { el, $, answerWidget, confidenceWidget, questionMeta, sfx, toast } from './render.js';

const app = $('#app');
const state = {
  classId: localStorage.getItem('quizarena:play:class') || null,
  studentId: localStorage.getItem('quizarena:play:student') || null,
  student: null,
  cls: null,
  live: null,
  settings: { ...DEFAULT_SETTINGS },
  submittedRound: null,
  seat: { ok: true },
  draft: { answer: null, confidence: null }
};

let liveUnsub = null;
let meUnsub = null;

await initDb();

if (db.mode === 'local') {
  app.appendChild(el('div', { class: 'notice notice-warn' },
    'This copy is not connected to Firebase, so it only sees quizzes created in this same browser. Your teacher needs to add the Firebase settings for phones to join.'));
}

if (state.classId && state.studentId) await joinExisting();
else await renderJoin();

/* ---------- joining ------------------------------------------------------ */

async function renderJoin() {
  $('#head').classList.add('hidden');
  app.textContent = '';
  const classes = await list('classes');

  if (!classes.length) {
    app.appendChild(el('div', { class: 'empty' }, [
      el('h3', { text: 'No classes yet' }),
      el('p', { text: 'Your teacher has not set one up, or this link points at a different project.' })
    ]));
    return;
  }

  const box = el('div', { class: 'panel' });
  box.appendChild(el('h2', { text: 'Find your name' }));

  const classSel = el('select', {}, classes.map((c) =>
    el('option', { value: c.id, text: c.name || c.id, selected: c.id === state.classId })));

  const search = el('input', { type: 'search', placeholder: 'Start typing your name', autocomplete: 'off' });
  const names = el('div', { class: 'stack', style: 'margin-top:12px;max-height:46vh;overflow-y:auto' });
  let roster = [];

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const shown = roster.filter((s) => !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q));
    names.textContent = '';
    if (!roster.length) {
      names.appendChild(el('p', { class: 'muted', text: 'Nobody is on this class list yet. Ask your teacher.' }));
      return;
    }
    if (!shown.length) {
      names.appendChild(el('p', { class: 'muted', text: 'No name matches that.' }));
      return;
    }
    shown.slice(0, 60).forEach((s) => {
      names.appendChild(el('button', {
        class: 'opt', style: 'width:100%;text-align:left;font-size:var(--step-1);padding:14px 16px',
        onclick: () => pick(s)
      }, [
        el('span', { class: 'grow', text: s.name }),
        el('span', { class: 'tiny muted', text: s.id })
      ]));
    });
  };

  const load = async () => {
    names.textContent = '';
    names.appendChild(el('p', { class: 'muted', text: 'Loading the class list…' }));
    roster = (await list(`classes/${classSel.value}/students`))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    paint();
  };

  async function pick(student) {
    state.classId = classSel.value;
    state.studentId = student.id;
    localStorage.setItem('quizarena:play:class', state.classId);
    localStorage.setItem('quizarena:play:student', state.studentId);
    await joinExisting();
  }

  classSel.addEventListener('change', load);
  search.addEventListener('input', paint);

  box.append(
    el('div', { class: 'field' }, [el('label', { text: 'Class' }), classSel]),
    el('div', { class: 'field', style: 'margin-bottom:0' }, [el('label', { text: 'Your name' }), search]),
    names
  );
  app.appendChild(box);
  await load();
}

/**
 * A student may only write an answer for a name whose seat they hold, so the
 * seat has to exist before the first question, not just on the day they first
 * picked their name. This runs on every join and is safe to repeat.
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function ensureSeat() {
  const path = `classes/${state.classId}/seats/${state.studentId}`;
  try {
    const held = await get(path);
    if (held && held.uid === db.uid) return { ok: true };
    if (held && held.uid !== db.uid) return { ok: false, reason: 'taken' };
    await set(path, { uid: db.uid, joinedAt: Date.now() });
    return { ok: true };
  } catch (err) {
    console.error('Quiz Arena: seat claim failed', err);
    return { ok: false, reason: err?.code === 'permission-denied' ? 'taken' : 'offline' };
  }
}

async function joinExisting() {
  state.cls = await get(`classes/${state.classId}`);
  state.student = await get(`classes/${state.classId}/students/${state.studentId}`);
  if (!state.cls || !state.student) {
    localStorage.removeItem('quizarena:play:student');
    state.studentId = null;
    return renderJoin();
  }
  state.settings = { ...DEFAULT_SETTINGS, ...(state.cls.settings || {}) };
  sfx.enabled = state.settings.sound !== false;

  state.seat = await ensureSeat();

  $('#head').classList.remove('hidden');
  $('#me-name').textContent = state.student.name;
  $('#me-class').textContent = state.cls.name || state.classId;

  if (meUnsub) meUnsub();
  meUnsub = watchDoc(`classes/${state.classId}/students/${state.studentId}`, (s) => {
    if (!s) return;
    state.student = s;
    $('#me-score').textContent = String(s.score || 0);
  });

  if (liveUnsub) liveUnsub();
  liveUnsub = watchDoc(`classes/${state.classId}/live/now`, (doc) => {
    const changedRound = doc?.roundId !== state.live?.roundId;
    state.live = doc;
    if (changedRound) { state.submittedRound = null; state.draft = { answer: null, confidence: null }; }
    if (doc?.settings) state.settings = { ...state.settings, ...doc.settings };
    renderLive();
  });
}

/* ---------- the live screen ---------------------------------------------- */

function amDrawn() {
  return (state.live?.drawn || []).some((d) => d.id === state.studentId);
}

function renderLive() {
  app.textContent = '';
  const live = state.live;

  if (!live || live.phase === 'idle' || !live.phase) {
    app.appendChild(waiting('Waiting for the next draw', 'Keep your phone where you can see it.'));
    return appendLeave();
  }

  if (live.phase === 'drawn') {
    if (amDrawn()) {
      sfx.draw();
      app.appendChild(el('div', { class: 'panel waiting-card', style: 'border-color:var(--gold);background:var(--gold-soft)' }, [
        el('div', { class: 'pulse', style: 'color:var(--gold)', text: 'You are up' }),
        el('p', { class: 'muted', text: (live.questionsPerRound || 1) > 1
          ? `${live.questionsPerRound} questions coming your way.`
          : 'The question is coming.' })
      ]));
    } else {
      app.appendChild(waiting('This round is for ' + (live.drawn || []).map((d) => d.name).join(' and '),
        'Answer along anyway when the question appears. It will not count, but you will know where you stand.'));
    }
    return appendLeave();
  }

  const q = live.question;
  if (!q) return appendLeave();

  const card = el('div', { class: 'qcard' });
  const per = Math.max(1, live.questionsPerRound || 1);
  if (per > 1 && amDrawn()) {
    card.appendChild(el('p', { class: 'tiny muted', style: 'margin-bottom:8px',
      text: `Question ${live.questionNo || 1} of ${per} for you this round.` }));
  }
  if (!state.seat.ok) {
    card.appendChild(el('div', { class: 'notice notice-bad', text: state.seat.reason === 'taken'
      ? 'Another phone is signed in under your name, so your answers will not save. Ask your teacher to release it.'
      : 'Not connected properly, so your answers may not save. Tell your teacher.' }));
  }
  card.appendChild(questionMeta(q));
  card.appendChild(el('div', { class: 'qtext', text: q.text }));
  if (q.image) card.appendChild(el('img', { src: q.image, alt: '', style: 'max-width:100%;border-radius:8px;margin-bottom:16px' }));

  const scored = amDrawn() && state.settings.answerMode === 'devices';
  const revealed = live.phase === 'revealed';
  const mine = (live.results || []).find((r) => r.studentId === state.studentId);

  if (revealed) {
    if (mine) {
      const good = mine.fraction === 1;
      good ? sfx.right() : sfx.wrong();
      card.appendChild(el('div', { class: `verdict ${good ? 'good' : 'bad'}` }, [
        el('div', { class: 'delta', text: `${mine.points > 0 ? '+' : ''}${mine.points}` }),
        el('div', { text: good ? 'Correct' : mine.fraction > 0 ? 'Partly right' : 'Not this time' })
      ]));
    }
    card.appendChild(answerWidget(q, { value: mine ? mine.answer : state.draft.answer, disabled: true, key: live.revealKey }));
    if (q.explanation) card.appendChild(el('p', { style: 'margin-top:14px', text: q.explanation }));
    app.appendChild(card);
    return appendLeave();
  }

  if (state.submittedRound === live.roundId) {
    card.appendChild(el('div', { class: 'notice notice-ok', text: scored ? 'Answer locked in. Hold tight.' : 'Saved. This one is practice, so it will not change your score.' }));
    card.appendChild(answerWidget(q, { value: state.draft.answer, disabled: true }));
    app.appendChild(card);
    return appendLeave();
  }

  if (!scored && state.settings.answerMode === 'teacher' && amDrawn()) {
    card.appendChild(el('div', { class: 'notice notice-warn', text: 'Your teacher is recording answers out loud for this round.' }));
    app.appendChild(card);
    return appendLeave();
  }

  if (!scored) {
    card.appendChild(el('div', { class: 'notice notice-warn', text: 'Not your turn, so this is practice. Have a go anyway.' }));
  }

  if (scored) {
    card.appendChild(el('label', { text: 'How sure are you?' }));
    const conf = confidenceWidget(q, state.settings, {
      value: state.settings.rule === 'calibration' ? 60 : 2,
      onChange: (v) => { state.draft.confidence = v; }
    });
    state.draft.confidence = conf.getValue();
    card.appendChild(conf);
    card.appendChild(el('div', { style: 'height:18px' }));
  }

  card.appendChild(el('label', { text: 'Your answer' }));
  const ans = answerWidget(q, { value: state.draft.answer, onChange: (v) => { state.draft.answer = v; } });
  state.draft.answer = ans.getValue();
  card.appendChild(ans);

  card.appendChild(el('button', {
    class: 'btn-primary btn-big', style: 'width:100%;justify-content:center;margin-top:20px',
    onclick: () => submit(scored),
    text: scored ? 'Lock in my answer' : 'Save my practice answer'
  }));

  if (live.endsAt) card.appendChild(countdown(live.endsAt));
  app.appendChild(card);
  appendLeave();
}

async function submit(scored) {
  const live = state.live;
  if (!live?.roundId) return;
  const path = scored
    ? `classes/${state.classId}/rounds/${live.roundId}/responses/${state.studentId}`
    : `classes/${state.classId}/rounds/${live.roundId}/shadow/${state.studentId}`;
  const payload = {
    answer: state.draft.answer,
    confidence: state.draft.confidence ?? (state.settings.rule === 'calibration' ? 50 : 1),
    name: state.student.name,
    at: Date.now()
  };

  const write = () => set(path, payload);

  try {
    await write();
  } catch (first) {
    // Almost always a missing seat: this phone picked its name before the
    // seat existed. Claim one and try the answer again before giving up.
    if (first?.code !== 'permission-denied') {
      toast('No connection. Your answer was not saved — try again.', 'bad');
      console.error(first);
      return;
    }
    const seat = await ensureSeat();
    state.seat = seat;
    if (!seat.ok) {
      toast(seat.reason === 'taken'
        ? 'Another phone is signed in as you. Ask your teacher to release your name.'
        : 'Cannot reach the server. Your answer was not saved.', 'bad');
      renderLive();
      return;
    }
    try {
      await write();
    } catch (second) {
      toast('Still could not save. Tell your teacher.', 'bad');
      console.error(second);
      return;
    }
  }

  state.submittedRound = live.roundId;
  sfx.tick();
  renderLive();
}

function waiting(title, sub) {
  return el('div', { class: 'panel waiting-card' }, [
    el('div', { class: 'pulse', text: title }),
    el('p', { class: 'muted', text: sub })
  ]);
}

function countdown(endsAt) {
  const wrap = el('div', { class: 'tiny muted', style: 'text-align:center;margin-top:10px' });
  const tick = () => {
    const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    wrap.textContent = left ? `${left} seconds left` : 'Time is up';
    if (left) setTimeout(tick, 1000);
  };
  tick();
  return wrap;
}

function appendLeave() {
  app.appendChild(el('div', { class: 'center', style: 'margin-top:26px' },
    el('button', {
      class: 'btn-ghost tiny',
      onclick: () => {
        localStorage.removeItem('quizarena:play:student');
        localStorage.removeItem('quizarena:play:class');
        location.reload();
      },
      text: 'Not you? Switch name'
    })));
}
