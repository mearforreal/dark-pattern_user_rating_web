import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

const SESSION_KEY = "image-select-session-id";
const FEEDBACK_EVERY = 10;

// A reason is due after every FEEDBACK_EVERY rated groups (10, 20, 30, …).
const feedbackDue = (rated, given) => Math.floor(rated / FEEDBACK_EVERY) > given;

function readSessionId() {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}
function writeSessionId(id) {
  try {
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
}

export default function App() {
  const [sessionId, setSessionId] = useState(readSessionId);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!sessionId) return;
    setData(null);
    api
      .getSession(sessionId)
      .then(setData)
      .catch((e) => {
        if (e.status === 404) {
          writeSessionId(null);
          setSessionId(null);
        } else setError(e.message);
      });
  }, [sessionId]);

  const start = (session) => {
    writeSessionId(session.id);
    setSessionId(session.id);
  };
  const signOut = () => {
    writeSessionId(null);
    setSessionId(null);
    setData(null);
  };

  if (error) {
    return (
      <div className="fill center">
        <div className="card notice">
          <h2>Something went wrong</h2>
          <p className="muted">{error}</p>
          <button className="btn" onClick={() => location.reload()}>Try again</button>
        </div>
      </div>
    );
  }
  if (!sessionId) return <StartForm onStart={start} />;
  if (!data) return <div className="fill center muted">Loading…</div>;
  return <Rater data={data} onSignOut={signOut} />;
}

function StartForm({ onStart }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onStart(await api.startSession(name, email));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="fill center page-bg">
      <form className="card start" onSubmit={submit}>
        <h1>Human vs. AI UI study</h1>
        <p className="muted">
          Sign in with your name and email. Your progress is saved as you go:
          sign in again with the same email to continue where you left off.
        </p>
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            autoComplete="name"
          />
        </label>
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Starting…" : "Start"}
        </button>
      </form>
    </div>
  );
}

const CONFIDENCE = [
  { value: 1, label: "Not at all" },
  { value: 2, label: "Slightly" },
  { value: 3, label: "Moderately" },
  { value: 4, label: "Quite" },
  { value: 5, label: "Extremely" },
];

