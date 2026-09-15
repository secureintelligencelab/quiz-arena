# Quiz Arena

A live classroom quiz. Two or more students are drawn at random, both get the
same question, and both say how sure they are *before* the answer is revealed.
Points depend on the difficulty of the question and on that stated confidence,
so a confident miss costs more than a cautious one.

Static HTML and JavaScript only. It runs on GitHub Pages with Firebase behind
it, and it also runs with no backend at all.

---

## Try it in two minutes

1. Download or clone this folder.
2. Serve it. Opening `index.html` straight off the disk will not work, because
   browsers block JavaScript modules on `file://`. Any static server will do:

   ```
   python3 -m http.server 8080
   ```

3. Visit `http://localhost:8080`, open the teacher console, create a class,
   then use **Paste an example** on the class list page and **Load the example
   file** on the questions page.

With no Firebase settings in place, everything is stored in that one browser.
That is enough to set up your question banks, and enough to run a quiz with the
teacher recording answers out loud. It is not enough for student phones.

---

## Connecting Firebase

Needed if you want students answering on their own devices, or the projector on
a different machine from your laptop.

1. Create a project at <https://console.firebase.google.com>.
2. **Build → Firestore Database → Create database.** Production mode is fine;
   the rules below replace the defaults.
3. **Build → Authentication → Sign-in method → Anonymous → Enable.** Students
   never make accounts; each phone is signed in silently.
   Enable **Email/Password** on the same screen as well — that is what you sign
   in with as the teacher.
4. **Project settings → Your apps → Web app.** Copy the config object and paste
   it into `js/config.js`.
5. **Firestore → Rules.** Replace everything with the contents of
   `firestore.rules`, then publish.
6. **Authentication → Users → Add user.** Make an account for yourself with
   an email and a password. Copy the **User UID** shown in that list.
7. **Firestore → Start collection → `admins` → Add document.** Paste the UID as
   the **document ID**. Any field inside will do; the ID is what counts.
8. Open the site and sign in with that email and password.

Only accounts listed in `admins` can open the teacher console, and the only way
onto that list is through the Firebase console. The app itself cannot add
anyone, so publishing the site does not put the console at risk. Students never
sign in at all — they are signed in anonymously in the background, pick their
name from the class list, and play.

### Teaching from more than one machine

Sign in with the same teacher account. One account works on your laptop, the
projector and any other machine, and survives clearing the browser. For a
colleague, make them a second account and add its UID to `admins` the same way.

### What students do

Give them the `play.html` link, or let them scan the code that the big screen
shows between rounds. They pick their class, find their name in the list, and
that is it — no account, no password, nothing to install. The phone remembers
who they are, so they only do it once.

While two students are on the spot, everyone else can answer along on their own
phone for practice. Those answers are stored separately and never scored.

### Making sure the right student answers

Two ways, set per class under Settings, **How students join**.

**They enter their student ID** (the default). The student picks their name,
then types their ID to confirm. The name list never shows IDs and you cannot
search by one, so picking a classmate's name gets nowhere without knowing their
ID. A student who changes phone or clears their browser types the ID again and
carries on — no teacher needed. Only one phone answers for a name at a time;
entering the ID moves it across and the old phone stops being able to answer.

**First phone to pick a name keeps it.** Nothing to remember and nothing to
guess, but every changed or wiped phone needs you to press **Release** beside
that student on the class list page.

Either way, the class list page has a **Phone** column showing who has joined,
with **Release** next to each and **Release all phones** at the top.

A note on how strong this is. The ID check is enforced in the app, not by the
server, because there is no server here to keep a secret on. A student who knows
their way around a browser's developer tools could get past it. What the server
does enforce is that only one phone can answer for a name at a time, which is
what stops the ordinary version of this. Given the board shows every name and
you now see answers as they come in, an impostor is hard to miss. If you would
rather not rely on that, use the second mode.

The web config keys are meant to be public. The rules are what protect the data,
which is why step 5 matters more than it looks.

### If it is not connecting

Open **`diagnose.html`**. It walks the setup one step at a time and names the
first thing that is wrong, with the fix. The usual culprits:

