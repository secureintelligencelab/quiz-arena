/* ---------------------------------------------------------------------------
   model.js — shapes, imports, the draw, and the awards.

   The one rule that shapes everything here: a question document that students
   can read must never contain the answer. Import splits every question into
   two pieces and they are stored in two places:

     classes/{class}/questions/{id}    text, options, difficulty  (students read)
     classes/{class}/keys/{id}         the answer                 (teacher only)
--------------------------------------------------------------------------- */

export const QUESTION_TYPES = {
  true_false: 'True or false',
  mcq_single: 'Multiple choice, one answer',
  mcq_multi: 'Multiple choice, several answers',
  matching: 'Matching pairs',
  ordering: 'Put in order',
  short_answer: 'Short written answer'
};

export const DEFAULT_SETTINGS = {
  rule: 'tiers',            // or 'calibration'
  penalty: 1,
  drawCount: 2,
  questionsPerRound: 1,
  drawMode: 'fair',         // 'fair' favours students who have had fewer turns
  answerMode: 'devices',    // or 'teacher' — teacher types answers for the class
  restOnCorrect: true,
  timeLimitSec: 45,
  sound: true
};

/* ---------- ids -------------------------------------------------------- */

export function slug(s, fallback = 'item') {
  const out = String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return out || `${fallback}-${Math.random().toString(36).slice(2, 7)}`;
}

export function rid(prefix = 'r') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/* ---------- student import --------------------------------------------- */

/**
 * Accepts JSON (array or {students:[...]}) or CSV/TSV with a header row.
 * Needs an id and a name per student; anything else is kept as-is.
 */
export function parseStudents(raw) {
  const text = String(raw || '').trim();
  if (!text) return { students: [], errors: ['Nothing to import.'] };

  let rows;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const data = JSON.parse(text);
      rows = Array.isArray(data) ? data : (data.students || data.roster || []);
    } catch (e) {
      return { students: [], errors: [`That is not valid JSON: ${e.message}`] };
    }
  } else {
    rows = parseDelimited(text);
  }

  const errors = [];
  const seen = new Set();
  const students = [];

  rows.forEach((row, i) => {
    const line = i + 1;
    const id = String(pick(row, ['id', 'studentId', 'roll', 'rollNo', 'code']) ?? '').trim();
    const name = String(pick(row, ['name', 'studentName', 'fullName']) ?? '').trim();

    if (!name) { errors.push(`Row ${line}: no name.`); return; }
    const finalId = id || slug(name, 'student');
    if (seen.has(finalId)) { errors.push(`Row ${line}: id "${finalId}" is used twice.`); return; }
    seen.add(finalId);

    students.push({
      id: finalId,
      name,
      group: String(pick(row, ['group', 'house', 'team', 'section']) ?? '').trim() || null,
      active: true,
      resting: false,
      score: 0,
      turns: 0,
      correct: 0,
      wrong: 0,
      streak: 0,
      bestStreak: 0
    });
  });

  return { students, errors };
}

function parseDelimited(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines[0].includes('\t') ? '\t' : (lines[0].split(';').length > lines[0].split(',').length ? ';' : ',');
  const head = splitRow(lines[0], sep).map((h) => h.trim());
  const looksLikeHeader = head.some((h) => /^(id|name|student|roll|house|group|team|code|section)/i.test(h));
  const cols = looksLikeHeader ? head : ['id', 'name', 'group'];
  const body = looksLikeHeader ? lines.slice(1) : lines;
  return body.map((line) => {
    const cells = splitRow(line, sep);
    const obj = {};
    cols.forEach((c, i) => { obj[c] = (cells[i] ?? '').trim(); });
    return obj;
  });
}

function splitRow(line, sep) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === sep && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function pick(row, keys) {
  for (const k of keys) {
    const found = Object.keys(row).find((rk) => rk.toLowerCase().replace(/[\s_-]/g, '') === k.toLowerCase());
    if (found && row[found] !== '') return row[found];
  }
  return undefined;
}

