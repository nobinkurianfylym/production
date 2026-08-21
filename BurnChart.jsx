import React from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip
} from "recharts";

/* Loaded on demand by App.jsx. Theme values arrive as props so this module
   stays free of any import back into App — no cycle, no duplicated tokens. */
export default function BurnChart({ data, c, mono, sans, fmt }) {
  return (
            <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
        <CartesianGrid stroke={c.line} vertical={false} />
        <XAxis dataKey="day" tick={{ fill: c.faint, fontSize: 11, fontFamily: mono }} stroke={c.line} />
        <YAxis tick={{ fill: c.faint, fontSize: 11, fontFamily: mono }} stroke={c.line}
          tickFormatter={(v) => `${(v / 1e5).toFixed(1)}L`} width={44} />
        <Tooltip contentStyle={{ background: c.raised, border: `1px solid ${c.line}`, borderRadius: 6, fontFamily: sans, fontSize: 12 }}
          labelStyle={{ color: c.muted }} formatter={(v, n) => [fmt(v), n === "actual" ? "Actual" : "Plan"]} />
        <Line type="monotone" dataKey="plan" stroke={c.faint} strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
        <Line type="monotone" dataKey="actual" stroke={c.amber} strokeWidth={2.5} dot={{ r: 2.5, fill: c.amber }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
