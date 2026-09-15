/* ---------------------------------------------------------------------------
   board.js — the screen the class is looking at.

   The draw is the moment worth staging, so it gets the one piece of motion in
   the whole app: names flicker past before settling on whoever was picked.
   Everything else stays still and readable from the back row.
--------------------------------------------------------------------------- */

import { initDb, get, list, watchDoc, watchList } from './db.js';
import { el, $, LETTERS, sfx } from './render.js';
import { qrSvg } from './qr.js';

const root = $('#board');
const params = new URLSearchParams(location.search);
const state = {
  classId: params.get('class') || localStorage.getItem('quizarena:class') || null,
  cls: null,
  students: [],
  live: null,
  spunFor: null
};

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

await initDb();
await boot();

async function boot() {
  const classes = await list('classes');
  if (!classes.length) {
    root.appendChild(el('div', { class: 'spotlight' }, [
      el('div', { class: 'name', text: 'No classes yet' }),
      el('p', { class: 'board-label', text: 'Set one up in the teacher console first.' })
    ]));
    return;
  }
  if (!state.classId || !classes.some((c) => c.id === state.classId)) state.classId = classes[0].id;

  state.cls = await get(`classes/${state.classId}`);
  watchList(`classes/${state.classId}/students`, (rows) => {
    state.students = rows
      .filter((s) => s.active !== false)          // absent students are held out
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    draw();
  });
  watchDoc(`classes/${state.classId}/live/now`, (doc) => {
    const newRound = doc?.drawnAt !== state.live?.drawnAt;
    state.live = doc;
    if (doc?.phase === 'drawn' && newRound) spin(doc);
    else draw();
  });

  if (classes.length > 1) {
    const picker = el('select', {
      style: 'position:fixed;top:10px;right:14px;width:auto;background:transparent;color:rgba(244,247,249,.6);border-color:rgba(244,247,249,.25)',
      onchange: (e) => { location.search = `?class=${e.target.value}`; }
    }, classes.map((c) => el('option', { value: c.id, text: c.name || c.id, selected: c.id === state.classId })));
    document.body.appendChild(picker);
  }
}

/* ---------- layout ------------------------------------------------------- */

function draw() {
  const live = state.live;
  root.textContent = '';

  if (!live || live.phase === 'idle' || !live.phase) return idleScreen();
  if (live.phase === 'drawn') return drawnScreen(live);
  return questionScreen(live);
}

function idleScreen() {
  const wrap = el('div', { class: 'board-grid' });
  const main = el('div', { class: 'board-q' }, [
    el('div', { class: 'board-label', text: state.cls?.name || '' }),
    el('div', { class: 'qtext', text: leader() ? `${leader().name} is ahead` : 'Ready when you are' })
  ]);

  // Between rounds the screen is idle, which is exactly when latecomers need
  // the join link. Scanning beats reading a URL out to thirty phones.
  const joinUrl = new URL('play.html', location.href).href;
  const joinRow = el('div', { class: 'row', style: 'gap:24px;align-items:center;margin-top:2vh' });
  try {
    const code = qrSvg(joinUrl, { scale: 5, quiet: 3, dark: '#101f33', light: '#ffffff' });
    code.style.borderRadius = '10px';
    code.style.background = '#fff';
    code.style.padding = '10px';
    joinRow.appendChild(code);
  } catch { /* URL too long for a code; the text below still works */ }
  joinRow.appendChild(el('div', {}, [
    el('div', { style: 'font-size:1.3rem;color:#fff;margin-bottom:6px', text: 'Scan to join' }),
    el('div', { style: 'font-size:1rem;color:rgba(244,247,249,.6);word-break:break-all;max-width:26ch', text: joinUrl })
  ]));
  main.appendChild(joinRow);

  wrap.appendChild(main);
  wrap.appendChild(scoreboard());
  root.appendChild(wrap);
}