/* ---------- question import -------------------------------------------- */

const DIFF_WORDS = { warmup: 1, 'warm-up': 1, veryeasy: 1, easy: 2, medium: 3, moderate: 3, hard: 4, difficult: 4, stretch: 5, veryhard: 5, expert: 5 };

/**
 * Splits each question into a public part and a private key.
 * @returns {{questions:Array, keys:Object, errors:Array, warnings:Array}}
 */
export function parseQuestions(raw) {
  const text = String(raw || '').trim();
  if (!text) return { questions: [], keys: {}, errors: ['Nothing to import.'], warnings: [] };

  let data;
  try { data = JSON.parse(text); }
  catch (e) { return { questions: [], keys: {}, errors: [`That is not valid JSON: ${e.message}`], warnings: [] }; }

  const rows = Array.isArray(data) ? data : (data.questions || data.items || []);
  if (!Array.isArray(rows) || !rows.length) {
    return { questions: [], keys: {}, errors: ['No questions found. Expected an array, or an object with a "questions" array.'], warnings: [] };
  }

  const errors = [];
  const warnings = [];
  const questions = [];
  const keys = {};
  const seen = new Set();

  rows.forEach((row, i) => {
    const at = `Question ${i + 1}`;
    const type = normaliseType(row.type);
    if (!type) { errors.push(`${at}: unknown type "${row.type}". Use one of ${Object.keys(QUESTION_TYPES).join(', ')}.`); return; }

    const textBody = String(row.text ?? row.question ?? row.question_text ?? '').trim();
    if (!textBody) { errors.push(`${at}: no question text.`); return; }

    let id = String(row.id ?? '').trim() || slug(textBody.slice(0, 40), 'q');
    while (seen.has(id)) id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
    seen.add(id);

    const difficulty = normaliseDifficulty(row.difficulty);
    const pub = {
      id,
      type,
      text: textBody,
      topic: String(row.topic ?? row.category ?? '').trim() || null,
      difficulty,
      explanation: String(row.explanation ?? row.why ?? '').trim() || null,
      image: String(row.image ?? row.media?.image ?? '').trim() || null,
      timeLimitSec: Number(row.timeLimitSec ?? row.time ?? 0) || null,
      partialCredit: row.partialCredit !== false,
      asked: 0
    };
    const key = { id };

    const problem = (msg) => { errors.push(`${at}: ${msg}`); };

    switch (type) {
      case 'true_false': {
        const a = row.answer;
        if (a === undefined) return problem('needs "answer": true or false.');
        key.answer = (a === true || String(a).toLowerCase() === 'true' || a === 1) ? 'true' : 'false';
        pub.options = ['True', 'False'];
        break;
      }

      case 'mcq_single': {
        pub.options = toStrings(row.options || row.choices);
        if (pub.options.length < 2) return problem('needs at least two options.');
        const idx = resolveIndex(row.answer, pub.options);
        if (idx < 0) return problem(`answer "${row.answer}" is not one of the options.`);
        key.answer = idx;
        break;
      }

      case 'mcq_multi': {
        pub.options = toStrings(row.options || row.choices);
        if (pub.options.length < 2) return problem('needs at least two options.');
        const list = Array.isArray(row.answer) ? row.answer : [row.answer];
        const idxs = list.map((a) => resolveIndex(a, pub.options));
        if (idxs.some((n) => n < 0)) return problem('one of the answers is not in the options list.');
        if (!idxs.length) return problem('needs at least one correct answer.');
        if (idxs.length === 1) warnings.push(`${at}: only one correct answer — "mcq_single" may read better.`);
        key.answer = idxs.sort((a, b) => a - b);
        break;
      }

      case 'matching': {
        pub.left = toStrings(row.left || row.prompts);
        pub.right = toStrings(row.right || row.matches);
        if (pub.left.length < 2 || pub.right.length < 2) return problem('needs "left" and "right" lists.');
        let ans = row.answer;
        if (!Array.isArray(ans)) {
          if (ans && typeof ans === 'object') ans = pub.left.map((l) => ans[l]);
          else return problem('needs "answer" as a list, one right-hand index per left item.');
        }
        key.answer = ans.map((a) => resolveIndex(a, pub.right));
        if (key.answer.length !== pub.left.length || key.answer.some((n) => n < 0)) {
          return problem('the answer list must give one valid right-hand item for each left item.');
        }
        break;
      }

      case 'ordering': {
        pub.items = toStrings(row.items || row.options);
        if (pub.items.length < 2) return problem('needs an "items" list.');
        let ans = row.answer;
        if (!Array.isArray(ans)) return problem('needs "answer" as the correct order.');
        key.answer = ans.map((a) => resolveIndex(a, pub.items));
        if (key.answer.length !== pub.items.length || key.answer.some((n) => n < 0)) {
          return problem('the answer must list every item exactly once, in the right order.');
        }
        break;
      }

      case 'short_answer': {
        const accepted = Array.isArray(row.answer) ? row.answer : [row.answer];
        if (!accepted.length || accepted[0] === undefined) return problem('needs "answer" — a string, or a list of acceptable strings.');
        key.answer = accepted.map(String);
        key.caseSensitive = row.caseSensitive === true;
        break;
      }
    }

    questions.push(pub);
    keys[id] = key;
  });

  return { questions, keys, errors, warnings };
}