| What you see | What it means |
|---|---|
| Nothing loads at all | The page was opened from the disk. Browsers block JavaScript modules on `file://`; serve it over http instead |
| `auth/operation-not-allowed` | Anonymous sign-in is off. Authentication → Sign-in method → Anonymous → Enable |
| `auth/configuration-not-found` | Authentication has never been opened on the project. Click Get started first |
| `permission-denied` | The rules are still the default locked-mode set. Paste `firestore.rules` in and press Publish |
| `unavailable` | No Firestore database yet. Firestore Database → Create database → **Native** mode |
| `not-found` | The database has a name other than `(default)`. Put that name in `FIRESTORE_DATABASE_ID` in `js/config.js` |
| Console asks you to sign in | Expected. Use the teacher account from step 6 |
| A student sees "another phone is signed in as you" | Only happens in the locked mode. Class list page, **Release** next to their name |
| A student says their ID is not accepted | Check the ID on the class list. Case, spaces, dashes and underscores are all forgiven; nothing else is |
| Answers not saving for anyone | Class list page, **Release all phones**, then have them pick their names again |
| Teacher sees "still thinking" forever | Republish `firestore.rules`. An older version made the teacher's live read of the answers unreliable |
| Signs in, still refused | That account's UID is not in `admins`. The sign-in screen shows the UID to copy |

That last one is the one that catches people, because it looks exactly like a
connection failure: everything loads, and then creating a class quietly does
nothing. The console now says so out loud instead.

### Deploying to GitHub Pages

Push this folder to a repository, then **Settings → Pages → Deploy from a
branch**, pick `main` and `/ (root)`. The site appears at
`https://<user>.github.io/<repo>/`. No build step, nothing to install.

Give students the `/play.html` link, or a QR code pointing at it.

---

## Keeping answers out of students' hands

The site is public and so is the Firestore data, so a curious student could open
the browser console. Answers are therefore never stored beside the questions:

| Where | Holds | Who can read it |
|---|---|---|
| `classes/{class}/questions/{id}` | text, options, difficulty | everyone signed in |
| `classes/{class}/keys/{id}` | the correct answer | teachers only |

Import splits every question in two automatically. Grading happens on your
machine, and the answer is copied into the live round document only at the
moment you reveal it.

---

## Importing your class list

Paste CSV straight out of a spreadsheet, or JSON. A header row is detected. Tabs
and semicolons work as separators too, and quoted fields survive commas.

```csv
id,name,group
9A-01,Aisha Rahman,Blue
9A-02,"Nguyen, Bao",Gold
```

```json
{ "students": [ { "id": "9A-01", "name": "Aisha Rahman", "group": "Blue" } ] }
```

`name` is required. `id` is filled in from the name if you leave it out.
`group` is optional and is only there for house or team labels.

**Add these students** keeps existing scores for anyone already on the list.
**Replace the whole list** clears everything, scores included.

---

## Importing questions

One JSON file per class, either a bare array or an object with a `questions`
key. `samples/questions.sample.json` shows all six types.

Common fields:

| Field | Notes |
|---|---|
| `type` | see the table below |
| `text` | the question. `question` also works |
| `difficulty` | `1`–`5`, or `warm-up`, `easy`, `medium`, `hard`, `stretch`. Defaults to medium |
| `topic` | free text, used for the filters. `category` also works |
| `explanation` | shown on the reveal, on the board and on student phones |
| `id` | optional; generated from the text if missing |
| `image` | a URL, shown above the question |
| `timeLimitSec` | overrides the class default for this question |
| `partialCredit` | `false` turns off part marks on the multi-answer types |

Answers can be written as an index, a letter, or the option text itself. All
three of these mean the same thing:

```json
"answer": 2        "answer": "C"        "answer": "Carbon dioxide"
```

### The six types

| `type` | Extra fields | `answer` |
|---|---|---|
| `true_false` | — | `true` or `false` |
| `mcq_single` | `options` | one option |
| `mcq_multi` | `options` | a list of options |
| `matching` | `left`, `right` | a list giving the right-hand match for each left item, in order |
| `ordering` | `items` | the same items in the correct order |
| `short_answer` | — | a string, or a list of acceptable strings |

Short answers ignore case, extra spaces and trailing punctuation. Add
`"caseSensitive": true` if that matters.

Aliases are accepted for the type names, so `tf`, `mcq`, `multi-select`,
`pairs`, `sequence` and `written` all land in the right place.

Anything the importer cannot read is listed line by line, and the rest of the
file still imports. Nothing is silently dropped.

---

## How points work

The base is the question's difficulty: 1, 2, 3, 5, 8 for the five levels. What
confidence does to that number depends on which rule you pick in Settings.

### Three levels

Students say *not sure*, *fairly sure* or *certain*.

```
right → difficulty × level
wrong → −difficulty × (level − 1)
```

Being unsure and wrong costs nothing. Being certain and wrong costs twice the
difficulty. Quick to explain, and a good place to start with a class that has
not done this before.

### Percentages

Students give a number from 5 to 99. Points are a reward for being right plus a
term measuring how well the percentage matched the outcome.

