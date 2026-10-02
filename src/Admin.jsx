import { useCallback, useEffect, useMemo, useState } from "react";
import { adminApi } from "./api.js";

const PW_KEY = "image-select-admin-pw";

function fmtDate(v) {
  return v ? new Date(v).toLocaleString() : "—";
}
function fmtDuration(s) {
  if (s == null) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}
function fmtConf(v) {
  return v == null ? "—" : `${Number(v).toFixed(1)} / 5`;
}
function pct(n, d) {
  return d ? `${Math.round((n / d) * 100)}%` : "—";
}

export default function Admin() {
  const [password, setPassword] = useState(() => {
    try {
      return sessionStorage.getItem(PW_KEY) || "";
    } catch {
      return "";
    }
  });
  const [authed, setAuthed] = useState(false);
  const client = useMemo(() => adminApi(password), [password]);

  const login = (pw) => {
    try {
      sessionStorage.setItem(PW_KEY, pw);
    } catch {}
    setPassword(pw);
  };
  const logout = () => {
    try {
      sessionStorage.removeItem(PW_KEY);
    } catch {}
    setPassword("");
    setAuthed(false);
  };

  if (!password || !authed) {
    return (
      <Login
        initial={password}
        client={client}
        onLogin={(pw) => {
          login(pw);
          setAuthed(true);
        }}
      />
    );
  }
  return <Dashboard client={client} onLogout={logout} />;
}