function drawnScreen(live) {
  const wrap = el('div', { class: 'board-grid' });
  const names = el('div', { class: 'spotlight' });
  const per = Math.max(1, live.questionsPerRound || 1);
  names.appendChild(el('div', { class: 'drum', text: per > 1
    ? `Round ${live.roundNo || 1} — ${per} questions`
    : `Round ${live.roundNo || 1}` }));
  (live.drawn || []).forEach((d, i) => {
    if (i) names.appendChild(el('div', { class: 'vs', text: 'and' }));
    names.appendChild(el('div', { class: 'name', text: d.name }));
  });
  wrap.append(el('div', { class: 'board-q' }, names), scoreboard());
  root.appendChild(wrap);
}

function questionScreen(live) {
  const q = live.question;
  const wrap = el('div', { class: 'board-grid' });
  const main = el('div', { class: 'board-q' });

  if (live.endsAt && live.phase === 'asking') main.appendChild(timerBar(live.endsAt, live.startedAt));

  const per = Math.max(1, live.questionsPerRound || 1);
  main.appendChild(el('div', { class: 'board-label', text:
    (live.drawn || []).map((d) => d.name).join('   ·   ') +
    (per > 1 ? `      question ${live.questionNo || 1} of ${per}` : '') }));
  main.appendChild(el('div', { class: 'qtext', text: q.text }));
  if (q.image) main.appendChild(el('img', { src: q.image, alt: '', style: 'max-height:32vh;border-radius:10px;margin-bottom:3vh' }));

  const key = live.phase === 'revealed' ? live.revealKey : null;
  main.appendChild(choices(q, key));

  if (live.phase === 'revealed' && q.explanation) {
    main.appendChild(el('p', { style: 'font-size:1.15rem;color:rgba(244,247,249,.72);max-width:52ch;margin-top:2vh', text: q.explanation }));
  }
  if (live.phase === 'revealed' && live.results) {
    main.appendChild(el('div', { class: 'row wrap', style: 'margin-top:2vh;gap:14px' },
      live.results.map((r) => el('div', {
        style: `padding:10px 18px;border-radius:12px;font-size:1.3rem;font-family:Archivo,sans-serif;font-weight:700;
                background:${r.fraction === 1 ? 'rgba(35,194,149,.2)' : 'rgba(191,47,82,.22)'};
                color:${r.fraction === 1 ? '#5fe0bb' : '#ff9db1'}`,
        text: `${r.name}  ${r.points > 0 ? '+' : ''}${r.points}`
      }))));
  }

  wrap.append(main, scoreboard());
  root.appendChild(wrap);
}

function choices(q, key) {
  const box = el('div');
  const mark = (i) => key && (
    q.type === 'true_false' ? key.answer === (i === 0 ? 'true' : 'false')
      : q.type === 'mcq_multi' ? (key.answer || []).includes(i)
        : key.answer === i);

  if (q.type === 'true_false' || q.type === 'mcq_single' || q.type === 'mcq_multi') {
    (q.options || []).forEach((o, i) => {
      box.appendChild(el('div', { class: `board-opt ${mark(i) ? 'right' : ''}` }, [
        el('span', { class: 'key', text: LETTERS[i] }),
        el('span', { text: o })
      ]));
    });
  } else if (q.type === 'matching') {
    (q.left || []).forEach((l, i) => {
      box.appendChild(el('div', { class: `board-opt ${key ? 'right' : ''}` }, [
        el('span', { class: 'grow', text: l }),
        el('span', { class: 'key', text: key ? '→' : '' }),
        el('span', { text: key ? (q.right || [])[key.answer[i]] : '' })
      ]));
    });
    if (!key) {
      box.appendChild(el('div', { class: 'board-label', style: 'margin-top:14px', text: 'Match these:' }));
      box.appendChild(el('div', { class: 'row wrap' }, (q.right || []).map((r) =>
        el('span', { class: 'board-opt', style: 'margin:0', text: r }))));
    }
  } else if (q.type === 'ordering') {
    const order = key ? key.answer : (q.items || []).map((_, i) => i);
    order.forEach((idx, pos) => {
      box.appendChild(el('div', { class: `board-opt ${key ? 'right' : ''}` }, [
        el('span', { class: 'key', text: key ? String(pos + 1) : '·' }),
        el('span', { text: (q.items || [])[idx] })
      ]));
    });
    if (!key) box.appendChild(el('div', { class: 'board-label', text: 'Shown in the wrong order.' }));
  } else if (q.type === 'short_answer' && key) {
    box.appendChild(el('div', { class: 'board-opt right' }, el('span', { text: (key.answer || []).join('  /  ') })));
  }
  return box;
}