The useful property: over a term, the way to score highest is to state what you
actually believe. Bluffing high and hedging low both lose points on average. At
the same time points climb steadily as a student genuinely learns more, so
narrowing four options down to two is worth more than knowing nothing.

Zero sits at an honest guess. A student who says "no idea, 25%" ends the round
near zero rather than in a hole, which keeps people willing to admit it.

The **Results** page then shows each student's calibration, and a chart of what
the class said against what actually happened. When a class says 80%, are they
right about 80% of the time? Most are not, the first few weeks.

Part marks apply on multi-answer, matching and ordering questions. Picking three
right answers and one wrong one out of three scores two thirds, not zero.

---

## Running a round

1. **Draw students.** The big screen flickers through names before settling.
   They stay up for as many questions as the round is set to.
2. **Ask a question.** Pick one, or press *Ask the next question* to take the
   least-used question matching your topic and difficulty filters.
3. Students see the whole set on their phones, choose a confidence for each,
   and lock them all in together. Students who were not drawn can answer along
   for practice; those answers are saved separately and never counted, which
   gives the other twenty-eight people in the room something to do.
4. **Lock and show the answers**, or just let the clock run out. Everything is
   marked at once: a table of who got how many right and what it was worth,
   then question by question with each student's answer beside it.
5. **Next round.** Anyone who got at least one question right sits out the next
   draws, until you bring them back.

Settings worth knowing about:

- **Students per round.** Two by default. Up to eight.
- **Questions per round.** One by default. Raise it and the drawn students get
  that many questions **all at once** on their phones. They answer in any order
  at their own pace and lock the whole set in together, which suits a
  head-to-head over a few questions rather than a single sudden-death one. You
  can let the app choose the set, or tick the ones you want in the list.
- **Seconds per question** sets the clock for each question, so a round of
  three at forty-five seconds runs for two and a quarter minutes. When the
  clock runs out the round marks itself and the console shows who got what
  right, without anyone pressing anything. Anything left unanswered counts as
  wrong, and **Undo the scoring** is there if the timing caught someone out.
- **How they are picked.** *Leans towards whoever has had fewest turns* is still
  a genuine draw — nobody can predict it — but it stops the same four hands
  dominating. Flat random is there if you want it.
- **Who types the answer.** If the class has no phones, switch to *You, as they
  answer out loud* and record confidence and answer yourself.
- **Sitting out.** On by default: a student who answers correctly is skipped by
  the draw until you bring them back, from the panel on the left. Turn it off
  and correct answers stay in the pool.

**Who is here.** The panel of that name on the run screen lists the whole class.
Tap anyone who is absent and the draw skips them; tap again when they are back.
Their score is untouched, and they drop off the scoreboard while they are out,
so a missing student is not sitting in third place all lesson. The same thing
can be done from the Attendance column on the class list.

**While they answer**, the console shows a grid of the drawn students against
the questions, filling in with what each has put and how sure they said they
were, plus a running count of how many of the set they have finished. If
someone has not finished when you reveal, it asks you to confirm first, since
anything blank is scored as wrong.

*Undo the scoring* reverses a round if you misheard an answer.

---

## Prizes

The **Prizes** page keeps a live podium and works out named awards from the
round-by-round record, so more than three students walk away with something:
*Knows what they know*, *Nerve of steel*, *On a roll*, *Surest hand*, *Came on
strongest*. List what you are actually giving out, assign each one, and download
the award sheet.

---

## Files

```
index.html          entry point and connection status
diagnose.html       step-by-step connection check when something is wrong
admin.html          teacher console
board.html          projector
play.html           student phones
css/app.css         all styling
js/config.js        your Firebase settings go here
js/diagnose.js      the connection checks
js/qr.js            builds the join code shown on the big screen
js/db.js            one API over Firestore and local storage
js/model.js         imports, validation, the draw, the awards
js/scoring.js       grading and the two scoring rules
js/render.js        question widgets, confidence picker, sounds
js/admin.js         console logic
js/play.js          student logic
js/board.js         projector logic
firestore.rules     paste into the Firebase console
samples/            example question and class-list files
```

---

## Notes

- **Back up before clearing your browser.** Without Firebase, that browser holds
  the only copy. Settings → *Download a backup*.
- **Each class has its own settings**, so Year 7 can use the three levels while
  Year 11 uses percentages.
- **Sound** is short synthesised cues, no audio files. Browsers stay silent
  until the first click on the page.
- **Reduced motion** is respected: the name-flicker on the draw is skipped for
  anyone whose system asks for that.