function Login({ initial, onLogin }) {
  const [pw, setPw] = useState(initial);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const tryLogin = useCallback(
    async (value) => {
      setBusy(true);
      setError(null);
      try {
        await adminApi(value).stats();
        onLogin(value);
      } catch (e) {
        setError(e.message);
        setBusy(false);
      }
    },
    [onLogin]
  );

  // Auto-login with a password remembered for this tab.
  useEffect(() => {
    if (initial) tryLogin(initial);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fill center page-bg">
      <form
        className="card start"
        onSubmit={(e) => {
          e.preventDefault();
          tryLogin(pw);
        }}
      >
        <h1>Admin</h1>
        <label className="field">
          <span>Password</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy || !pw}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function Dashboard({ client, onLogout }) {
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [st, se] = await Promise.all([client.stats(), client.sessions()]);
      setStats(st);
      setSessions(se);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  const exportCsv = async () => {
    try {
      const blob = await client.exportCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `selections-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  };

  const filtered = useMemo(() => {
    if (!sessions) return [];
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.email || "").includes(q)
    );
  }, [sessions, query]);

  return (
    <div className="admin">
      <header className="bar">
        <strong className="brand">Screenshot study · Admin</strong>
        <span className="muted small-text">{loading ? "Refreshing…" : "Auto-refreshes every 30s"}</span>
        <div className="bar-actions">
          <button className="btn small" onClick={refresh}>Refresh</button>
          <button className="btn small" onClick={exportCsv}>Export CSV</button>
          <button className="btn small" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <div className="admin-body">
        {error && <p className="error">{error}</p>}
        {stats && <Overview stats={stats} />}

        <section className="card section">
          <div className="section-hdr">
            <h2>Participants</h2>
            <input
              className="search"
              placeholder="Search name or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {!sessions ? (
            <p className="muted">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="muted">No sessions yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Started</th>
                    <th>Session time</th>
                    <th className="num-col">Rated</th>
                    <th className="num-col">AI picks</th>
                    <th className="num-col">Original picks</th>
                    <th className="num-col">Avg. confidence</th>
                    <th>Status</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => (
                    <tr
                      key={s.id}
                      className={`clickable${selected === s.id ? " active" : ""}`}
                      onClick={() => setSelected(s.id)}
                    >
                      <td>{s.name}</td>
                      <td className="muted">{s.email || "—"}</td>
                      <td>{fmtDate(s.started_at)}</td>
                      <td>{fmtDuration(s.duration_s)}</td>
                      <td className="num-col">{s.picks}{stats ? ` / ${stats.totals.groups}` : ""}</td>
                      <td className="num-col">{s.ai_picks} <span className="muted">({pct(s.ai_picks, s.picks)})</span></td>
                      <td className="num-col">{s.picks - s.ai_picks} <span className="muted">({pct(s.picks - s.ai_picks, s.picks)})</span></td>
                      <td className="num-col">{fmtConf(s.avg_confidence)}</td>
                      <td>
                        {s.completed_at ? (
                          <span className="badge done">Completed</span>
                        ) : (
                          <span className="badge">In progress</span>
                        )}
                      </td>
                      <td className="reason-cell" title={s.reason || ""}>
                        {s.reason || <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {stats && stats.byGroup.length > 0 && <GroupTable rows={stats.byGroup} />}
      </div>

      {selected && (
        <SessionDrawer
          id={selected}
          client={client}
          onClose={() => setSelected(null)}
          onDeleted={() => {
            setSelected(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Overview({ stats }) {
  const t = stats.totals;
  const originalPicks = t.selections - t.ai_picks;
  const variants = [
    { key: "original", label: "Original" },
    { key: "A", label: "AI variant A" },
    { key: "B", label: "AI variant B" },
    { key: "C", label: "AI variant C" },
  ];
  const maxN = Math.max(1, ...variants.map((v) => stats.byVariant[v.key]?.n || 0));

  return (
    <div className="overview">
      <div className="tiles">
        <Stat label="Participants" value={t.sessions} sub={`${t.completed} completed`} />
        <Stat label="Images rated" value={t.selections} sub={`${t.groups} groups available`} />
        <Stat label="AI variant chosen" value={pct(t.ai_picks, t.selections)} sub={`${t.ai_picks} picks`} />
        <Stat label="Original chosen" value={pct(originalPicks, t.selections)} sub={`${originalPicks} picks · 25% = chance`} />
        <Stat label="Avg. confidence" value={fmtConf(t.avg_confidence)} sub="1 = not at all, 5 = very" />
        <Stat
          label="Avg. time per pick"
          value={t.avg_response_ms != null ? `${(t.avg_response_ms / 1000).toFixed(1)}s` : "—"}
          sub={`${t.feedback} written reasons`}
        />
      </div>

      <section className="card section">
        <h2>Picks by image type</h2>
        <div className="hbars">
          {variants.map((v) => {
            const n = stats.byVariant[v.key]?.n || 0;
            const conf = stats.byVariant[v.key]?.avgConfidence;
            return (
              <div className="hbar-row" key={v.key} title={`${v.label}: ${n} picks (${pct(n, t.selections)}), avg. confidence ${fmtConf(conf)}`}>
                <span className="hbar-label">{v.label}</span>
                <div className="hbar-track">
                  <div className="hbar-fill" style={{ width: `${(n / maxN) * 100}%` }} />
                </div>
                <span className="hbar-value">
                  {n} <span className="muted">· {pct(n, t.selections)}</span>
                </span>
                <span className="hbar-conf muted">conf. {fmtConf(conf)}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function GroupTable({ rows }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="card section">
      <div className="section-hdr">
        <h2>Picks per image group</h2>
        <button className="btn small" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : `Show ${rows.length} groups`}
        </button>
      </div>
      {open && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Group</th>
                <th className="num-col">Picks</th>
                <th className="num-col">Original</th>
                <th className="num-col">A</th>
                <th className="num-col">B</th>
                <th className="num-col">C</th>
                <th className="num-col">Original rate</th>
                <th className="num-col">Avg. confidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.group_stem}>
                  <td className="mono">{r.group_stem}</td>
                  <td className="num-col">{r.picks}</td>
                  <td className="num-col">{r.original_picks}</td>
                  <td className="num-col">{r.a}</td>
                  <td className="num-col">{r.b}</td>
                  <td className="num-col">{r.c}</td>
                  <td className="num-col">{pct(r.original_picks, r.picks)}</td>
                  <td className="num-col">{fmtConf(r.avg_confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SessionDrawer({ id, client, onClose, onDeleted }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    client.session(id).then(setData).catch((e) => setError(e.message));
  }, [id, client]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const del = async () => {
    if (!confirm("Delete this session and all its selections? This cannot be undone.")) return;
    try {
      await client.deleteSession(id);
      onDeleted();
    } catch (e) {
      setError(e.message);
    }
  };

  const s = data?.session;
  const end = s ? s.completed_at || s.last_active_at : null;
  const duration = s ? Math.round((new Date(end) - new Date(s.started_at)) / 1000) : null;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-hdr">
          <h2>{s ? s.name : "Session"}</h2>
          <button className="btn small" onClick={onClose}>Close</button>
        </div>
        {error && <p className="error">{error}</p>}
        {!data ? (
          !error && <p className="muted">Loading…</p>
        ) : (
          <>
            <dl className="meta">
              <dt>Email</dt><dd>{s.email || "—"}</dd>
              <dt>Started</dt><dd>{fmtDate(s.started_at)}</dd>
              <dt>Last activity</dt><dd>{fmtDate(s.last_active_at)}</dd>
              <dt>Completed</dt><dd>{fmtDate(s.completed_at)}</dd>
              <dt>Session time</dt><dd>{fmtDuration(duration)}</dd>
              <dt>Session ID</dt><dd className="mono">{s.id}</dd>
            </dl>

            <h3>Reason for choices</h3>
            {data.feedback.length === 0 ? (
              <p className="muted">Not answered yet.</p>
            ) : (
              data.feedback.map((f, i) => (
                <blockquote key={i} className="reason">
                  {f.reason}
                  <footer className="muted">
                    after {f.after_count} picks · {fmtDate(f.created_at)}
                  </footer>
                </blockquote>
              ))
            )}

            <h3>Selections ({data.selections.length})</h3>
            <div className="sel-list">
              {data.selections.map((r) => (
                <div className="sel-row" key={r.group_stem}>
                  <img src={`/img/${r.image_id}`} alt="" loading="lazy" />
                  <div className="sel-info">
                    <div className="mono">{r.image_name}</div>
                    <div>
                      {r.is_ai ? (
                        <span className="badge ai">AI variant {r.variant}</span>
                      ) : (
                        <span className="badge orig">Original</span>
                      )}
                    </div>
                    <div className="muted small-text">
                      {fmtDate(r.selected_at)} · confidence {r.confidence ?? "—"}/5 · tile {r.tile_position ?? "—"} ·{" "}
                      {r.response_ms != null ? `${(r.response_ms / 1000).toFixed(1)}s` : "—"}
                      {r.changes > 0 && ` · changed ${r.changes}×`}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <button className="btn danger" onClick={del}>Delete session</button>
          </>
        )}
      </aside>
    </div>
  );
}