function normaliseType(t) {
  const k = String(t || '').toLowerCase().replace(/[\s_-]/g, '');
  const map = {
    truefalse: 'true_false', tf: 'true_false', boolean: 'true_false',
    mcq: 'mcq_single', mcqsingle: 'mcq_single', multiplechoice: 'mcq_single', single: 'mcq_single', choice: 'mcq_single',
    mcqmulti: 'mcq_multi', multi: 'mcq_multi', multiselect: 'mcq_multi', multipleanswers: 'mcq_multi', checkbox: 'mcq_multi',
    matching: 'matching', match: 'matching', pairs: 'matching',
    ordering: 'ordering', order: 'ordering', sequence: 'ordering', sort: 'ordering',
    shortanswer: 'short_answer', short: 'short_answer', text: 'short_answer', written: 'short_answer'
  };
  return map[k] || (QUESTION_TYPES[t] ? t : null);
}

function normaliseDifficulty(d) {
  if (typeof d === 'number' && d >= 1 && d <= 5) return Math.round(d);
  const word = String(d || '').toLowerCase().replace(/[\s_-]/g, '');
  return DIFF_WORDS[word] || 3;
}

function toStrings(arr) {
  return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
}

/** Answers may be given as an index, a letter, or the option text itself. */
function resolveIndex(answer, options) {
  if (answer === undefined || answer === null) return -1;
  if (typeof answer === 'number' && Number.isInteger(answer)) {
    if (answer >= 0 && answer < options.length) return answer;
    if (answer >= 1 && answer <= options.length) return answer - 1;  // 1-based lists
    return -1;
  }
  const s = String(answer).trim();
  if (/^[A-Za-z]$/.test(s)) {
    const n = s.toUpperCase().charCodeAt(0) - 65;
    if (n >= 0 && n < options.length) return n;
  }
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= 0 && n < options.length) return n;
    if (n >= 1 && n <= options.length) return n - 1;
  }
  const exact = options.findIndex((o) => o.trim().toLowerCase() === s.toLowerCase());
  return exact;
}

/* ---------- the draw ---------------------------------------------------- */

/**
 * Picks students for the next round.
 * "fair" weights each student by 1/(turns+1), so someone who has not been up
 * yet is far likelier to be chosen than someone on their fourth turn. It is
 * still a draw — nobody can predict it — but the class stays even.
 */
