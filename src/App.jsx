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
        <h1>Screenshot preference study</h1>
        <p className="muted">
          You'll see groups of four app screenshots. In each group, pick the one
          you think looks best. There are no right or wrong answers. Your progress
          is saved as you go.
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

function Rater({ data, onSignOut }) {
  const { session, groups } = data;
  const total = groups.length;
  const [selections, setSelections] = useState(data.selections);
  const [feedbackCount, setFeedbackCount] = useState(data.feedbackCount);
  // Re-ask on load if they reloaded while a prompt was pending.
  const [showFeedback, setShowFeedback] = useState(() =>
    feedbackDue(Object.keys(data.selections).length, data.feedbackCount)
  );
  const [completed, setCompleted] = useState(!!session.completed_at);
  const [saveError, setSaveError] = useState(null);
  const [idx, setIdx] = useState(() => {
    const i = groups.findIndex((g) => !data.selections[g.stem]);
    return i === -1 ? 0 : i;
  });

  const group = groups[idx];
  const done = Object.keys(selections).length;
  const currentChoice = group ? selections[group.stem] : undefined;
  const shownAt = useRef(performance.now());
  const advanceTimer = useRef(null);

  useEffect(() => {
    shownAt.current = performance.now();
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

  const choose = useCallback(
    async (tile, position) => {
      if (!group || showFeedback) return;
      const next = { ...selections, [group.stem]: tile.imageId };
      setSelections(next);
      setSaveError(null);
      try {
        await api.select(session.id, {
          groupStem: group.stem,
          imageId: tile.imageId,
          tilePosition: position,
          responseMs: Math.round(performance.now() - shownAt.current),
        });
      } catch (e) {
        setSaveError(`Your pick was not saved: ${e.message}`);
        return;
      }
      if (feedbackDue(Object.keys(next).length, feedbackCount)) {
        setShowFeedback(true);
        return;
      }
      clearTimeout(advanceTimer.current);
      advanceTimer.current = setTimeout(() => advance(next), 240);
    },
    [group, showFeedback, selections, session.id, feedbackCount, advance]
  );

  const onFeedbackDone = () => {
    setFeedbackCount((n) => n + 1);
    setShowFeedback(false);
    advance(selections);
  };

  const prev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);
  const next = useCallback(() => setIdx((i) => Math.min(total - 1, i + 1)), [total]);

  useEffect(() => {
    const onKey = (e) => {
      if (showFeedback || completed) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key >= "1" && e.key <= "4") {
        const i = Number(e.key) - 1;
        const t = group?.tiles[i];
        if (t) choose(t, i + 1);
      } else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [group, choose, prev, next, showFeedback, completed]);

  if (completed) {
    return (
      <div className="fill center page-bg">
        <div className="card notice">
          <h2>Thank you, {session.name}!</h2>
          <p className="muted">
            You rated all {total} groups. Your answers have been recorded.
          </p>
          <button className="btn" onClick={onSignOut}>Start a new session</button>
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

  return (
    <div className="app">
      <header className="bar">
        <strong className="brand">Screenshot study</strong>
        <span className="progress-text">
          Group {idx + 1} of {total} · {done} rated
        </span>
        <span className="who">
          {session.name} <span className="muted">· {session.email}</span>
        </span>
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
                  onClick={() => choose(t, i + 1)}
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
            <div className="pick-buttons">
              {group.tiles.map((t, i) => (
                <button
                  key={t.imageId}
                  className={currentChoice === t.imageId ? "sel active" : "sel"}
                  onClick={() => choose(t, i + 1)}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            <button className="btn" onClick={next} disabled={idx === total - 1}>
              Next →
            </button>
          </footer>

          <div className={`hint${saveError ? " error" : ""}`}>
            {saveError ||
              (currentChoice
                ? `Picked option ${group.tiles.findIndex((t) => t.imageId === currentChoice) + 1}`
                : "Pick the best screenshot: press 1–4 or click.")}
          </div>
        </div>

        <aside className="instructions">
          <h3>Instructions</h3>
          <p>Each group shows four versions of the same app screen.</p>
          <p>Choose the one you think looks best overall: clarity, layout, readability, and how polished it feels.</p>
          <p>Use keys <kbd>1</kbd>–<kbd>4</kbd> to pick and <kbd>←</kbd> <kbd>→</kbd> to move between groups. You can change a pick by going back.</p>
          <p>Every {FEEDBACK_EVERY} groups we'll ask you briefly how you made your choices.</p>
        </aside>
      </div>

      {showFeedback && (
        <FeedbackModal sessionId={session.id} rated={done} onDone={onFeedbackDone} />
      )}
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
          You've rated {rated} groups. What was the reason you chose the last{" "}
          {FEEDBACK_EVERY} images? What was your decision based on?
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={6}
          autoFocus
          placeholder="e.g. I picked the ones with the clearest text and least visual clutter…"
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