function Rater({ data, onSignOut }) {
  const { session, groups } = data;
  const total = groups.length;
  // { [stem]: { imageId, confidence } }, only saved picks
  const [selections, setSelections] = useState(data.selections);
  // A tile clicked in the current group, waiting for a confidence rating.
  const [pending, setPending] = useState(null);
  const [saving, setSaving] = useState(false);
  const [feedbackCount, setFeedbackCount] = useState(data.feedbackCount);
  // Re-ask on load if they reloaded while a prompt was pending.
  const [showFeedback, setShowFeedback] = useState(() =>
    feedbackDue(Object.keys(data.selections).length, data.feedbackCount)
  );
  const [completed, setCompleted] = useState(!!session.completed_at);
  // Welcome/instructions page: shown before the first rating, and on demand.
  const [showWelcome, setShowWelcome] = useState(
    () => Object.keys(data.selections).length === 0 && !session.completed_at
  );
  const [saveError, setSaveError] = useState(null);
  const [idx, setIdx] = useState(() => {
    const i = groups.findIndex((g) => !data.selections[g.stem]);
    return i === -1 ? 0 : i;
  });

  const group = groups[idx];
  const done = Object.keys(selections).length;
  const saved = group ? selections[group.stem] : undefined;
  const currentChoice = pending?.imageId ?? saved?.imageId;
  const currentPosition = group
    ? group.tiles.findIndex((t) => t.imageId === currentChoice) + 1
    : 0;
  const shownAt = useRef(performance.now());
  const advanceTimer = useRef(null);

  useEffect(() => {
    shownAt.current = performance.now();
    setPending(null);
    setSaveError(null);
  }, [idx]);

  useEffect(() => () => clearTimeout(advanceTimer.current), []);

  const finishIfDone = useCallback(
    (sel) => {
      if (Object.keys(sel).length >= total && !completed) {
        api.complete(session.id).catch(() => {});
        setCompleted(true);
      }
    },
    [total, completed, session.id]
  );

  const advance = useCallback(
    (sel) => {
      for (let k = 1; k <= total; k++) {
        const i = (idx + k) % total;
        if (!sel[groups[i].stem]) return setIdx(i);
      }
      finishIfDone(sel);
    },
    [idx, total, groups, finishIfDone]
  );

  const pickTile = useCallback(
    (tile, position) => {
      if (!group || showFeedback || saving) return;
      setSaveError(null);
      setPending({
        imageId: tile.imageId,
        position,
        responseMs: Math.round(performance.now() - shownAt.current),
      });
    },
    [group, showFeedback, saving]
  );

  const rateConfidence = useCallback(
    async (confidence) => {
      if (!group || showFeedback || saving || !currentChoice) return;
      const next = { ...selections, [group.stem]: { imageId: currentChoice, confidence } };
      setSaving(true);
      setSaveError(null);
      try {
        await api.select(session.id, {
          groupStem: group.stem,
          imageId: currentChoice,
          tilePosition: currentPosition,
          responseMs: pending ? pending.responseMs : null,
          confidence,
        });
      } catch (e) {
        setSaveError(`Your pick was not saved: ${e.message}`);
        return;
      } finally {
        setSaving(false);
      }
      setSelections(next);
      setPending(null);
      if (feedbackDue(Object.keys(next).length, feedbackCount)) {
        setShowFeedback(true);
        return;
      }
      clearTimeout(advanceTimer.current);
      advanceTimer.current = setTimeout(() => advance(next), 240);
    },
    [group, showFeedback, saving, currentChoice, currentPosition, pending, selections,
      session.id, feedbackCount, advance]
  );

  const onFeedbackDone = () => {
    setFeedbackCount((n) => n + 1);
    setShowFeedback(false);
    advance(selections);
  };

  const prev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);
  const next = useCallback(() => setIdx((i) => Math.min(total - 1, i + 1)), [total]);

  // Keys 1–4 pick a screenshot; once one is picked, keys 1–5 rate confidence.
  useEffect(() => {
    const onKey = (e) => {
      if (showFeedback || completed || showWelcome) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key >= "1" && e.key <= "5") {
        const n = Number(e.key);
        if (pending) rateConfidence(n);
        else if (group?.tiles[n - 1]) pickTile(group.tiles[n - 1], n);
      } else if (e.key === "Escape") setPending(null);
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [group, pending, pickTile, rateConfidence, prev, next, showFeedback, completed, showWelcome]);

  if (showWelcome && !completed) {
    return <Welcome total={total} onBegin={() => setShowWelcome(false)} />;
  }

  if (completed) {
    return (
      <div className="fill center page-bg">
        <div className="card notice">
          <h2>Thank you, {session.name}!</h2>
          <p className="muted">
            You rated all {total} groups. Your answers have been recorded.
          </p>
          <button className="btn" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    );
  }

  if (!group) {
    return (
      <div className="fill center">
        <div className="card notice">
          <h2>No images available</h2>
          <p className="muted">Run <code>npm run db:seed</code> to load the image groups.</p>
        </div>
      </div>
    );
  }

  const shownConfidence = pending ? null : saved?.confidence;
  let hint;
  if (saveError) hint = saveError;
  else if (pending) hint = `Option ${currentPosition} picked. Now rate your confidence: press 1–5 or click (Esc to undo).`;
  else if (saved) hint = `Saved: option ${currentPosition}, confidence ${saved.confidence}/5. Click another screenshot or a new confidence to change it.`;
  else hint = "Select the variant you believe is the original human designed UI: press 1–4 or click.";

  return (
    <div className="app">
      <header className="bar">
        <strong className="brand">Human vs. AI UI study</strong>
        <span className="progress-text">
          Group {idx + 1} of {total} · {done} rated
        </span>
        <span className="who">
          {session.name} {session.email && <span className="muted">· {session.email}</span>}
        </span>
        <button className="btn small" onClick={() => setShowWelcome(true)}>Instructions</button>
        <button className="btn small" onClick={onSignOut}>Sign out</button>
      </header>

      <div className="pbar">
        <div className="pbar-fill" style={{ width: `${(done / total) * 100}%` }} />
      </div>

      <div className="body">
        <div className="main-col">
          <main className="grid">
            {group.tiles.map((t, i) => {
              const picked = currentChoice === t.imageId;
              return (
                <button
                  key={t.imageId}
                  className={`tile${picked ? " picked" : ""}`}
                  onClick={() => pickTile(t, i + 1)}
                >
                  <div className="tile-hdr">
                    <span className="num">{i + 1}</span>
                    {picked && <span className="picked-label">Selected</span>}
                  </div>
                  <div className="tile-img">
                    <img src={t.url} alt={`option ${i + 1}`} loading="eager" />
                  </div>
                </button>
              );
            })}
          </main>

          <footer className="controls">
            <button className="btn" onClick={prev} disabled={idx === 0}>
              ← Prev
            </button>
            <div className="answer">
              <div className="answer-group">
                <span className="answer-q">Which is the original?</span>
                <div className="answer-scale" role="radiogroup" aria-label="Original variant">
                  {group.tiles.map((t, i) => (
                    <button
                      key={t.imageId}
                      role="radio"
                      aria-checked={currentChoice === t.imageId}
                      className={`conf variant${currentChoice === t.imageId ? " active" : ""}`}
                      disabled={saving}
                      onClick={() => pickTile(t, i + 1)}
                    >
                      <span className="conf-n">{i + 1}</span>
                      <span className="conf-l">Variant</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="answer-divider" aria-hidden="true" />
              <div className={`answer-group${currentChoice ? "" : " disabled"}`}>
              <span className="answer-q">How confident are you?</span>
              <div className="answer-scale" role="radiogroup" aria-label="Confidence">
                {CONFIDENCE.map((c) => (
                  <button
                    key={c.value}
                    role="radio"
                    aria-checked={shownConfidence === c.value}
                    className={`conf${shownConfidence === c.value ? " active" : ""}`}
                    disabled={!currentChoice || saving}
                    onClick={() => rateConfidence(c.value)}
                  >
                    <span className="conf-n">{c.value}</span>
                    <span className="conf-l">{c.label}</span>
                  </button>
                ))}
              </div>
              </div>
            </div>
            <button className="btn" onClick={next} disabled={idx === total - 1}>
              Next →
            </button>
          </footer>

          <div className={`hint${saveError ? " error" : ""}`}>{hint}</div>
        </div>

        <aside className="instructions">
          <h3>Instructions</h3>
          <p>Each set shows four variants of the same UI. One is the original human designed UI; the other three are AI generated.</p>
          <p>Carefully examine all four, then select the variant you believe is the original human designed UI.</p>
          <p>Then rate your confidence from 1 (not at all confident) to 5 (extremely confident).</p>
          <p>Keys: <kbd>1</kbd>–<kbd>4</kbd> select a variant, then <kbd>1</kbd>–<kbd>5</kbd> rate confidence. <kbd>←</kbd> <kbd>→</kbd> move between sets.</p>
          <p>After every {FEEDBACK_EVERY}th set you'll be asked what characteristics influenced your selection.</p>
        </aside>
      </div>

      {showFeedback && (
        <FeedbackModal sessionId={session.id} rated={done} onDone={onFeedbackDone} />
      )}
    </div>
  );
}

const CONTACT_EMAIL = "M.S.Nkwo@greenwich.ac.uk";
const CONTACT_PHONE = "8147317111";

function Welcome({ total, onBegin }) {
  const checkpoints = [];
  for (let n = FEEDBACK_EVERY; n <= total; n += FEEDBACK_EVERY) checkpoints.push(n);
  const list =
    checkpoints.length > 1
      ? `${checkpoints.slice(0, -1).join(", ")}, and ${checkpoints.at(-1)}`
      : checkpoints.join("");

  return (
    <div className="welcome-page page-bg">
      <article className="card welcome">
        <h1>Instructions</h1>
        <p className="lead">Thank you for participating in this study.</p>
        <p>
          Generative AI (GenAI) is increasingly being used by user experience (UX)
          designers and web developers to create and modify digital user interfaces
          (UIs). The purpose of this study is to investigate the extent to which
          people can distinguish between human designed and AI generated user
          interfaces.
        </p>
        <p>
          Your participation is anonymous. You will not be asked to provide your
          name or other personally identifiable information.
        </p>

        <h2>What you will do</h2>
        <p>
          You will be presented with {total} sets of UI screenshots. Each set
          contains four variants (1, 2, 3, and 4):
        </p>
        <ul>
          <li>One is the original human designed UI.</li>
          <li>The other three are AI generated variants based on the original UI.</li>
          <li>The four variants will be presented in random order.</li>
        </ul>

        <p>For each set:</p>
        <ol type="a">
          <li>Carefully examine all four UI variants.</li>
          <li>Select the variant you believe is the original human designed UI.</li>
          <li>
            Indicate your confidence in your selection on a scale of 1 (not at all
            confident) to 5 (extremely confident).
          </li>
        </ol>

        {list && (
          <p>
            After every {FEEDBACK_EVERY}th set ({list}), you will also be asked to
            briefly explain what characteristics influenced your selection.
          </p>
        )}
        <p>
          There are no penalties for incorrect answers. Please make each judgment
          based on your own assessment of the interfaces.
        </p>
        <p className="muted">
          If you have questions about the study, please email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> or text{" "}
          <a href={`sms:${CONTACT_PHONE}`}>{CONTACT_PHONE}</a>.
        </p>

        <p>Click below to begin the study.</p>
        <button className="btn primary begin" onClick={onBegin} autoFocus>
          Begin the study
        </button>
      </article>
    </div>
  );
}

function FeedbackModal({ sessionId, rated, onDone }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const tooShort = reason.trim().length < 10;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.feedback(sessionId, reason);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="fb-title">
      <form className="card modal" onSubmit={submit}>
        <h2 id="fb-title">Quick question</h2>
        <p className="muted">
          You've rated {rated} groups.
        </p>
        <p className="modal-question">
          What characteristics of the interface most influenced your decision?
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={6}
          autoFocus
          placeholder="e.g. readable text, clean layout, spacing, colours, icons…"
        />
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button className="btn primary" type="submit" disabled={busy || tooShort}>
            {busy ? "Saving…" : "Submit and continue"}
          </button>
        </div>
      </form>
    </div>
  );
}