export function drawStudents(students, { count = 2, mode = 'fair', exclude = [] } = {}) {
  const skip = new Set(exclude);
  const pool = students.filter((s) => s.active !== false && !s.resting && !skip.has(s.id));
  const picked = [];
  const bag = [...pool];

  while (picked.length < count && bag.length) {
    let i;
    if (mode === 'fair') {
      const weights = bag.map((s) => 1 / ((s.turns || 0) + 1));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      i = weights.findIndex((w) => (r -= w) <= 0);
      if (i < 0) i = bag.length - 1;
    } else {
      i = Math.floor(Math.random() * bag.length);
    }
    picked.push(bag.splice(i, 1)[0]);
  }

  return { picked, poolSize: pool.length };
}

/* ---------- awards ------------------------------------------------------ */

/**
 * Works out who gets what at the end. Returns a podium plus a set of named
 * awards, so more than three students walk away with something.
 */
export function computeAwards(students, responses, settings = {}) {
  const ranked = [...students]
    .filter((s) => (s.turns || 0) > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const byStudent = {};
  responses.forEach((r) => { (byStudent[r.studentId] ||= []).push(r); });

  const awards = [];
  const nameOf = (id) => students.find((s) => s.id === id)?.name || id;

  // Best calibrated — only worth showing when percentages were used.
  if (settings.rule === 'calibration') {
    const scored = Object.entries(byStudent)
      .filter(([, rs]) => rs.length >= 4)
      .map(([id, rs]) => {
        const b = rs.reduce((t, r) => t + Math.pow((r.confidencePct ?? 50) / 100 - r.fraction, 2), 0) / rs.length;
        return { id, b };
      })
      .sort((a, b) => a.b - b.b);
    if (scored.length) {
      awards.push({
        title: 'Knows what they know',
        who: nameOf(scored[0].id),
        why: `Stated confidence matched results most closely (Brier ${scored[0].b.toFixed(2)})`
      });
    }
  }

  // Bravest correct call: highest confidence on hard questions, and right.
  const bold = responses
    .filter((r) => r.fraction === 1 && (r.difficulty || 3) >= 4)
    .sort((a, b) => (b.confidencePct ?? b.tier * 33) - (a.confidencePct ?? a.tier * 33))[0];
  if (bold) {
    awards.push({ title: 'Nerve of steel', who: nameOf(bold.studentId), why: 'Called a hard question with full confidence, and was right' });
  }

  // Longest run of correct answers.
  const streaker = [...students].sort((a, b) => (b.bestStreak || 0) - (a.bestStreak || 0))[0];
  if (streaker && (streaker.bestStreak || 0) >= 3) {
    awards.push({ title: 'On a roll', who: streaker.name, why: `${streaker.bestStreak} correct answers in a row` });
  }

  // Best hit rate among students who took a real number of turns.
  const busy = students.filter((s) => (s.turns || 0) >= 4);
  const sharp = busy.sort((a, b) => (b.correct / b.turns) - (a.correct / a.turns))[0];
  if (sharp && !ranked.slice(0, 1).some((s) => s.id === sharp.id)) {
    awards.push({
      title: 'Surest hand',
      who: sharp.name,
      why: `${Math.round(100 * sharp.correct / sharp.turns)}% correct across ${sharp.turns} turns`
    });
  }

  // Most improved: second half average against first half.
  const improved = Object.entries(byStudent)
    .filter(([, rs]) => rs.length >= 6)
    .map(([id, rs]) => {
      const half = Math.floor(rs.length / 2);
      const early = mean(rs.slice(0, half).map((r) => r.fraction));
      const late = mean(rs.slice(half).map((r) => r.fraction));
      return { id, gain: late - early };
    })
    .sort((a, b) => b.gain - a.gain)[0];
  if (improved && improved.gain > 0.2) {
    awards.push({ title: 'Came on strongest', who: nameOf(improved.id), why: 'Second half of the term well ahead of the first' });
  }

  return { podium: ranked.slice(0, 3), ranked, awards };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/* ---------- export helpers ---------------------------------------------- */

export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return [head, ...body].join('\n');
}

export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
