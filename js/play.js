/* ---------------------------------------------------------------------------
   play.js — what a student sees on their phone.

   Drawn students answer for points. Everyone else can still answer along,
   which is saved separately and never counted, so the other twenty-eight
   people in the room have something to do while two of them are on the spot.
--------------------------------------------------------------------------- */

import { initDb, db, get, set as set_, list, watchDoc } from './db.js';
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
  draft: { answers: {}, confidence: {} }
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
    const shown = roster.filter((s) => !q || s.name.toLowerCase().includes(q));
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
        s.group ? el('span', { class: 'tiny muted', text: s.group }) : null
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

  function pick(student) {
    state.classId = classSel.value;
    renderConfirm(student);
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

/** Same ID, written a few different ways, should still match. */
const tidyId = (v) => String(v || '').trim().toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Step two of joining: prove the name is yours. The list never shows IDs, so
 * knowing one is what separates a student from a classmate picking their name
 * for a joke. It also means a student who changes phone can get back in on
 * their own instead of waiting for the teacher.
 */
function renderConfirm(student, note) {
  $('#head').classList.add('hidden');
  app.textContent = '';

  const box = el('div', { class: 'panel' });
  box.appendChild(el('h2', { text: student.name }));
  box.appendChild(el('p', { class: 'muted', text: 'Enter your student ID to confirm this is you.' }));
  if (note) box.appendChild(el('div', { class: 'notice notice-warn', text: note }));

  const input = el('input', {
    type: 'text', placeholder: 'Your student ID', autocomplete: 'off',
    autocapitalize: 'none', spellcheck: 'false',
    style: 'font-size:var(--step-2);padding:14px'
  });
  const problem = el('div', { class: 'tiny', style: 'color:var(--rose);margin-top:8px;min-height:18px' });

  const go = async () => {
    if (tidyId(input.value) !== tidyId(student.id)) {
      problem.textContent = 'That ID does not match this name. Check with your teacher if you are not sure.';
      input.select();
      return;
    }
    problem.textContent = '';
    state.studentId = student.id;
    localStorage.setItem('quizarena:play:class', state.classId);
    localStorage.setItem('quizarena:play:student', state.studentId);
    await joinExisting();
  };

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  box.append(
    el('div', { class: 'field' }, [input, problem]),
    el('button', { class: 'btn-primary btn-big', style: 'width:100%;justify-content:center', onclick: go, text: "That's my ID" }),
    el('button', { class: 'btn-ghost tiny', style: 'margin-top:10px', onclick: () => renderJoin(), text: 'Pick a different name' })
  );
  app.appendChild(box);
  setTimeout(() => input.focus(), 50);
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
    if (held && state.settings.lockToDevice) return { ok: false, reason: 'taken' };
    // Not locked to a device: this phone got here by entering the ID, so it
    // takes the seat over. The previous phone stops being able to answer.
    await set_(path, { uid: db.uid, joinedAt: Date.now() });
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
  if (!state.seat.ok && state.seat.reason === 'taken' && !state.settings.lockToDevice) {
    return renderConfirm(state.student, 'Someone else is using this name. Enter your ID to take it back.');
  }

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
    if (changedRound) { state.submittedRound = null; state.draft = { answers: {}, confidence: {} }; }
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

  const set = live.questions || [];

  if (live.phase === 'drawn' || !set.length) {
    if (amDrawn()) {
      sfx.draw();
      app.appendChild(el('div', { class: 'panel waiting-card', style: 'border-color:var(--gold);background:var(--gold-soft)' }, [
        el('div', { class: 'pulse', style: 'color:var(--gold)', text: 'You are up' }),
        el('p', { class: 'muted', text: 'The questions are coming.' })
      ]));
    } else {
      app.appendChild(waiting(
        'This round is for ' + (live.drawn || []).map((d) => d.name).join(' and '),
        'Answer along anyway when the questions appear. It will not count, but you will know where you stand.'));
    }
    return appendLeave();
  }

  const scored = amDrawn() && state.settings.answerMode === 'devices';
  const revealed = live.phase === 'revealed';
  const mine = (live.results || []).find((r) => r.studentId === state.studentId);
  const locked = revealed || state.submittedRound === live.roundId;

  if (!state.seat.ok) {
    app.appendChild(el('div', { class: 'notice notice-bad', text: state.seat.reason === 'taken'
      ? 'Another phone is signed in under your name, so your answers will not save. Ask your teacher to release it.'
      : 'Not connected properly, so your answers may not save. Tell your teacher.' }));
  }

  if (revealed && mine) {
    const good = mine.correctCount === set.length;
    good ? sfx.right() : sfx.wrong();
    app.appendChild(el('div', { class: `verdict ${mine.correctCount ? 'good' : 'bad'}`, style: 'margin-bottom:16px' }, [
      el('div', { class: 'delta', text: `${mine.total > 0 ? '+' : ''}${mine.total}` }),
      el('div', { text: set.length > 1 ? `${mine.correctCount} of ${set.length} right` : (good ? 'Correct' : 'Not this time') })
    ]));
  } else if (!scored && !revealed) {
    app.appendChild(el('div', { class: 'notice notice-warn',
      text: 'Not your turn, so this is practice. Have a go anyway.' }));
  } else if (locked) {
    app.appendChild(el('div', { class: 'notice notice-ok',
      text: scored ? 'Answers locked in. Hold tight.' : 'Saved. This one is practice, so it will not change your score.' }));
  } else if (set.length > 1) {
    app.appendChild(el('div', { class: 'notice notice-ok',
      text: `${set.length} questions this round. Answer them in any order, then lock them all in together.` }));
  }

  if (!scored && state.settings.answerMode === 'teacher' && amDrawn()) {
    app.appendChild(el('div', { class: 'notice notice-warn', text: 'Your teacher is recording answers out loud for this round.' }));
    set.forEach((q, i) => app.appendChild(readOnlyQuestion(q, i, set.length)));
    return appendLeave();
  }

  /* every question of the round, on one page */
  set.forEach((q, i) => {
    const card = el('div', { class: 'qcard', style: 'margin-bottom:16px' });
    if (set.length > 1) {
      card.appendChild(el('div', { class: 'tiny muted', style: 'margin-bottom:6px', text: `Question ${i + 1} of ${set.length}` }));
    }
    card.appendChild(questionMeta(q));
    card.appendChild(el('div', { class: 'qtext', text: q.text }));
    if (q.image) card.appendChild(el('img', { src: q.image, alt: '', style: 'max-width:100%;border-radius:8px;margin-bottom:16px' }));

    const cell = revealed ? (mine?.perQuestion || []).find((x) => x.questionId === q.id) : null;
    if (cell) {
      card.appendChild(el('div', {
        class: `tag ${cell.fraction === 1 ? 'tag-jade' : cell.fraction > 0 ? 'tag-gold' : 'tag-rose'}`,
        style: 'margin-bottom:10px',
        text: `${cell.fraction === 1 ? 'Correct' : cell.fraction > 0 ? 'Partly right' : 'Wrong'} · ${cell.points > 0 ? '+' : ''}${cell.points}`
      }));
    }

    if (scored && !locked) {
      card.appendChild(el('label', { text: 'How sure are you?' }));
      const conf = confidenceWidget(q, state.settings, {
        value: state.draft.confidence[q.id] ?? (state.settings.rule === 'calibration' ? 60 : 2),
        onChange: (v) => { state.draft.confidence[q.id] = v; }
      });
      state.draft.confidence[q.id] ??= conf.getValue();
      card.appendChild(conf);
      card.appendChild(el('div', { style: 'height:16px' }));
    }

    card.appendChild(el('label', { text: 'Your answer' }));
    const ans = answerWidget(q, {
      value: cell ? cell.answer : state.draft.answers[q.id],
      disabled: locked,
      key: revealed ? (live.revealKeys || {})[q.id] : null,
      onChange: (v) => { state.draft.answers[q.id] = v; }
    });
    if (!locked) state.draft.answers[q.id] ??= ans.getValue();
    card.appendChild(ans);

    if (revealed && q.explanation) card.appendChild(el('p', { style: 'margin-top:12px', text: q.explanation }));
    app.appendChild(card);
  });

  if (!locked) {
    const answered = set.filter((q) => state.draft.answers[q.id] !== undefined && state.draft.answers[q.id] !== null).length;
    app.appendChild(el('button', {
      class: 'btn-primary btn-big', style: 'width:100%;justify-content:center;position:sticky;bottom:12px',
      onclick: () => submit(scored),
      text: scored
        ? (set.length > 1 ? `Lock in all ${set.length} answers` : 'Lock in my answer')
        : 'Save my practice answers'
    }));
    if (set.length > 1) {
      app.appendChild(el('p', { class: 'tiny muted center', style: 'margin-top:8px',
        text: `${answered} of ${set.length} answered. Anything left blank counts as wrong.` }));
    }
    if (live.endsAt) app.appendChild(countdown(live.endsAt));
  }

  appendLeave();
}

/** Shown when the teacher is taking answers verbally. */
function readOnlyQuestion(q, i, total) {
  const card = el('div', { class: 'qcard', style: 'margin-bottom:16px' });
  if (total > 1) card.appendChild(el('div', { class: 'tiny muted', text: `Question ${i + 1} of ${total}` }));
  card.appendChild(questionMeta(q));
  card.appendChild(el('div', { class: 'qtext', text: q.text }));
  card.appendChild(answerWidget(q, { disabled: true }));
  return card;
}

async function submit(scored) {
  const live = state.live;
  if (!live?.roundId) return;
  const path = scored
    ? `classes/${state.classId}/rounds/${live.roundId}/responses/${state.studentId}`
    : `classes/${state.classId}/rounds/${live.roundId}/shadow/${state.studentId}`;

  const set = live.questions || [];
  const answers = {};
  const confidence = {};
  set.forEach((q) => {
    if (state.draft.answers[q.id] !== undefined) answers[q.id] = state.draft.answers[q.id];
    confidence[q.id] = state.draft.confidence[q.id] ?? (state.settings.rule === 'calibration' ? 50 : 1);
  });

  const payload = { answers, confidence, name: state.student.name, at: Date.now() };
  const write = () => set_(path, payload);

  try {
    await write();
  } catch (first) {
    if (first?.code !== 'permission-denied') {
      toast('No connection. Your answers were not saved — try again.', 'bad');
      console.error(first);
      return;
    }
    const seat = await ensureSeat();
    state.seat = seat;
    if (!seat.ok) {
      toast(seat.reason === 'taken'
        ? 'Another phone is signed in as you. Ask your teacher to release your name.'
        : 'Cannot reach the server. Your answers were not saved.', 'bad');
      if (seat.reason === 'taken' && !state.settings.lockToDevice) {
        return renderConfirm(state.student, 'Enter your ID to take your name back.');
      }
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
