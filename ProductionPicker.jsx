import React, { useState } from "react";
import { Film, Plus, ArrowRight, LogOut } from "lucide-react";
import { api } from "./api";

const C = {
  board: "#0E1420", panel: "#161E2E", raised: "#1E293C", line: "#2A3750",
  ink: "#E8EAF0", muted: "#8A93A8", faint: "#5C6780", amber: "#F0B429", go: "#3DD68C",
};
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace";
const inputStyle = { background: C.board, border: `1px solid ${C.line}`, color: C.ink, fontFamily: SANS };

export default function ProductionPicker({ user, productions, onPick, onCreated, onSignOut }) {
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ title: "", format: "Feature", territory: "", company: "", plannedDays: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const res = await api.createProduction(f);
      onCreated(res.id);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen p-4" style={{ background: C.board }}>
      <div className="max-w-lg mx-auto pt-12">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-2">
            <div className="rounded flex items-center justify-center" style={{ width: 26, height: 26, background: C.amber }}>
              <Film size={15} style={{ color: "#1A1206" }} />
            </div>
            <span className="text-sm font-bold" style={{ color: C.ink, fontFamily: MONO }}>FPMS</span>
          </div>
          <button onClick={onSignOut} className="flex items-center gap-1.5 text-xs hover:opacity-80" style={{ color: C.faint, fontFamily: SANS }}>
            <LogOut size={13} /> {user.name}
          </button>
        </div>

        {!creating ? (
          <>
            <div className="text-sm font-semibold mb-3" style={{ color: C.ink, fontFamily: SANS }}>Your productions</div>
            <div className="space-y-2 mb-4">
              {productions.map((p) => (
                <button key={p.id} onClick={() => onPick(p.id)}
                  className="w-full text-left rounded-lg p-4 flex items-center justify-between hover:opacity-90"
                  style={{ background: C.panel, border: `1px solid ${C.line}` }}>
                  <div>
                    <div className="text-sm font-semibold" style={{ color: C.ink, fontFamily: SANS }}>{p.title}</div>
                    <div className="text-xs mt-1" style={{ color: C.faint, fontFamily: SANS }}>
                      {p.status} · your role: {p.role.replace(/_/g, " ")}
                    </div>
                  </div>
                  <ArrowRight size={15} style={{ color: C.faint }} />
                </button>
              ))}
              {!productions.length && (
                <div className="rounded-lg p-6 text-center text-xs" style={{ background: C.panel, border: `1px dashed ${C.line}`, color: C.faint, fontFamily: SANS }}>
                  No productions yet. Create the first one, or ask whoever set one up to add you by email.
                </div>
              )}
            </div>
            <button onClick={() => setCreating(true)}
              className="w-full rounded-lg p-3 flex items-center justify-center gap-1.5 text-sm font-medium"
              style={{ background: C.amber, color: "#1A1206", fontFamily: SANS }}>
              <Plus size={14} /> New production
            </button>
          </>
        ) : (
          <div className="rounded-lg p-5" style={{ background: C.panel, border: `1px solid ${C.line}` }}>
            <div className="text-sm font-semibold mb-4" style={{ color: C.ink, fontFamily: SANS }}>New production</div>
            <form onSubmit={create} className="space-y-3">
              <div>
                <div className="text-xs uppercase mb-1.5" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>Title</div>
                <input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })}
                  className="w-full rounded px-2.5 py-1.5 text-sm outline-none" style={inputStyle} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs uppercase mb-1.5" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>Format</div>
                  <select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}
                    className="w-full rounded px-2.5 py-1.5 text-sm outline-none" style={inputStyle}>
                    {["Feature", "Series", "Short", "Ad film"].map((x) => <option key={x}>{x}</option>)}
                  </select>
                </div>
                <div>
                  <div className="text-xs uppercase mb-1.5" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>Planned days</div>
                  <input type="number" value={f.plannedDays} onChange={(e) => setF({ ...f, plannedDays: e.target.value })}
                    className="w-full rounded px-2.5 py-1.5 text-sm outline-none" style={inputStyle} />
                </div>
              </div>
              <div>
                <div className="text-xs uppercase mb-1.5" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>Territory</div>
                <input value={f.territory} onChange={(e) => setF({ ...f, territory: e.target.value })}
                  placeholder="e.g. India (Karnataka)"
                  className="w-full rounded px-2.5 py-1.5 text-sm outline-none" style={inputStyle} />
              </div>
              {err && <div className="text-xs" style={{ color: "#F05C4D", fontFamily: SANS }}>{err}</div>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setCreating(false)} className="rounded px-3 py-1.5 text-xs"
                  style={{ color: C.muted, border: `1px solid ${C.line}`, fontFamily: SANS }}>Cancel</button>
                <button type="submit" disabled={busy} className="rounded px-3 py-1.5 text-xs font-medium"
                  style={{ background: C.amber, color: "#1A1206", fontFamily: SANS, opacity: busy ? 0.6 : 1 }}>
                  {busy ? "Creating…" : "Create production"}
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="mt-6 text-xs leading-relaxed" style={{ color: C.faint, fontFamily: SANS }}>
          You'll be the producer on anything you create here. To bring your line producer, 1st AD, or
          accountant on, have them sign up first — then add them by email once inside the production.
        </div>
      </div>
    </div>
  );
}
