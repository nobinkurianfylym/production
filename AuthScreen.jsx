import React, { useState } from "react";
import { Film, ArrowRight } from "lucide-react";
import { api } from "./api";

const C = {
  board: "#0E1420", panel: "#161E2E", raised: "#1E293C", line: "#2A3750",
  ink: "#E8EAF0", muted: "#8A93A8", faint: "#5C6780", amber: "#F0B429", stop: "#F05C4D",
};
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace";

const inputStyle = { background: C.board, border: `1px solid ${C.line}`, color: C.ink, fontFamily: SANS };

export default function AuthScreen({ onSignedIn, onTryDemo }) {
  const [mode, setMode] = useState("signin"); // signin | signup
  const [f, setF] = useState({ workspaceName: "", name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const result = mode === "signup" ? await api.signup(f) : await api.signin(f);
      onSignedIn(result.user);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: C.board }}>
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-6 justify-center">
          <div className="rounded flex items-center justify-center" style={{ width: 28, height: 28, background: C.amber }}>
            <Film size={16} style={{ color: "#1A1206" }} />
          </div>
          <span className="text-sm font-bold tracking-wide" style={{ color: C.ink, fontFamily: MONO }}>FPMS</span>
        </div>

        <div className="rounded-lg p-5" style={{ background: C.panel, border: `1px solid ${C.line}` }}>
          <div className="flex gap-1 mb-4 rounded p-0.5" style={{ background: C.board }}>
            {[["signin", "Sign in"], ["signup", "Create account"]].map(([k, l]) => (
              <button key={k} onClick={() => { setMode(k); setErr(""); }}
                className="flex-1 text-xs py-1.5 rounded font-medium"
                style={{
                  background: mode === k ? C.raised : "transparent",
                  color: mode === k ? C.ink : C.faint, fontFamily: SANS,
                }}>{l}</button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-3">
            {mode === "signup" && (
              <div>
                <div className="text-xs uppercase mb-1.5" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>
                  Production company
                </div>
                <input required value={f.workspaceName} onChange={(e) => setF({ ...f, workspaceName: e.target.value })}
                  placeholder="e.g. Deccan Light Pictures"
                  className="w-full rounded px-2.5 py-1.5 text-sm outline-none" style={inputStyle} />
              </div>
            )}
            {mode === "signup" && (
              <div>
                <div className="text-xs uppercase mb-1.5" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>Your name</div>
                <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })}
                  className="w-full rounded px-2.5 py-1.5 text-sm outline-none" style={inputStyle} />
              </div>
            )}
            <div>
              <div className="text-xs uppercase mb-1.5" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>Email</div>
              <input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })}
                className="w-full rounded px-2.5 py-1.5 text-sm outline-none" style={inputStyle} />
            </div>
            <div>
              <div className="text-xs uppercase mb-1.5" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>Password</div>
              <input required type="password" minLength={mode === "signup" ? 10 : undefined}
                value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })}
                className="w-full rounded px-2.5 py-1.5 text-sm outline-none" style={inputStyle} />
              {mode === "signup" && <div className="text-xs mt-1" style={{ color: C.faint, fontFamily: SANS }}>At least 10 characters.</div>}
            </div>

            {err && (
              <div className="rounded px-2.5 py-2 text-xs" style={{ background: `${C.stop}15`, border: `1px solid ${C.stop}44`, color: C.muted, fontFamily: SANS }}>
                {err}
              </div>
            )}

            <button type="submit" disabled={busy}
              className="w-full rounded px-3 py-2 text-sm font-medium flex items-center justify-center gap-1.5"
              style={{ background: C.amber, color: "#1A1206", fontFamily: SANS, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
              {!busy && <ArrowRight size={14} />}
            </button>
          </form>
        </div>

        <button onClick={onTryDemo} className="w-full text-center text-xs mt-4 hover:opacity-80"
          style={{ color: C.faint, fontFamily: SANS }}>
          Or try the demo production, no account needed →
        </button>
      </div>
    </div>
  );
}