function scoreboard() {
  const side = el('div', { class: 'board-side' });
  side.appendChild(el('div', { class: 'board-label', text: 'Scoreboard' }));
  const lb = el('div', { class: 'board-lb' });
  state.students.slice(0, 12).forEach((s, i) => {
    lb.appendChild(el('div', { class: `board-lb-row ${s.resting ? 'rest' : ''}` }, [
      el('span', { class: 'rk', text: String(i + 1) }),
      el('span', { text: s.name }),
      el('span', { class: 'pts', text: String(s.score || 0) })
    ]));
  });
  side.appendChild(lb);
  const resting = state.students.filter((s) => s.resting).length;
  if (resting) side.appendChild(el('div', { class: 'board-label', style: 'margin-top:14px', text: `${resting} sitting out after a correct answer` }));
  return side;
}

function timerBar(endsAt, startedAt) {
  const total = Math.max(1, endsAt - (startedAt || endsAt - 45000));
  const bar = el('div', { class: 'timer-bar' }, el('i', {}));
  const fill = bar.firstChild;
  const tick = () => {
    const left = Math.max(0, endsAt - Date.now());
    fill.style.width = `${(left / total) * 100}%`;
    if (left > 0 && state.live?.phase === 'asking') setTimeout(tick, 900);
  };
  tick();
  return bar;
}

function leader() { return state.students.find((s) => (s.score || 0) > 0); }

/* ---------- the draw reveal ---------------------------------------------- */

function spin(live) {
  if (reduceMotion || !state.students.length) { draw(); return; }
  if (state.spunFor === live.drawnAt) { draw(); return; }
  state.spunFor = live.drawnAt;

  root.textContent = '';
  const wrap = el('div', { class: 'board-grid' });
  const stage = el('div', { class: 'spotlight' });
  stage.appendChild(el('div', { class: 'drum', text: (live.questionsPerRound || 1) > 1
    ? `Round ${live.roundNo || 1} — ${live.questionsPerRound} questions`
    : `Round ${live.roundNo || 1}` }));

  const slots = (live.drawn || []).map((d, i) => {
    if (i) stage.appendChild(el('div', { class: 'vs', text: 'and' }));
    const n = el('div', { class: 'name rolling', text: d.name });
    stage.appendChild(n);
    return { node: n, final: d.name };
  });
  wrap.append(el('div', { class: 'board-q' }, stage), scoreboard());
  root.appendChild(wrap);

  const names = state.students.map((s) => s.name);
  let frame = 0;
  const settleAt = slots.map((_, i) => 26 + i * 12);
  const total = settleAt[settleAt.length - 1] + 4;

  const step = () => {
    slots.forEach((slot, i) => {
      if (frame < settleAt[i]) {
        slot.node.textContent = names[Math.floor(Math.random() * names.length)];
      } else if (slot.node.classList.contains('rolling')) {
        slot.node.textContent = slot.final;
        slot.node.classList.remove('rolling');
        sfx.tick();
      }
    });
    frame++;
    if (frame <= total) setTimeout(step, 55);
    else draw();
  };
  step();
}
