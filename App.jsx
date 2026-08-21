import React, { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from "react";
import { storage } from "./storage";
import { api } from "./api";
import { applyLocalAction } from "./localEngine";
import AuthScreen from "./AuthScreen.jsx";
import ProductionPicker from "./ProductionPicker.jsx";

// recharts is ~150 kB gzipped for one line chart. On-set connectivity is
// bad enough that it should not sit on the critical path.
const BurnChart = lazy(() => import("./BurnChart.jsx"));
import {
  LayoutDashboard, FileText, Tag, CalendarDays, ClipboardList, Wallet, Receipt,
  Users, MapPin, BarChart3, Plus, X, Check, Search, Download, Printer, Trash2,
  Clock, Sun, Moon, AlertTriangle, ChevronRight, ChevronDown, Film, Upload, Send,
  Eye, Lock, Pencil, Phone, Mail, Layers, TrendingUp, Circle, CheckCircle2,
  GripVertical, Info, CloudSun, ArrowRight, Building2, Menu
} from "lucide-react";

/* ═══════════════════════════════════════════════════════════════════════════
   FPMS — Film Production Management System
   MVP: Project → Script → Breakdown → People → Locations → Budget →
        Schedule → Call Sheet → DPR → Costs → Dashboard
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Design tokens ────────────────────────────────────────────────────────
   The board is dark; the strips are paper. Strip colours are the real
   industry convention, so the schedule reads correctly to anyone who has
   ever stood in front of a physical stripboard.                            */
const C = {
  board:   "#0E1420",   // deepest ground
  panel:   "#161E2E",   // surface
  raised:  "#1E293C",   // raised surface
  line:    "#2A3750",   // hairline
  ink:     "#E8EAF0",   // primary text
  muted:   "#8A93A8",   // secondary text
  faint:   "#5C6780",   // tertiary text
  amber:   "#F0B429",   // attention / gaffer tape
  go:      "#3DD68C",   // on schedule / approved
  stop:    "#F05C4D",   // behind / over / rejected
  cool:    "#6BA8E5",   // informational
};

// Authentic stripboard colours
const STRIP = {
  "INT-DAY":   { bg: "#F5F3EC", fg: "#1A1A1A", label: "INT / DAY" },
  "EXT-DAY":   { bg: "#F2D65C", fg: "#1A1A1A", label: "EXT / DAY" },
  "INT-NIGHT": { bg: "#7EA8D9", fg: "#0E1420", label: "INT / NIGHT" },
  "EXT-NIGHT": { bg: "#7BC49A", fg: "#0E1420", label: "EXT / NIGHT" },
};
const stripKey = (s) => {
  const dn = ["NIGHT", "DUSK"].includes(s.dn) ? "NIGHT" : "DAY";
  return `${s.intExt}-${dn}`;
};
const stripStyle = (s) => STRIP[stripKey(s)] || STRIP["INT-DAY"];

const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/* ── Breakdown element categories (industry standard) ─────────────────── */
const CATEGORIES = [
  { id: "cast",      name: "Cast",              color: "#F05C4D" },
  { id: "extras",    name: "Background",        color: "#E5915C" },
  { id: "stunts",    name: "Stunts",            color: "#F0B429" },
  { id: "vehicles",  name: "Vehicles",          color: "#C9D45C" },
  { id: "props",     name: "Props",             color: "#7BC49A" },
  { id: "dressing",  name: "Set Dressing",      color: "#5CC9B0" },
  { id: "wardrobe",  name: "Wardrobe",          color: "#6BA8E5" },
  { id: "makeup",    name: "Makeup / Hair",     color: "#8E8AE0" },
  { id: "animals",   name: "Animals",           color: "#C77DD4" },
  { id: "sfx",       name: "Special FX",        color: "#E06BA8" },
  { id: "vfx",       name: "Visual FX",         color: "#5CB8D4" },
  { id: "sound",     name: "Sound FX / Music",  color: "#A0A8C0" },
  { id: "equipment", name: "Special Equipment", color: "#D4A05C" },
  { id: "security",  name: "Security",          color: "#8A93A8" },
];
const catById = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[0];

const DEPARTMENTS = ["Production", "Direction", "Camera", "Lighting", "Grip", "Sound",
  "Art", "Costume", "Makeup", "Cast", "Locations", "Transport", "Post"];

/* ── Helpers ──────────────────────────────────────────────────────────── */
const uid = (p = "x") => `${p}_${Math.random().toString(36).slice(2, 9)}`;

// Page counts are held in eighths, the way schedules are actually written.
const eighths = (n) => {
  if (!n) return "0";
  const w = Math.floor(n / 8), r = n % 8;
  if (w && r) return `${w} ${r}/8`;
  if (w) return `${w}`;
  return `${r}/8`;
};
const sumEighths = (list) => list.reduce((a, s) => a + (s.eighths || 0), 0);

const money = (n, compact = false) => {
  if (n == null || isNaN(n)) return "—";
  if (compact) {
    if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
    if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  }
  return "₹" + Math.round(n).toLocaleString("en-IN");
};

const fmtDate = (iso, opts) => {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", opts || { day: "2-digit", month: "short", year: "numeric" });
};
const weekday = (iso) => {
  if (!iso) return "";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long" });
};
const daysBetween = (a, b) =>
  Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);

const nowISO = () => new Date().toISOString();

// Sunrise/sunset approximation from latitude and day-of-year. Good enough to
// put a real number on a call sheet; production settings can override it.
const sunTimes = (lat, iso) => {
  const d = new Date(iso + "T00:00:00");
  const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  const decl = 23.45 * Math.sin(((360 / 365) * (doy - 81) * Math.PI) / 180);
  const latR = (lat * Math.PI) / 180, decR = (decl * Math.PI) / 180;
  const cosH = -Math.tan(latR) * Math.tan(decR);
  if (cosH > 1 || cosH < -1) return { rise: "—", set: "—" };
  const H = (Math.acos(cosH) * 180) / Math.PI / 15;
  const solarNoon = 12 - ((77.6 - 82.5) / 15); // IST offset for Karnataka longitudes
  const toHM = (h) => {
    const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
    return `${String(hh).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`;
  };
  return { rise: toHM(solarNoon - H), set: toHM(solarNoon + H) };
};

const download = (filename, text, mime = "text/csv") => {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const toCSV = (rows) =>
  rows.map((r) => r.map((c) => {
    const v = c == null ? "" : String(c);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(",")).join("\n");

/* ── Seed production ──────────────────────────────────────────────────── */
const SHOOT_START = "2026-08-07";
const dayDate = (n) => {
  const d = new Date(SHOOT_START + "T00:00:00");
  d.setDate(d.getDate() + n - 1);
  return d.toISOString().slice(0, 10);
};

const seedCharacters = [
  { id: "ch1", name: "RAVI",     castId: "p1", minor: false },
  { id: "ch2", name: "MEERA",    castId: "p2", minor: false },
  { id: "ch3", name: "GOWDA",    castId: "p3", minor: false },
  { id: "ch4", name: "CONDUCTOR",castId: "p4", minor: false },
  { id: "ch5", name: "ANJALI",   castId: "p5", minor: true  },
];

const seedLocations = [
  { id: "l1", name: "KSRTC Depot, Kolar",  sets: ["BUS DEPOT", "DEPOT OFFICE"], address: "KSRTC Bus Depot, Kolar Rd, Kolar 563101", lat: 13.13, lng: 78.13, contact: "Mr. Shivanna", phone: "+91 98450 11223", rate: 25000, permit: "Granted", permitExpiry: "2026-08-25", hospital: "SNR District Hospital, 3.2 km", notes: "Depot must be clear by 22:00. Generator parking behind workshop." },
  { id: "l2", name: "Ravi's House, Whitefield", sets: ["RAVI'S HOUSE", "RAVI'S ROOM", "KITCHEN"], address: "12, Ramagondanahalli, Whitefield, Bengaluru 560066", lat: 12.97, lng: 77.75, contact: "Latha Reddy", phone: "+91 99001 44556", rate: 18000, permit: "Granted", permitExpiry: "2026-09-10", hospital: "Vydehi Hospital, 4.1 km", notes: "No shoes inside. Neighbour agreement covers noise until 23:00." },
  { id: "l3", name: "Highway Dhaba, NH-75", sets: ["DHABA", "HIGHWAY"], address: "NH-75, near Narasapura Toll, Kolar District", lat: 13.05, lng: 78.05, contact: "Basha", phone: "+91 90080 77889", rate: 12000, permit: "Applied", permitExpiry: "2026-08-19", hospital: "Narasapura PHC, 6.8 km", notes: "Highway permission from NHAI pending. Traffic marshals required." },
  { id: "l4", name: "Kolar Gold Fields", sets: ["KGF SHAFT", "MINE ROAD"], address: "Champion Reefs, KGF, Kolar 563117", lat: 12.95, lng: 78.28, contact: "BGML Office", phone: "+91 81532 33445", rate: 40000, permit: "Granted", permitExpiry: "2026-08-30", hospital: "KGF Government Hospital, 5.0 km", notes: "Restricted zone. Crew list submitted 72h in advance. No drones." },
  { id: "l5", name: "Kolar Town Police Station", sets: ["POLICE STATION"], address: "MB Road, Kolar 563101", lat: 13.14, lng: 78.13, contact: "PSI Nagaraj", phone: "+91 94480 66778", rate: 0, permit: "Granted", permitExpiry: "2026-08-22", hospital: "SNR District Hospital, 1.1 km", notes: "Shoot only in the disused east wing. Uniforms must not be worn outside." },
];

const seedScenes = [
  { id:"s1",  no:"1",  intExt:"EXT", set:"BUS DEPOT",     dn:"DAWN",  eighths:12, storyDay:1, locId:"l1", cast:["ch1","ch4"],           synopsis:"Ravi arrives before first light and finds the 5:40 to Kolar already gone." },
  { id:"s2",  no:"2",  intExt:"INT", set:"DEPOT OFFICE",  dn:"DAY",   eighths:10, storyDay:1, locId:"l1", cast:["ch1","ch4"],           synopsis:"The conductor refuses to write him a delay slip." },
  { id:"s3",  no:"3",  intExt:"INT", set:"RAVI'S HOUSE",  dn:"NIGHT", eighths:18, storyDay:1, locId:"l2", cast:["ch1","ch2"],           synopsis:"Meera confronts Ravi about the money missing from the tin." },
  { id:"s4",  no:"4",  intExt:"INT", set:"RAVI'S ROOM",   dn:"NIGHT", eighths:6,  storyDay:1, locId:"l2", cast:["ch1"],                  synopsis:"Ravi counts what is left. It is not enough." },
  { id:"s5",  no:"5",  intExt:"EXT", set:"HIGHWAY",       dn:"DAY",   eighths:22, storyDay:2, locId:"l3", cast:["ch1","ch5"],           synopsis:"Ravi walks the shoulder of NH-75. Anjali catches up, uninvited." },
  { id:"s6",  no:"6",  intExt:"INT", set:"DHABA",         dn:"DAY",   eighths:16, storyDay:2, locId:"l3", cast:["ch1","ch5"],           synopsis:"One plate, two people. Anjali negotiates." },
  { id:"s7",  no:"7",  intExt:"EXT", set:"DHABA",         dn:"DUSK",  eighths:8,  storyDay:2, locId:"l3", cast:["ch1","ch5","ch3"],     synopsis:"Gowda's jeep pulls in. Ravi does not look up." },
  { id:"s8",  no:"8",  intExt:"INT", set:"POLICE STATION",dn:"NIGHT", eighths:26, storyDay:2, locId:"l5", cast:["ch1","ch3"],           synopsis:"Gowda takes Ravi's statement twice and believes neither." },
  { id:"s9",  no:"9",  intExt:"INT", set:"POLICE STATION",dn:"DAY",   eighths:14, storyDay:3, locId:"l5", cast:["ch2","ch3"],           synopsis:"Meera comes for her husband and is made to wait four hours." },
  { id:"s10", no:"10", intExt:"EXT", set:"MINE ROAD",     dn:"DAY",   eighths:20, storyDay:3, locId:"l4", cast:["ch1","ch5"],           synopsis:"The road to the shaft. Anjali knows the way; Ravi pretends he does too." },
  { id:"s11", no:"11", intExt:"EXT", set:"KGF SHAFT",     dn:"DAY",   eighths:28, storyDay:3, locId:"l4", cast:["ch1","ch5"],           synopsis:"They find the shaft flooded. Forty years of water." },
  { id:"s12", no:"12", intExt:"EXT", set:"KGF SHAFT",     dn:"DUSK",  eighths:12, storyDay:3, locId:"l4", cast:["ch1"],                  synopsis:"Ravi sits at the lip of the shaft until the light goes." },
  { id:"s13", no:"13", intExt:"INT", set:"KITCHEN",       dn:"NIGHT", eighths:15, storyDay:3, locId:"l2", cast:["ch2","ch5"],           synopsis:"Meera feeds a child who is not hers and asks no questions." },
  { id:"s14", no:"14", intExt:"EXT", set:"BUS DEPOT",     dn:"NIGHT", eighths:19, storyDay:4, locId:"l1", cast:["ch1","ch4","ch3"],     synopsis:"The last bus. Gowda is standing beside it." },
  { id:"s15", no:"15", intExt:"INT", set:"DEPOT OFFICE",  dn:"NIGHT", eighths:11, storyDay:4, locId:"l1", cast:["ch1","ch3","ch4"],     synopsis:"The delay slip, finally written, for the wrong day." },
  { id:"s16", no:"16", intExt:"EXT", set:"HIGHWAY",       dn:"DAWN",  eighths:9,  storyDay:5, locId:"l3", cast:["ch1","ch5"],           synopsis:"Two figures on the shoulder, walking the other way." },
  { id:"s17", no:"17", intExt:"INT", set:"RAVI'S HOUSE",  dn:"DAY",   eighths:13, storyDay:5, locId:"l2", cast:["ch2"],                  synopsis:"Meera puts the tin back on the shelf, empty, and leaves it there." },
  { id:"s18", no:"18", intExt:"EXT", set:"BUS DEPOT",     dn:"DAY",   eighths:7,  storyDay:5, locId:"l1", cast:["ch1","ch2"],           synopsis:"The 5:40, on time, with both of them on it." },
];

const seedPeople = [
  { id:"p1",  name:"Arjun Kamath",     type:"cast", dept:"Cast",       role:"RAVI",              phone:"+91 98860 12345", email:"arjun.k@example.in",  rate:45000, basis:"day", start:dayDate(1),  end:dayDate(26) },
  { id:"p2",  name:"Deepa Rao",        type:"cast", dept:"Cast",       role:"MEERA",             phone:"+91 98450 23456", email:"deepa.rao@example.in",rate:38000, basis:"day", start:dayDate(1),  end:dayDate(24) },
  { id:"p3",  name:"Suresh Hegde",     type:"cast", dept:"Cast",       role:"GOWDA",             phone:"+91 99012 34567", email:"s.hegde@example.in",  rate:30000, basis:"day", start:dayDate(4),  end:dayDate(22) },
  { id:"p4",  name:"Mahadev Naik",     type:"cast", dept:"Cast",       role:"CONDUCTOR",         phone:"+91 90350 45678", email:"m.naik@example.in",   rate:12000, basis:"day", start:dayDate(1),  end:dayDate(20) },
  { id:"p5",  name:"Ira Shetty",       type:"cast", dept:"Cast",       role:"ANJALI (minor)",    phone:"+91 97400 56789", email:"guardian.shetty@example.in", rate:15000, basis:"day", start:dayDate(3), end:dayDate(21) },
  { id:"p10", name:"Nandini Prasad",   type:"crew", dept:"Production", role:"Producer",          phone:"+91 98801 10001", email:"nandini@example.in",  rate:0,     basis:"flat", start:dayDate(-30), end:dayDate(60) },
  { id:"p11", name:"Vikram Sethi",     type:"crew", dept:"Production", role:"Line Producer",     phone:"+91 98801 10002", email:"vikram@example.in",   rate:9000,  basis:"day", start:dayDate(-20), end:dayDate(40) },
  { id:"p12", name:"Fatima Q.",        type:"crew", dept:"Direction",  role:"Director",          phone:"+91 98801 10003", email:"fatima@example.in",   rate:0,     basis:"flat", start:dayDate(-40), end:dayDate(90) },
  { id:"p13", name:"Rohan Dsouza",     type:"crew", dept:"Direction",  role:"1st AD",            phone:"+91 98801 10004", email:"rohan@example.in",    rate:7500,  basis:"day", start:dayDate(-15), end:dayDate(34) },
  { id:"p14", name:"Priya Menon",      type:"crew", dept:"Direction",  role:"2nd AD",            phone:"+91 98801 10005", email:"priya@example.in",    rate:4500,  basis:"day", start:dayDate(-10), end:dayDate(34) },
  { id:"p15", name:"Kabir Anand",      type:"crew", dept:"Direction",  role:"Script Supervisor", phone:"+91 98801 10006", email:"kabir@example.in",    rate:4000,  basis:"day", start:dayDate(1),  end:dayDate(32) },
  { id:"p16", name:"Anil Kurup",       type:"crew", dept:"Camera",     role:"DOP",               phone:"+91 98801 10007", email:"anil@example.in",     rate:15000, basis:"day", start:dayDate(-8), end:dayDate(33) },
  { id:"p17", name:"Sneha Bhat",       type:"crew", dept:"Camera",     role:"Camera Operator",   phone:"+91 98801 10008", email:"sneha@example.in",    rate:6000,  basis:"day", start:dayDate(1),  end:dayDate(32) },
  { id:"p18", name:"Gopal Reddy",      type:"crew", dept:"Lighting",   role:"Gaffer",            phone:"+91 98801 10009", email:"gopal@example.in",    rate:5500,  basis:"day", start:dayDate(-3), end:dayDate(32) },
  { id:"p19", name:"Thomas Mathew",    type:"crew", dept:"Grip",       role:"Key Grip",          phone:"+91 98801 10010", email:"thomas@example.in",   rate:5000,  basis:"day", start:dayDate(1),  end:dayDate(32) },
  { id:"p20", name:"Zoya Rahman",      type:"crew", dept:"Sound",      role:"Sound Recordist",   phone:"+91 98801 10011", email:"zoya@example.in",     rate:7000,  basis:"day", start:dayDate(1),  end:dayDate(32) },
  { id:"p21", name:"Devi Krishnan",    type:"crew", dept:"Art",        role:"Production Designer",phone:"+91 98801 10012",email:"devi@example.in",     rate:8000,  basis:"day", start:dayDate(-25), end:dayDate(33) },
  { id:"p22", name:"Harish Gowda",     type:"crew", dept:"Art",        role:"Art Director",      phone:"+91 98801 10013", email:"harish@example.in",   rate:5000,  basis:"day", start:dayDate(-18), end:dayDate(33) },
  { id:"p23", name:"Leela Nair",       type:"crew", dept:"Costume",    role:"Costume Designer",  phone:"+91 98801 10014", email:"leela@example.in",    rate:5500,  basis:"day", start:dayDate(-14), end:dayDate(32) },
  { id:"p24", name:"Bhavana S.",       type:"crew", dept:"Makeup",     role:"Makeup / Hair",     phone:"+91 98801 10015", email:"bhavana@example.in",  rate:4500,  basis:"day", start:dayDate(1),  end:dayDate(32) },
  { id:"p25", name:"Imran Sheikh",     type:"crew", dept:"Locations",  role:"Location Manager",  phone:"+91 98801 10016", email:"imran@example.in",    rate:5000,  basis:"day", start:dayDate(-30), end:dayDate(33) },
  { id:"p26", name:"Ramesh Yadav",     type:"crew", dept:"Transport",  role:"Transport Captain", phone:"+91 98801 10017", email:"ramesh@example.in",   rate:3500,  basis:"day", start:dayDate(1),  end:dayDate(32) },
  { id:"p27", name:"Aisha Verma",      type:"crew", dept:"Production", role:"Production Accountant",phone:"+91 98801 10018",email:"aisha@example.in",  rate:6000,  basis:"day", start:dayDate(-25), end:dayDate(55) },
];

const seedElements = [
  { id:"e1", cat:"props",    name:"Steel tin (money box)",       dept:"Art",     status:"Ready",    est:800,   actual:750,  vendor:"Chickpet Steel", scenes:["s3","s4","s17"] },
  { id:"e2", cat:"vehicles", name:"KSRTC bus (1998 Leyland)",    dept:"Transport",status:"Ordered", est:180000,actual:0,    vendor:"KSRTC Kolar",    scenes:["s1","s14","s18"] },
  { id:"e3", cat:"vehicles", name:"Police jeep (Mahindra 540)",  dept:"Transport",status:"Ready",   est:45000, actual:45000,vendor:"Retro Wheels",   scenes:["s7","s14"] },
  { id:"e4", cat:"props",    name:"Delay slip book",             dept:"Art",     status:"Ready",    est:400,   actual:380,  vendor:"In-house",       scenes:["s2","s15"] },
  { id:"e5", cat:"wardrobe", name:"Ravi — conductor's khaki",    dept:"Costume", status:"Ready",    est:6500,  actual:6200, vendor:"Nataraj Tailors",scenes:["s1","s2","s14","s15","s18"] },
  { id:"e6", cat:"extras",   name:"Depot passengers (30)",       dept:"Production",status:"To source",est:45000,actual:0,   vendor:"Casting Junction",scenes:["s1","s18"] },
  { id:"e7", cat:"sfx",      name:"Rain rig — highway",          dept:"Art",     status:"Ordered",  est:85000, actual:0,    vendor:"Sagar SFX",      scenes:["s5"] },
  { id:"e8", cat:"vfx",      name:"Shaft water level extension", dept:"Post",    status:"To source",est:220000,actual:0,    vendor:"TBD",            scenes:["s11"] },
  { id:"e9", cat:"equipment",name:"30ft telescopic crane",       dept:"Grip",    status:"Ordered",  est:60000, actual:0,    vendor:"Prasad Rentals", scenes:["s11","s14"] },
  { id:"e10",cat:"security", name:"Traffic marshals (6) NH-75",  dept:"Production",status:"To source",est:24000,actual:0,  vendor:"Sentinel",       scenes:["s5","s16"] },
  { id:"e11",cat:"props",    name:"Enamel plate & two glasses",  dept:"Art",     status:"Ready",    est:600,   actual:540,  vendor:"Russell Market", scenes:["s6"] },
  { id:"e12",cat:"makeup",   name:"Anjali — road dust continuity",dept:"Makeup", status:"Ready",    est:2500,  actual:2500, vendor:"In-house",       scenes:["s5","s6","s7","s10","s11","s16"] },
];

const seedAccounts = [
  { id:"a10", code:"1100", cat:"ATL",   name:"Story & Script",        lines:[{id:"bl1",desc:"Screenplay fee",qty:1,unit:"flat",rate:900000,fringe:0}] },
  { id:"a11", code:"1200", cat:"ATL",   name:"Producer & Direction",  lines:[{id:"bl2",desc:"Director fee",qty:1,unit:"flat",rate:1200000,fringe:0},{id:"bl3",desc:"Producer fee",qty:1,unit:"flat",rate:800000,fringe:0}] },
  { id:"a12", code:"1300", cat:"ATL",   name:"Principal Cast",        lines:[{id:"bl4",desc:"Ravi — 26 days",qty:26,unit:"day",rate:45000,fringe:0.05},{id:"bl5",desc:"Meera — 24 days",qty:24,unit:"day",rate:38000,fringe:0.05},{id:"bl6",desc:"Gowda — 18 days",qty:18,unit:"day",rate:30000,fringe:0.05},{id:"bl7",desc:"Supporting & minor cast",qty:1,unit:"flat",rate:620000,fringe:0.05}] },
  { id:"a20", code:"2100", cat:"BTL",   name:"Production Staff",      lines:[{id:"bl8",desc:"Line producer — 32 days",qty:32,unit:"day",rate:9000,fringe:0.13},{id:"bl9",desc:"AD department — 3 × 32 days",qty:96,unit:"day",rate:5300,fringe:0.13},{id:"bl10",desc:"Production accountant",qty:55,unit:"day",rate:6000,fringe:0.13}] },
  { id:"a21", code:"2200", cat:"BTL",   name:"Camera",                lines:[{id:"bl11",desc:"DOP — 33 days",qty:33,unit:"day",rate:15000,fringe:0.13},{id:"bl12",desc:"Camera crew — 4 × 32",qty:128,unit:"day",rate:4500,fringe:0.13},{id:"bl13",desc:"Camera package rental",qty:32,unit:"day",rate:38000,fringe:0}] },
  { id:"a22", code:"2300", cat:"BTL",   name:"Lighting & Grip",       lines:[{id:"bl14",desc:"Lighting crew — 6 × 32",qty:192,unit:"day",rate:3200,fringe:0.13},{id:"bl15",desc:"Lighting package",qty:32,unit:"day",rate:22000,fringe:0},{id:"bl16",desc:"Grip package & crane days",qty:32,unit:"day",rate:14000,fringe:0}] },
  { id:"a23", code:"2400", cat:"BTL",   name:"Art, Props & Set",      lines:[{id:"bl17",desc:"Art department labour",qty:1,unit:"flat",rate:680000,fringe:0.13},{id:"bl18",desc:"Set construction & dressing",qty:1,unit:"flat",rate:950000,fringe:0},{id:"bl19",desc:"Props & action vehicles",qty:1,unit:"flat",rate:420000,fringe:0}] },
  { id:"a24", code:"2500", cat:"BTL",   name:"Costume, Makeup & Hair",lines:[{id:"bl20",desc:"Costume dept & stock",qty:1,unit:"flat",rate:390000,fringe:0.13},{id:"bl21",desc:"Makeup & hair",qty:1,unit:"flat",rate:260000,fringe:0.13}] },
  { id:"a25", code:"2600", cat:"BTL",   name:"Sound (Production)",    lines:[{id:"bl22",desc:"Sound crew — 32 days",qty:32,unit:"day",rate:11500,fringe:0.13},{id:"bl23",desc:"Sound package",qty:32,unit:"day",rate:6500,fringe:0}] },
  { id:"a26", code:"2700", cat:"BTL",   name:"Locations & Permits",   lines:[{id:"bl24",desc:"Location fees",qty:1,unit:"flat",rate:640000,fringe:0},{id:"bl25",desc:"Permits, police & marshals",qty:1,unit:"flat",rate:185000,fringe:0}] },
  { id:"a27", code:"2800", cat:"BTL",   name:"Transport & Travel",    lines:[{id:"bl26",desc:"Unit vehicles — 32 days",qty:32,unit:"day",rate:26000,fringe:0},{id:"bl27",desc:"Accommodation — Kolar unit",qty:1,unit:"flat",rate:480000,fringe:0}] },
  { id:"a28", code:"2900", cat:"BTL",   name:"Catering & Unit",       lines:[{id:"bl28",desc:"Meals — 85 pax × 32 days",qty:2720,unit:"meal",rate:190,fringe:0},{id:"bl29",desc:"Unit supplies & consumables",qty:1,unit:"flat",rate:145000,fringe:0}] },
  { id:"a30", code:"3100", cat:"POST",  name:"Editorial",             lines:[{id:"bl30",desc:"Editor — 14 weeks",qty:14,unit:"week",rate:65000,fringe:0.13},{id:"bl31",desc:"Cutting room & storage",qty:1,unit:"flat",rate:280000,fringe:0}] },
  { id:"a31", code:"3200", cat:"POST",  name:"VFX",                   lines:[{id:"bl32",desc:"VFX — 42 shots",qty:42,unit:"shot",rate:38000,fringe:0}] },
  { id:"a32", code:"3300", cat:"POST",  name:"Sound Post & Music",    lines:[{id:"bl33",desc:"Sound design, ADR, Foley, mix",qty:1,unit:"flat",rate:1150000,fringe:0},{id:"bl34",desc:"Original score",qty:1,unit:"flat",rate:850000,fringe:0}] },
  { id:"a33", code:"3400", cat:"POST",  name:"DI & Deliverables",     lines:[{id:"bl35",desc:"Colour grade & conform",qty:1,unit:"flat",rate:620000,fringe:0},{id:"bl36",desc:"DCP, masters, subtitles, QC",qty:1,unit:"flat",rate:340000,fringe:0}] },
  { id:"a40", code:"4100", cat:"OTHER", name:"Insurance & Legal",     lines:[{id:"bl37",desc:"Production package insurance",qty:1,unit:"flat",rate:520000,fringe:0},{id:"bl38",desc:"Legal & clearances",qty:1,unit:"flat",rate:280000,fringe:0}] },
  { id:"a41", code:"4200", cat:"OTHER", name:"Contingency",           lines:[{id:"bl39",desc:"Contingency @ 8%",qty:1,unit:"flat",rate:1450000,fringe:0}] },
];

const seedPOs = [
  { id:"po1", no:"PO-0012", vendor:"Prasad Rentals",  accId:"a22", amount:192000, status:"Approved", raisedBy:"Thomas Mathew", date:dayDate(3),  desc:"Crane package — 6 days" },
  { id:"po2", no:"PO-0018", vendor:"Sagar SFX",       accId:"a23", amount:85000,  status:"Approved", raisedBy:"Devi Krishnan", date:dayDate(6),  desc:"Rain rig — highway sequence" },
  { id:"po3", no:"PO-0021", vendor:"KSRTC Kolar",     accId:"a23", amount:180000, status:"Submitted",raisedBy:"Ramesh Yadav",  date:dayDate(9),  desc:"Period bus hire — 8 shooting days" },
  { id:"po4", no:"PO-0024", vendor:"Sentinel Security",accId:"a26",amount:24000,  status:"Submitted",raisedBy:"Imran Sheikh",  date:dayDate(10), desc:"Traffic marshals, NH-75, 2 days" },
  { id:"po5", no:"PO-0009", vendor:"Nataraj Tailors", accId:"a24", amount:64000,  status:"Closed",   raisedBy:"Leela Nair",    date:dayDate(1),  desc:"Principal costume build" },
];

const seedExpenses = [
  { id:"x1", date:dayDate(1),  desc:"Unit catering — Day 1",        accId:"a28", dept:"Production", amount:16150, mode:"Petty cash", status:"Approved", by:"Priya Menon" },
  { id:"x2", date:dayDate(1),  desc:"Depot location fee — Day 1",   accId:"a26", dept:"Locations",  amount:25000, mode:"Bank",       status:"Approved", by:"Imran Sheikh" },
  { id:"x3", date:dayDate(2),  desc:"Unit catering — Day 2",        accId:"a28", dept:"Production", amount:15580, mode:"Petty cash", status:"Approved", by:"Priya Menon" },
  { id:"x4", date:dayDate(2),  desc:"Fuel — generators & unit",     accId:"a27", dept:"Transport",  amount:22400, mode:"Petty cash", status:"Approved", by:"Ramesh Yadav" },
  { id:"x5", date:dayDate(3),  desc:"Unit catering — Day 3",        accId:"a28", dept:"Production", amount:17020, mode:"Petty cash", status:"Approved", by:"Priya Menon" },
  { id:"x6", date:dayDate(3),  desc:"Props purchase — Russell Mkt", accId:"a23", dept:"Art",        amount:8940,  mode:"Petty cash", status:"Approved", by:"Harish Gowda" },
  { id:"x7", date:dayDate(4),  desc:"Unit catering — Day 4",        accId:"a28", dept:"Production", amount:16800, mode:"Petty cash", status:"Approved", by:"Priya Menon" },
  { id:"x8", date:dayDate(4),  desc:"Police bandobast — Kolar",     accId:"a26", dept:"Locations",  amount:18000, mode:"Bank",       status:"Approved", by:"Imran Sheikh" },
  { id:"x9", date:dayDate(4),  desc:"Extra lighting truck — night", accId:"a22", dept:"Lighting",   amount:34500, mode:"Bank",       status:"Submitted",by:"Gopal Reddy" },
  { id:"x10",date:dayDate(5),  desc:"Makeup consumables restock",   accId:"a24", dept:"Makeup",     amount:6300,  mode:"Petty cash", status:"Submitted",by:"Bhavana S." },
  { id:"x11",date:dayDate(5),  desc:"Water & ice — highway unit",   accId:"a28", dept:"Production", amount:4100,  mode:"Petty cash", status:"Submitted",by:"Priya Menon" },
];

// Days 1–4 are wrapped; day 5 is today. Scenes 17 and 13 were carried off
// their planned days and are back in the pool waiting to be rescheduled.
const seedDays = [
  { id:"d1", n:1, date:dayDate(1), unit:"Main", locId:"l1", call:"05:30", shootCall:"06:30", wrap:"18:30", strips:["s1","s2","s18"], status:"Completed" },
  { id:"d2", n:2, date:dayDate(2), unit:"Main", locId:"l2", call:"13:00", shootCall:"14:00", wrap:"02:00", strips:["s3","s4"],       status:"Completed" },
  { id:"d3", n:3, date:dayDate(3), unit:"Main", locId:"l5", call:"12:00", shootCall:"13:00", wrap:"01:00", strips:["s8","s9"],       status:"Completed" },
  { id:"d4", n:4, date:dayDate(4), unit:"Main", locId:"l4", call:"06:00", shootCall:"07:00", wrap:"19:00", strips:["s10"],           status:"Completed" },
  { id:"d5", n:5, date:dayDate(5), unit:"Main", locId:"l4", call:"06:00", shootCall:"07:00", wrap:"19:30", strips:["s11","s12"],     status:"Shooting" },
  { id:"d6", n:6, date:dayDate(6), unit:"Main", locId:"l3", call:"05:00", shootCall:"06:00", wrap:"18:00", strips:["s5","s6"],       status:"Planned" },
  { id:"d7", n:7, date:dayDate(7), unit:"Main", locId:"l3", call:"12:00", shootCall:"13:30", wrap:"23:00", strips:["s7","s16"],      status:"Planned" },
  { id:"d8", n:8, date:dayDate(8), unit:"Main", locId:"l1", call:"14:00", shootCall:"15:30", wrap:"03:00", strips:["s14","s15"],     status:"Planned" },
];

// plannedEighths is frozen onto the report at approval, so a later
// reschedule can never rewrite what the day was supposed to be.
const seedDPRs = {
  d1: { dayId:"d1", done:["s1","s2","s18"], part:[], plannedEighths:29, eighthsShot:29, setups:21, firstShot:"07:05", lunch:"12:30", wrap:"18:42",
        delays:[{reason:"Weather", mins:35, note:"Held for cloud cover, dawn exterior"}], incidents:[], approved:true, approvedBy:"Vikram Sethi" },
  d2: { dayId:"d2", done:["s3","s4"], part:["s17"], plannedEighths:37, eighthsShot:24, setups:18, firstShot:"14:40", lunch:"19:00", wrap:"02:20",
        delays:[{reason:"Technical", mins:50, note:"Genset failure, swapped to backup"}], incidents:[], approved:true, approvedBy:"Vikram Sethi" },
  d3: { dayId:"d3", done:["s8","s9"], part:[], plannedEighths:40, eighthsShot:40, setups:24, firstShot:"13:20", lunch:"18:30", wrap:"01:10",
        delays:[], incidents:[], approved:true, approvedBy:"Vikram Sethi" },
  d4: { dayId:"d4", done:["s10"], part:["s11"], plannedEighths:48, eighthsShot:34, setups:19, firstShot:"07:25", lunch:"12:45", wrap:"19:35",
        delays:[{reason:"Location", mins:70, note:"BGML access clearance re-checked at gate"},{reason:"Talent", mins:25, note:"Minor's mandated rest break"}],
        incidents:[{type:"Near miss", note:"Loose scaffold plank near shaft edge; area cordoned", severity:"Low"}], approved:true, approvedBy:"Vikram Sethi" },
};

const seedState = () => ({
  meta: { version: 1, savedAt: null },
  production: {
    title: "The Last Bus to Kolar",
    format: "Feature",
    languages: "Kannada, English",
    currency: "INR",
    territory: "India (Karnataka)",
    company: "Deccan Light Pictures",
    prepStart: dayDate(-35),
    shootStart: dayDate(1),
    shootEnd: dayDate(32),
    plannedDays: 32,
    dayLengthHours: 12,
    minsPerEighth: 20,  // pace assumption: a 12h day covers ~4.5 pages
    status: "Shooting",
    currentDayId: "d5",
    dpTarget: 24, // target eighths per day
  },
  scenes: seedScenes,
  characters: seedCharacters,
  elements: seedElements,
  people: seedPeople,
  locations: seedLocations,
  days: seedDays,
  dprs: seedDPRs,
  callSheets: {
    d5: { dayId:"d5", version:2, publishedAt:nowISO(), notes:"Second unit remains at KGF. Bring warm layers — shaft floor drops 6°C after sunset.", safety:"Shaft edge is unfenced beyond marker line. No crew past the red tape without Imran. Two marshals on the lip at all times.", ack:["p1","p13","p16","p20","p14"] },
  },
  accounts: seedAccounts,
  pos: seedPOs,
  expenses: seedExpenses,
  audit: [
    { ts:nowISO(), actor:"Rohan Dsouza", action:"Published", object:"Call sheet — Day 5 (Rev 2)", detail:"Distributed to 68 recipients" },
    { ts:nowISO(), actor:"Vikram Sethi", action:"Approved",  object:"DPR — Day 4", detail:"Scene 11 carried to Day 5" },
    { ts:nowISO(), actor:"Gopal Reddy",  action:"Submitted", object:"Expense — Extra lighting truck", detail:"₹34,500 · account 2300" },
    { ts:nowISO(), actor:"Imran Sheikh", action:"Raised",    object:"PO-0024 — Sentinel Security", detail:"₹24,000 · awaiting approval" },
  ],
});

/* ═══════════════════════════════════════════════════════════════════════════
   DERIVED DATA — the golden thread. Everything below is computed from the
   scene list, so schedule, cost and progress can never disagree.
   ═══════════════════════════════════════════════════════════════════════════ */

const sceneById = (st, id) => st.scenes.find((s) => s.id === id);
const locById = (st, id) => st.locations.find((l) => l.id === id);
const personById = (st, id) => st.people.find((p) => p.id === id);
const charById = (st, id) => st.characters.find((c) => c.id === id);
const accById = (st, id) => st.accounts.find((a) => a.id === id);

const scheduledSceneIds = (st) => new Set(st.days.flatMap((d) => d.strips));
const unscheduledScenes = (st) => {
  const sch = scheduledSceneIds(st);
  return st.scenes.filter((s) => !sch.has(s.id));
};

const dayScenes = (st, day) => day.strips.map((id) => sceneById(st, id)).filter(Boolean);

const dayTotals = (st, day) => {
  const sc = dayScenes(st, day);
  const e = sumEighths(sc);
  const cast = new Set(sc.flatMap((s) => s.cast));
  const locs = new Set(sc.map((s) => s.locId));
  const pace = st.production.minsPerEighth || 20;
  const hours = (e * pace) / 60 + (locs.size > 1 ? 1.5 : 0);
  return { eighths: e, scenes: sc.length, cast: cast.size, locs: locs.size, hours };
};

/* Account totals: quantity × rate, plus fringe loading. */
const accountBudget = (acc) =>
  acc.lines.reduce((a, l) => a + l.qty * l.rate * (1 + (l.fringe || 0)), 0);

const accountActual = (st, accId) =>
  st.expenses.filter((x) => x.accId === accId && x.status === "Approved")
    .reduce((a, x) => a + x.amount, 0);

/* An approved PO commits money the moment it is approved — before any
   invoice arrives. Without this, "budget remaining" is a lie. */
const accountCommitted = (st, accId) =>
  st.pos.filter((p) => p.accId === accId && p.status === "Approved")
    .reduce((a, p) => a + p.amount, 0);

const costReport = (st) =>
  st.accounts.map((a) => {
    const budget = accountBudget(a);
    const actual = accountActual(st, a.id);
    const committed = accountCommitted(st, a.id);
    const available = budget - actual - committed;
    return { ...a, budget, actual, committed, available, eac: actual + committed, variance: available };
  });

const CAT_LABEL = {
  ATL: "Above the line",
  BTL: "Below the line — production",
  POST: "Post-production",
  OTHER: "Other & contingency",
};

const budgetTotals = (st) => {
  const rows = costReport(st);
  const sum = (k, cat) => rows.filter((r) => !cat || r.cat === cat).reduce((a, r) => a + r[k], 0);
  return {
    rows,
    byCat: ["ATL", "BTL", "POST", "OTHER"].map((cat) => ({
      cat, label: CAT_LABEL[cat],
      budget: sum("budget", cat), actual: sum("actual", cat), committed: sum("committed", cat),
    })),
    budget: sum("budget"), actual: sum("actual"), committed: sum("committed"),
    available: sum("budget") - sum("actual") - sum("committed"),
  };
};

/* Schedule progress from approved DPRs — the only honest source of "where
   are we". Planned is what the schedule said; actual is what was shot. */
const progress = (st) => {
  const done = st.days.filter((d) => d.status === "Completed");
  const dprs = done.map((d) => st.dprs[d.id]).filter(Boolean);
  // Planned pages are frozen onto the DPR at approval. Reading them off the
  // live strips would let a later reschedule rewrite what "planned" meant.
  const plannedEighths = dprs.reduce((a, r, i) => a + (r.plannedEighths ?? dayTotals(st, done[i]).eighths), 0);
  const shotEighths = dprs.reduce((a, r) => a + (r.eighthsShot || 0), 0);
  const totalEighths = sumEighths(st.scenes);
  const scenesDone = new Set(dprs.flatMap((r) => r.done));
  const dayNo = st.days.find((d) => d.id === st.production.currentDayId)?.n || done.length + 1;
  const perDay = done.length ? shotEighths / done.length : st.production.dpTarget;
  const daysVariance = perDay ? (shotEighths - plannedEighths) / perDay : 0;
  return {
    dayNo, plannedDays: st.production.plannedDays, daysShot: done.length,
    plannedEighths, shotEighths, totalEighths,
    scenesDone: scenesDone.size, totalScenes: st.scenes.length,
    eighthsVariance: shotEighths - plannedEighths,
    daysVariance, perDay,
    // At the current rate, the shoot lands this many days from the plan.
    projectedDays: Math.round(st.production.plannedDays - daysVariance),
    pctPages: totalEighths ? (shotEighths / totalEighths) * 100 : 0,
    setups: dprs.reduce((a, r) => a + (r.setups || 0), 0),
    delayMins: dprs.reduce((a, r) => a + r.delays.reduce((b, d) => b + d.mins, 0), 0),
  };
};

/* Day Out of Days — Start / Work / Hold / Finish per character. */
const dood = (st) => {
  const days = [...st.days].sort((a, b) => a.n - b.n);
  return st.characters.map((ch) => {
    const worksOn = days.map((d) => dayScenes(st, d).some((s) => s.cast.includes(ch.id)));
    const first = worksOn.indexOf(true);
    const last = worksOn.lastIndexOf(true);
    const marks = days.map((d, i) => {
      if (first === -1) return "";
      if (i === first && i === last) return "SWF";
      if (i === first) return "SW";
      if (i === last) return "WF";
      if (worksOn[i]) return "W";
      if (i > first && i < last) return "H";
      return "";
    });
    return {
      ch, marks,
      work: worksOn.filter(Boolean).length,
      hold: marks.filter((m) => m === "H").length,
      total: first === -1 ? 0 : last - first + 1,
    };
  });
};

/* Conflict and readiness warnings. These warn, never block — production
   reality always beats a validation rule. */
const alerts = (st) => {
  const out = [];

  st.days.forEach((day) => {
    const sc = dayScenes(st, day);
    if (!sc.length) return;
    const t = dayTotals(st, day);

    sc.forEach((s) => {
      if (s.locId !== day.locId) {
        out.push({ sev: "warn", cat: "Schedule", day: day.n,
          msg: `Scene ${s.no} belongs to ${locById(st, s.locId)?.name || "an unset location"} but Day ${day.n} is at ${locById(st, day.locId)?.name || "no location"}.` });
      }
    });

    if (t.hours > st.production.dayLengthHours + 0.5) {
      out.push({ sev: "warn", cat: "Schedule", day: day.n,
        msg: `Day ${day.n} estimates ${t.hours.toFixed(1)}h against a ${st.production.dayLengthHours}h day — ${eighths(t.eighths)} pages across ${t.scenes} scenes.` });
    }

    const loc = locById(st, day.locId);
    if (loc) {
      if (loc.permit !== "Granted") {
        out.push({ sev: "stop", cat: "Permit", day: day.n,
          msg: `Day ${day.n} shoots at ${loc.name} — permit is "${loc.permit}", not granted.` });
      } else if (loc.permitExpiry && loc.permitExpiry < day.date) {
        out.push({ sev: "stop", cat: "Permit", day: day.n,
          msg: `${loc.name} permit expires ${fmtDate(loc.permitExpiry)}, before Day ${day.n} on ${fmtDate(day.date)}.` });
      }
    }

    const minors = sc.flatMap((s) => s.cast).map((id) => charById(st, id)).filter((c) => c && c.minor);
    const nightScenes = sc.filter((s) => ["NIGHT", "DUSK"].includes(s.dn));
    if (minors.length && nightScenes.length) {
      out.push({ sev: "warn", cat: "Compliance", day: day.n,
        msg: `Day ${day.n} has a minor (${minors[0].name}) in ${nightScenes.length} night scene${nightScenes.length > 1 ? "s" : ""} — check permitted hours and tutoring.` });
    }

    if (t.locs > 1) {
      out.push({ sev: "info", cat: "Schedule", day: day.n,
        msg: `Day ${day.n} has a company move across ${t.locs} locations — 1.5h allowed in the estimate.` });
    }
  });

  const un = unscheduledScenes(st);
  if (un.length) {
    out.push({ sev: "warn", cat: "Schedule",
      msg: `${un.length} scene${un.length > 1 ? "s are" : " is"} not on the board yet (${eighths(sumEighths(un))} pages).` });
  }

  costReport(st).forEach((r) => {
    if (r.available < 0) {
      out.push({ sev: "stop", cat: "Budget", msg: `Account ${r.code} ${r.name} is over by ${money(-r.available)} once commitments are counted.` });
    } else if (r.budget && r.available / r.budget < 0.1) {
      out.push({ sev: "warn", cat: "Budget", msg: `Account ${r.code} ${r.name} has ${money(r.available)} left — under 10% of budget.` });
    }
  });

  st.days.filter((d) => d.status === "Planned").slice(0, 3).forEach((day) => {
    const ids = new Set(day.strips);
    st.elements.filter((e) => e.status !== "Ready" && e.scenes.some((s) => ids.has(s))).forEach((e) => {
      out.push({ sev: "warn", cat: "Elements", day: day.n,
        msg: `"${e.name}" is ${e.status.toLowerCase()} but is needed on Day ${day.n} (${fmtDate(day.date, { day: "2-digit", month: "short" })}).` });
    });
  });

  const pendingPO = st.pos.filter((p) => p.status === "Submitted");
  const pendingX = st.expenses.filter((x) => x.status === "Submitted");
  if (pendingPO.length) {
    out.push({ sev: "info", cat: "Approvals", msg: `${pendingPO.length} purchase order${pendingPO.length > 1 ? "s" : ""} awaiting approval — ${money(pendingPO.reduce((a, p) => a + p.amount, 0))}.` });
  }
  if (pendingX.length) {
    out.push({ sev: "info", cat: "Approvals", msg: `${pendingX.length} expense claim${pendingX.length > 1 ? "s" : ""} awaiting approval — ${money(pendingX.reduce((a, x) => a + x.amount, 0))}.` });
  }

  const rank = { stop: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
};

/* ═══════════════════════════════════════════════════════════════════════════
   STATE — two backends, one interface.

   Signed in with a production selected: every mutate() posts a named action
   to /api/productions/:id/actions and the server returns authoritative
   state. The server is the source of truth; the client never guesses.

   Demo mode: the same action names run through src/localEngine.js against
   an in-browser copy, persisted to localStorage. Same rules, same
   permission checks, nothing leaves the browser.
   ═══════════════════════════════════════════════════════════════════════════ */
const DEMO_KEY = "fpms:demo:v1";

function useProduction({ productionId, demo }) {
  const [state, setState] = useState(null);
  const [member, setMember] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | saving | saved | error
  const [error, setError] = useState("");
  const timer = useRef(null);

  // ── Load ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    (async () => {
      if (demo) {
        let loaded = null;
        try {
          const res = await storage.get(DEMO_KEY);
          if (res?.value) loaded = JSON.parse(res.value);
        } catch (e) { /* nothing saved yet */ }
        if (!cancelled) {
          setState(loaded || seedState());
          setMember({ role: "producer", department: null }); // demo runs unrestricted
          setStatus("ready");
        }
        return;
      }
      try {
        const res = await api.getState(productionId);
        if (!cancelled) { setState(res.state); setMember(res.member); setStatus("ready"); }
      } catch (e) {
        if (!cancelled) { setError(e.message); setStatus("error"); }
      }
    })();
    return () => { cancelled = true; };
  }, [productionId, demo]);

  const persistDemo = useCallback((next) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { await storage.set(DEMO_KEY, JSON.stringify(next)); } catch (e) { /* quota; stays in memory */ }
    }, 400);
  }, []);

  // ── Mutate ────────────────────────────────────────────────────────────
  const mutate = useCallback(async (type, payload) => {
    setError("");
    if (demo) {
      try {
        setState((prev) => {
          const next = applyLocalAction(prev, member?.role || "producer", "You", type, payload);
          persistDemo(next);
          return next;
        });
      } catch (e) {
        setError(e.message);
      }
      return;
    }
    try {
      setStatus("saving");
      await api.act(productionId, type, payload);
      // Re-read rather than patching locally: the server may have done more
      // than the action implies (approving a DPR also advances the shooting
      // day and pulls part-shot scenes off the board), and a client-side
      // guess at those side effects is how the two drift apart.
      const res = await api.getState(productionId);
      setState(res.state);
      setMember(res.member);
      setStatus("saved");
      setTimeout(() => setStatus((s) => (s === "saved" ? "ready" : s)), 1200);
    } catch (e) {
      setError(e.message);
      setStatus("ready");
    }
  }, [demo, productionId, member, persistDemo]);

  const resetDemo = useCallback(async () => {
    const fresh = seedState();
    setState(fresh);
    try { await storage.set(DEMO_KEY, JSON.stringify(fresh)); } catch (e) { /* ignore */ }
  }, []);

  return { state, member, mutate, status, error, setError, resetDemo };
}

/* ═══════════════════════════════════════════════════════════════════════════
   SHARED UI
   ═══════════════════════════════════════════════════════════════════════════ */

const Panel = ({ children, className = "", style = {} }) => (
  <div className={`rounded-lg ${className}`}
       style={{ background: C.panel, border: `1px solid ${C.line}`, ...style }}>
    {children}
  </div>
);

const PanelHead = ({ title, sub, right, icon: Icon }) => (
  <div className="flex items-start justify-between gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${C.line}` }}>
    <div className="flex items-start gap-2.5 min-w-0">
      {Icon && <Icon size={15} style={{ color: C.faint, marginTop: 2, flexShrink: 0 }} />}
      <div className="min-w-0">
        <div className="text-sm font-semibold truncate" style={{ color: C.ink, fontFamily: SANS }}>{title}</div>
        {sub && <div className="text-xs mt-0.5" style={{ color: C.faint, fontFamily: SANS }}>{sub}</div>}
      </div>
    </div>
    {right && <div className="flex items-center gap-1.5 flex-shrink-0">{right}</div>}
  </div>
);

const Btn = ({ children, onClick, variant = "ghost", size = "md", icon: Icon, disabled, title, className = "" }) => {
  const styles = {
    primary: { background: C.amber, color: "#1A1206", border: `1px solid ${C.amber}` },
    solid:   { background: C.raised, color: C.ink, border: `1px solid ${C.line}` },
    ghost:   { background: "transparent", color: C.muted, border: `1px solid ${C.line}` },
    danger:  { background: "transparent", color: C.stop, border: `1px solid ${C.stop}55` },
    go:      { background: `${C.go}1A`, color: C.go, border: `1px solid ${C.go}55` },
    bare:    { background: "transparent", color: C.muted, border: "1px solid transparent" },
  }[variant];
  const pad = size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-xs";
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`inline-flex items-center gap-1.5 rounded font-medium ${pad} ${disabled ? "opacity-40" : "hover:opacity-75"} ${className}`}
      style={{ ...styles, fontFamily: SANS, cursor: disabled ? "not-allowed" : "pointer", transition: "opacity .15s" }}>
      {Icon && <Icon size={size === "sm" ? 12 : 13} />}
      {children}
    </button>
  );
};

const Pill = ({ children, tone = "muted", mono }) => {
  const t = { go: C.go, stop: C.stop, amber: C.amber, cool: C.cool, muted: C.faint }[tone] || C.faint;
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ background: `${t}1F`, color: t, fontFamily: mono ? MONO : SANS }}>
      {children}
    </span>
  );
};

const Stat = ({ label, value, sub, tone, big }) => (
  <div className="px-4 py-3">
    <div className="text-xs uppercase mb-1" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>{label}</div>
    <div className={big ? "text-2xl" : "text-lg"} style={{ color: tone || C.ink, fontFamily: MONO, fontWeight: 600 }}>{value}</div>
    {sub && <div className="text-xs mt-0.5" style={{ color: C.faint, fontFamily: SANS }}>{sub}</div>}
  </div>
);

const Field = ({ label, children, hint }) => (
  <label className="block">
    <div className="text-xs uppercase mb-1.5" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>{label}</div>
    {children}
    {hint && <div className="text-xs mt-1" style={{ color: C.faint, fontFamily: SANS }}>{hint}</div>}
  </label>
);

const inputStyle = { background: C.board, border: `1px solid ${C.line}`, color: C.ink, fontFamily: SANS };
const Input = ({ className = "", style = {}, ...p }) => (
  <input {...p} className={`w-full rounded px-2.5 py-1.5 text-sm outline-none ${className}`} style={{ ...inputStyle, ...style }} />
);
const Select = ({ children, className = "", ...p }) => (
  <select {...p} className={`w-full rounded px-2.5 py-1.5 text-sm outline-none ${className}`} style={inputStyle}>{children}</select>
);
const TextArea = ({ className = "", style = {}, ...p }) => (
  <textarea {...p} className={`w-full rounded px-2.5 py-1.5 text-sm outline-none ${className}`}
    style={{ ...inputStyle, minHeight: 70, resize: "vertical", ...style }} />
);

const Modal = ({ title, sub, onClose, children, wide }) => (
  <div className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
       style={{ background: "rgba(6,10,18,0.75)" }} onClick={onClose}>
    <div className={`w-full ${wide ? "max-w-4xl" : "max-w-lg"} my-8 rounded-lg`}
         style={{ background: C.panel, border: `1px solid ${C.line}`, boxShadow: "0 24px 60px rgba(0,0,0,.5)" }}
         onClick={(e) => e.stopPropagation()}>
      <div className="flex items-start justify-between gap-4 px-5 py-3.5" style={{ borderBottom: `1px solid ${C.line}` }}>
        <div>
          <div className="text-sm font-semibold" style={{ color: C.ink, fontFamily: SANS }}>{title}</div>
          {sub && <div className="text-xs mt-0.5" style={{ color: C.faint, fontFamily: SANS }}>{sub}</div>}
        </div>
        <button onClick={onClose} style={{ color: C.faint }} className="hover:opacity-70 mt-0.5"><X size={17} /></button>
      </div>
      <div className="p-5">{children}</div>
    </div>
  </div>
);

const Empty = ({ icon: Icon, title, action }) => (
  <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
    {Icon && <Icon size={26} style={{ color: C.faint }} />}
    <div className="text-sm mt-3 mb-3" style={{ color: C.muted, fontFamily: SANS }}>{title}</div>
    {action}
  </div>
);

const Bar = ({ pct, tone = C.amber, h = 5 }) => (
  <div className="w-full rounded-full overflow-hidden" style={{ height: h, background: C.board }}>
    <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: "100%", background: tone, transition: "width .4s ease" }} />
  </div>
);

/* The signature element: a paper strip on a dark board. */
const Strip = ({ scene, st, onDragStart, onRemove, onClick, compact, dim }) => {
  const s = stripStyle(scene);
  const cast = scene.cast.map((id) => charById(st, id)?.name?.slice(0, 3)).filter(Boolean);
  return (
    <div
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onClick={onClick}
      className={`group relative rounded-sm select-none ${onDragStart ? "cursor-grab active:cursor-grabbing" : onClick ? "cursor-pointer" : ""}`}
      style={{
        background: s.bg, color: s.fg, fontFamily: MONO,
        opacity: dim ? 0.4 : 1,
        boxShadow: "0 1px 0 rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.35)",
        borderLeft: `4px solid ${scene.intExt === "EXT" ? "rgba(0,0,0,.38)" : "rgba(0,0,0,.10)"}`,
      }}>
      <div className={`flex items-center gap-2 ${compact ? "px-2 py-1" : "px-2.5 py-1.5"}`}>
        {onDragStart && <GripVertical size={11} style={{ opacity: 0.3, flexShrink: 0 }} />}
        <span className="font-bold text-xs flex-shrink-0" style={{ minWidth: 18 }}>{scene.no}</span>
        <span className="text-xs font-semibold flex-shrink-0" style={{ opacity: 0.65 }}>{scene.intExt}</span>
        <span className="text-xs truncate flex-1 font-medium">{scene.set}</span>
        <span className="text-xs flex-shrink-0" style={{ opacity: 0.6 }}>{scene.dn}</span>
        <span className="text-xs font-bold flex-shrink-0 text-right" style={{ minWidth: 34 }}>{eighths(scene.eighths)}</span>
        {!compact && (
          <span className="text-xs flex-shrink-0 hidden md:inline text-right" style={{ opacity: 0.5, minWidth: 62 }}>
            {cast.join(" ")}
          </span>
        )}
        {onRemove && (
          <button onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="opacity-0 group-hover:opacity-60 flex-shrink-0" title="Take off this day"><X size={12} /></button>
        )}
      </div>
    </div>
  );
};

const SEV = { stop: { c: C.stop, label: "Blocker" }, warn: { c: C.amber, label: "Warning" }, info: { c: C.cool, label: "Note" } };

const AlertRow = ({ a }) => (
  <div className="flex items-start gap-2.5 px-4 py-2.5" style={{ borderBottom: `1px solid ${C.line}` }}>
    <span className="rounded-full flex-shrink-0" style={{ width: 6, height: 6, background: SEV[a.sev].c, marginTop: 6 }} />
    <div className="min-w-0 flex-1">
      <div className="text-xs leading-relaxed" style={{ color: C.muted, fontFamily: SANS }}>{a.msg}</div>
    </div>
    <span className="text-xs flex-shrink-0" style={{ color: C.faint, fontFamily: SANS }}>{a.cat}</span>
  </div>
);
/* ═══════════════════════════════════════════════════════════════════════════
   1 · DASHBOARD
   ═══════════════════════════════════════════════════════════════════════════ */

function Dashboard({ st, go }) {
  const pr = useMemo(() => progress(st), [st]);
  const bt = useMemo(() => budgetTotals(st), [st]);
  const al = useMemo(() => alerts(st), [st]);
  const today = st.days.find((d) => d.id === st.production.currentDayId);
  const upcoming = st.days.filter((d) => d.status === "Planned").slice(0, 4);

  // Cumulative spend against a straight-line plan for the shooting period.
  const burn = useMemo(() => {
    const btlBudget = bt.byCat.find((c) => c.cat === "BTL")?.budget || 0;
    const perDay = btlBudget / st.production.plannedDays;
    let cum = 0;
    return st.days.map((d) => {
      cum += st.expenses.filter((x) => x.date === d.date && x.status === "Approved").reduce((a, x) => a + x.amount, 0);
      return { day: `D${d.n}`, actual: Math.round(cum), plan: Math.round(perDay * d.n) };
    });
  }, [st, bt]);

  const behind = pr.daysVariance < -0.15;
  const ahead = pr.daysVariance > 0.15;

  return (
    <div className="space-y-4">
      {/* Headline numbers */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Panel>
          <Stat big label="Shooting day" value={`${pr.dayNo} / ${pr.plannedDays}`}
            sub={`${pr.daysShot} days wrapped · projecting ${pr.projectedDays} total`} />
          <div className="px-4 pb-3"><Bar pct={(pr.dayNo / pr.plannedDays) * 100} tone={C.amber} /></div>
        </Panel>
        <Panel>
          <Stat big label="Pages shot" value={eighths(pr.shotEighths)}
            tone={behind ? C.stop : ahead ? C.go : C.ink}
            sub={`of ${eighths(pr.totalEighths)} pages broken down · ${pr.scenesDone} of ${pr.totalScenes} scenes`} />
          <div className="px-4 pb-3"><Bar pct={pr.pctPages} tone={behind ? C.stop : C.go} /></div>
        </Panel>
        <Panel>
          <Stat big label="Schedule position"
            value={`${pr.daysVariance >= 0 ? "+" : ""}${pr.daysVariance.toFixed(1)}d`}
            tone={behind ? C.stop : ahead ? C.go : C.ink}
            sub={behind ? `${eighths(-pr.eighthsVariance)} pages behind plan` : ahead ? `${eighths(pr.eighthsVariance)} pages ahead` : "On plan"} />
          <div className="px-4 pb-3 text-xs" style={{ color: C.faint, fontFamily: SANS }}>
            Averaging {eighths(Math.round(pr.perDay))} pages a day
          </div>
        </Panel>
        <Panel>
          <Stat big label="Budget committed" value={money(bt.actual + bt.committed, true)}
            tone={bt.available < 0 ? C.stop : C.ink}
            sub={`${money(bt.available, true)} available of ${money(bt.budget, true)}`} />
          <div className="px-4 pb-3">
            <div className="w-full rounded-full overflow-hidden flex" style={{ height: 5, background: C.board }}>
              <div style={{ width: `${(bt.actual / bt.budget) * 100}%`, background: C.amber }} />
              <div style={{ width: `${(bt.committed / bt.budget) * 100}%`, background: `${C.amber}55` }} />
            </div>
            <div className="flex gap-3 mt-1.5 text-xs" style={{ color: C.faint, fontFamily: SANS }}>
              <span>Spent {money(bt.actual, true)}</span><span>Committed {money(bt.committed, true)}</span>
            </div>
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Today on set */}
        <Panel className="lg:col-span-2">
          <PanelHead icon={Film} title="Today on set"
            sub={today ? `Day ${today.n} · ${weekday(today.date)} ${fmtDate(today.date)} · ${locById(st, today.locId)?.name}` : "No day is marked as shooting"}
            right={today && <Btn size="sm" icon={ArrowRight} onClick={() => go("callsheet")}>Call sheet</Btn>} />
          {today ? (
            <div className="p-4">
              <div className="flex flex-wrap gap-x-6 gap-y-2 mb-4 text-xs" style={{ fontFamily: MONO }}>
                <span style={{ color: C.muted }}>UNIT CALL <b style={{ color: C.ink }}>{today.call}</b></span>
                <span style={{ color: C.muted }}>SHOOTING CALL <b style={{ color: C.ink }}>{today.shootCall}</b></span>
                <span style={{ color: C.muted }}>EST. WRAP <b style={{ color: C.ink }}>{today.wrap}</b></span>
                <span style={{ color: C.muted }}>PAGES <b style={{ color: C.ink }}>{eighths(dayTotals(st, today).eighths)}</b></span>
                <span style={{ color: C.muted }}>CAST <b style={{ color: C.ink }}>{dayTotals(st, today).cast}</b></span>
              </div>
              <div className="space-y-1">
                {dayScenes(st, today).map((s) => <Strip key={s.id} scene={s} st={st} />)}
              </div>
            </div>
          ) : <Empty icon={Film} title="Set a day to Shooting on the schedule board." />}
        </Panel>

        {/* Attention */}
        <Panel>
          <PanelHead icon={AlertTriangle} title="Needs attention"
            sub={`${al.filter((a) => a.sev === "stop").length} blockers · ${al.filter((a) => a.sev === "warn").length} warnings`} />
          <div className="overflow-y-auto" style={{ maxHeight: 340 }}>
            {al.length ? al.slice(0, 12).map((a, i) => <AlertRow key={i} a={a} />)
              : <Empty icon={CheckCircle2} title="Nothing is flagged. Enjoy it while it lasts." />}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Burn */}
        <Panel className="lg:col-span-2">
          <PanelHead icon={TrendingUp} title="Spend against plan"
            sub="Approved expenses, cumulative, against a straight-line production-period plan"
            right={<Btn size="sm" icon={ArrowRight} onClick={() => go("budget")}>Cost report</Btn>} />
          <div className="p-4" style={{ height: 230 }}>
            <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-xs"
              style={{ color: C.faint, fontFamily: SANS }}>Drawing the curve…</div>}>
              <BurnChart data={burn} c={C} mono={MONO} sans={SANS} fmt={money} />
            </Suspense>
          </div>
        </Panel>

        {/* Next days */}
        <Panel>
          <PanelHead icon={CalendarDays} title="Coming up"
            right={<Btn size="sm" icon={ArrowRight} onClick={() => go("schedule")}>Board</Btn>} />
          <div className="p-3 space-y-2">
            {upcoming.length ? upcoming.map((d) => {
              const t = dayTotals(st, d);
              const loc = locById(st, d.locId);
              const flagged = al.some((a) => a.day === d.n && a.sev !== "info");
              return (
                <button key={d.id} onClick={() => go("schedule")}
                  className="w-full text-left rounded p-2.5 hover:opacity-80"
                  style={{ background: C.raised, border: `1px solid ${flagged ? C.amber + "55" : C.line}` }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold" style={{ color: C.ink, fontFamily: MONO }}>DAY {d.n}</span>
                    <span className="text-xs" style={{ color: C.faint, fontFamily: MONO }}>{fmtDate(d.date, { day: "2-digit", month: "short" })}</span>
                  </div>
                  <div className="text-xs truncate mb-1" style={{ color: C.muted, fontFamily: SANS }}>{loc?.name}</div>
                  <div className="flex items-center gap-2 text-xs" style={{ color: C.faint, fontFamily: MONO }}>
                    <span>{t.scenes} sc</span><span>{eighths(t.eighths)} pp</span><span>{t.cast} cast</span>
                    {flagged && <AlertTriangle size={11} style={{ color: C.amber, marginLeft: "auto" }} />}
                  </div>
                </button>
              );
            }) : <Empty icon={CalendarDays} title="No planned days ahead." />}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel>
          <PanelHead icon={Wallet} title="Budget by category" />
          <div className="p-4 space-y-3">
            {bt.byCat.map((c) => {
              const used = c.actual + c.committed;
              const pct = c.budget ? (used / c.budget) * 100 : 0;
              return (
                <div key={c.cat}>
                  <div className="flex justify-between items-baseline mb-1">
                    <span className="text-xs" style={{ color: C.muted, fontFamily: SANS }}>{c.label}</span>
                    <span className="text-xs" style={{ color: pct > 100 ? C.stop : C.ink, fontFamily: MONO }}>
                      {money(used, true)} <span style={{ color: C.faint }}>/ {money(c.budget, true)}</span>
                    </span>
                  </div>
                  <Bar pct={pct} tone={pct > 100 ? C.stop : pct > 85 ? C.amber : C.go} />
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel>
          <PanelHead icon={Clock} title="Activity" sub="Every state change is recorded" />
          <div className="overflow-y-auto" style={{ maxHeight: 240 }}>
            {st.audit.slice(0, 14).map((a, i) => (
              <div key={i} className="px-4 py-2.5 flex items-start gap-3" style={{ borderBottom: `1px solid ${C.line}` }}>
                <div className="min-w-0 flex-1">
                  <div className="text-xs" style={{ color: C.ink, fontFamily: SANS }}>
                    <b>{a.actor}</b> <span style={{ color: C.muted }}>{a.action.toLowerCase()}</span> {a.object}
                  </div>
                  {a.detail && <div className="text-xs mt-0.5" style={{ color: C.faint, fontFamily: SANS }}>{a.detail}</div>}
                </div>
                <span className="text-xs flex-shrink-0" style={{ color: C.faint, fontFamily: MONO }}>
                  {new Date(a.ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   2 · SCRIPT — import, parse, version, scene list
   ═══════════════════════════════════════════════════════════════════════════ */

/* Parses standard screenplay text into scenes. Deliberately conservative:
   the result is always shown for confirmation before it is committed. */
function parseScript(text) {
  const lines = text.split(/\r?\n/);
  const HEAD = /^\s*(?:(\d{1,3}[A-Z]?)[.)]?\s+)?(INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?|INT\.?|EXT\.?)\s+(.+?)\s*$/i;
  const DN = /[-–—]\s*(DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|CONTINUOUS|LATER|SUNSET|SUNRISE)\b/i;
  const TRANS = /^(CUT TO|FADE (IN|OUT|TO)|DISSOLVE TO|SMASH CUT|MATCH CUT|THE END|INTERCUT)/i;

  const scenes = [];
  let cur = null, auto = 0;

  const flush = () => {
    if (!cur) return;
    const body = cur._lines.filter((l) => l.trim()).length;
    cur.eighths = Math.max(1, Math.round((body / 52) * 8));
    cur.synopsis = (cur._lines.find((l) => l.trim() && !/^[A-Z0-9 .'()\-]+$/.test(l.trim())) || "").trim().slice(0, 160);
    cur.castNames = [...new Set(cur._cast)];
    delete cur._lines; delete cur._cast;
    scenes.push(cur);
  };

  lines.forEach((raw, i) => {
    const line = raw.trim();
    const m = line.match(HEAD);
    const looksLikeHeading = m && line.length < 90 && line === line.toUpperCase();

    if (looksLikeHeading) {
      flush();
      auto += 1;
      let rest = m[3];
      const dnm = rest.match(DN);
      let dn = "DAY";
      if (dnm) { dn = dnm[1].toUpperCase(); rest = rest.slice(0, dnm.index).trim(); }
      if (dn === "MORNING" || dn === "SUNRISE") dn = "DAWN";
      if (dn === "EVENING" || dn === "SUNSET") dn = "DUSK";
      if (dn === "CONTINUOUS" || dn === "LATER") dn = "DAY";
      rest = rest.replace(/\s+\d{1,3}[A-Z]?$/, "").replace(/[-–—]\s*$/, "").trim();
      cur = {
        id: uid("s"), no: m[1] || String(auto),
        intExt: /^EXT/i.test(m[2]) ? "EXT" : "INT",
        set: rest.toUpperCase() || "UNNAMED SET",
        dn, storyDay: 1, locId: null, cast: [], synopsis: "",
        _lines: [], _cast: [],
      };
      return;
    }
    if (!cur) return;
    cur._lines.push(raw);

    // Character cue: short all-caps line followed by dialogue
    const isCue = line && line.length < 36 && line === line.toUpperCase() &&
      /^[A-Z][A-Z .'()\-]+$/.test(line) && !TRANS.test(line) &&
      (lines[i + 1] || "").trim().length > 0;
    if (isCue) cur._cast.push(line.replace(/\s*\(.*\)$/, "").trim());
  });
  flush();
  return scenes;
}

const SAMPLE_SCRIPT = `INT. DEPOT CANTEEN - DAY

Steam off a tea urn. RAVI stands at the counter, counting coins
into his palm. The CANTEEN WOMAN watches him do it twice.

CANTEEN WOMAN
Same as yesterday. It won't grow.

RAVI
I know what it is.

EXT. DEPOT YARD - NIGHT

Rows of parked buses. RAVI walks between them, running a hand
along the cold panels until he finds the one he wants.

GOWDA (O.S.)
That one doesn't run.

RAVI
It ran on Tuesday.`;

function ScriptModule({ st, mutate }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [sel, setSel] = useState(null);
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);

  const sch = scheduledSceneIds(st);
  const list = st.scenes.filter((s) => {
    if (filter === "unscheduled" && sch.has(s.id)) return false;
    if (filter === "night" && !["NIGHT", "DUSK"].includes(s.dn)) return false;
    if (filter === "ext" && s.intExt !== "EXT") return false;
    if (!q) return true;
    const t = `${s.no} ${s.set} ${s.synopsis} ${s.cast.map((c) => charById(st, c)?.name).join(" ")}`.toLowerCase();
    return t.includes(q.toLowerCase());
  });

  const exportScenes = () => {
    download("scene-list.csv", toCSV([
      ["Scene", "INT/EXT", "Set", "D/N", "Pages", "Story day", "Location", "Cast", "Synopsis", "Scheduled"],
      ...st.scenes.map((s) => [s.no, s.intExt, s.set, s.dn, eighths(s.eighths), s.storyDay,
        locById(st, s.locId)?.name || "", s.cast.map((c) => charById(st, c)?.name).join(" / "), s.synopsis,
        sch.has(s.id) ? "Yes" : "No"]),
    ]));
  };

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHead icon={FileText} title={st.production.title}
          sub={`Blue revision · ${st.scenes.length} scenes · ${eighths(sumEighths(st.scenes))} pages · ${st.characters.length} speaking roles`}
          right={<>
            <Btn size="sm" icon={Download} onClick={exportScenes}>Export</Btn>
            <Btn size="sm" icon={Plus} onClick={() => setAdding(true)}>Add scene</Btn>
            <Btn size="sm" variant="primary" icon={Upload} onClick={() => setImporting(true)}>Import script</Btn>
          </>} />
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <div className="relative flex-1" style={{ minWidth: 200 }}>
            <Search size={13} style={{ color: C.faint, position: "absolute", left: 9, top: 9 }} />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search scenes, sets, characters" style={{ paddingLeft: 28 }} />
          </div>
          {[["all", "All"], ["unscheduled", "Not on the board"], ["night", "Night"], ["ext", "Exterior"]].map(([k, l]) => (
            <Btn key={k} size="sm" variant={filter === k ? "solid" : "bare"} onClick={() => setFilter(k)}>{l}</Btn>
          ))}
        </div>
      </Panel>

      <Panel>
        <div className="overflow-x-auto">
          <table className="w-full text-xs" style={{ fontFamily: MONO }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                {["Sc", "", "Set", "D/N", "Pages", "Story day", "Location", "Cast", "Board"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 font-medium uppercase"
                    style={{ color: C.faint, fontFamily: SANS, fontSize: 11, letterSpacing: "0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} onClick={() => setSel(s.id)} className="cursor-pointer hover:opacity-90"
                  style={{ borderBottom: `1px solid ${C.line}`, background: sel === s.id ? C.raised : "transparent" }}>
                  <td className="px-3 py-2 font-bold" style={{ color: C.ink }}>{s.no}</td>
                  <td className="px-1 py-2">
                    <span className="inline-block rounded-sm" style={{ width: 9, height: 9, background: stripStyle(s).bg }} />
                  </td>
                  <td className="px-3 py-2" style={{ color: C.ink }}>{s.intExt}. {s.set}</td>
                  <td className="px-3 py-2" style={{ color: C.muted }}>{s.dn}</td>
                  <td className="px-3 py-2" style={{ color: C.ink }}>{eighths(s.eighths)}</td>
                  <td className="px-3 py-2" style={{ color: C.muted }}>{s.storyDay}</td>
                  <td className="px-3 py-2 truncate" style={{ color: C.muted, maxWidth: 170 }}>{locById(st, s.locId)?.name || "—"}</td>
                  <td className="px-3 py-2" style={{ color: C.muted }}>{s.cast.map((c) => charById(st, c)?.name).join(" ") || "—"}</td>
                  <td className="px-3 py-2">
                    {sch.has(s.id) ? <Pill tone="go">Scheduled</Pill> : <Pill tone="amber">Off board</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <Empty icon={FileText} title="No scenes match that filter." />}
        </div>
      </Panel>

      {sel && <SceneModal st={st} mutate={mutate} sceneId={sel} onClose={() => setSel(null)} />}
      {importing && <ImportModal st={st} mutate={mutate} onClose={() => setImporting(false)} />}
      {adding && <AddSceneModal st={st} mutate={mutate} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddSceneModal({ st, mutate, onClose }) {
  const nextNo = String(st.scenes.length + 1);
  const [d, setD] = useState({ no: nextNo, intExt: "INT", set: "", dn: "DAY", eighths: 1, storyDay: 1, locId: "", synopsis: "", cast: [] });

  const toggleCast = (chId) =>
    setD((p) => ({ ...p, cast: p.cast.includes(chId) ? p.cast.filter((c) => c !== chId) : [...p.cast, chId] }));

  const save = () => {
    if (!d.set.trim()) return;
    mutate("addScene", { ...d, set: d.set.toUpperCase(), eighths: Number(d.eighths) || 1, storyDay: Number(d.storyDay) || 1, locId: d.locId || null });
    onClose();
  };

  return (
    <Modal title="Add a scene" sub="For scenes not covered by a script import — or a script you're still writing" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Scene"><Input value={d.no} onChange={(e) => setD({ ...d, no: e.target.value })} /></Field>
          <Field label="Int / Ext">
            <Select value={d.intExt} onChange={(e) => setD({ ...d, intExt: e.target.value })}><option>INT</option><option>EXT</option></Select>
          </Field>
          <Field label="Day / Night">
            <Select value={d.dn} onChange={(e) => setD({ ...d, dn: e.target.value })}>
              {["DAY", "NIGHT", "DAWN", "DUSK"].map((x) => <option key={x}>{x}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Set"><Input value={d.set} onChange={(e) => setD({ ...d, set: e.target.value })} placeholder="e.g. DEPOT OFFICE" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Pages (eighths)"><Input type="number" min="1" value={d.eighths} onChange={(e) => setD({ ...d, eighths: e.target.value })} /></Field>
          <Field label="Story day"><Input type="number" min="1" value={d.storyDay} onChange={(e) => setD({ ...d, storyDay: e.target.value })} /></Field>
        </div>
        <Field label="Location">
          <Select value={d.locId} onChange={(e) => setD({ ...d, locId: e.target.value })}>
            <option value="">Not assigned</option>
            {st.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Cast in this scene">
          <div className="flex flex-wrap gap-1.5">
            {st.characters.map((c) => (
              <button key={c.id} onClick={() => toggleCast(c.id)} type="button"
                className="rounded px-2 py-1 text-xs font-medium"
                style={{
                  fontFamily: MONO,
                  background: d.cast.includes(c.id) ? `${C.amber}22` : C.board,
                  color: d.cast.includes(c.id) ? C.amber : C.faint,
                  border: `1px solid ${d.cast.includes(c.id) ? C.amber + "66" : C.line}`,
                }}>{c.name}</button>
            ))}
            {!st.characters.length && <span className="text-xs" style={{ color: C.faint, fontFamily: SANS }}>No characters yet — add cast in People, or leave this scene uncast for now.</span>}
          </div>
        </Field>
        <Field label="Synopsis"><TextArea value={d.synopsis} onChange={(e) => setD({ ...d, synopsis: e.target.value })} /></Field>
        <div className="flex justify-end gap-2 pt-1">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" icon={Plus} onClick={save} disabled={!d.set.trim()}>Add scene</Btn>
        </div>
      </div>
    </Modal>
  );
}

function SceneModal({ st, mutate, sceneId, onClose }) {
  const s = sceneById(st, sceneId);
  const [d, setD] = useState({ ...s });
  if (!s) return null;
  const els = st.elements.filter((e) => e.scenes.includes(s.id));

  const save = () => {
    mutate("editScene", {
      sceneId: s.id, no: d.no, intExt: d.intExt, set: d.set, dn: d.dn,
      eighths: Number(d.eighths) || 1, storyDay: Number(d.storyDay) || 1, locId: d.locId,
      synopsis: d.synopsis, cast: d.cast,
    });
    onClose();
  };

  const toggleCast = (chId) =>
    setD({ ...d, cast: d.cast.includes(chId) ? d.cast.filter((c) => c !== chId) : [...d.cast, chId] });

  return (
    <Modal wide title={`Scene ${s.no}`} sub={`${s.intExt}. ${s.set} — ${s.dn}`} onClose={onClose}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Scene"><Input value={d.no} onChange={(e) => setD({ ...d, no: e.target.value })} /></Field>
            <Field label="Int / Ext">
              <Select value={d.intExt} onChange={(e) => setD({ ...d, intExt: e.target.value })}>
                <option>INT</option><option>EXT</option>
              </Select>
            </Field>
            <Field label="Day / Night">
              <Select value={d.dn} onChange={(e) => setD({ ...d, dn: e.target.value })}>
                {["DAY", "NIGHT", "DAWN", "DUSK"].map((x) => <option key={x}>{x}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Set"><Input value={d.set} onChange={(e) => setD({ ...d, set: e.target.value.toUpperCase() })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Pages (eighths)" hint={`Reads as ${eighths(Number(d.eighths) || 0)}`}>
              <Input type="number" min="1" value={d.eighths} onChange={(e) => setD({ ...d, eighths: e.target.value })} />
            </Field>
            <Field label="Story day">
              <Input type="number" min="1" value={d.storyDay} onChange={(e) => setD({ ...d, storyDay: e.target.value })} />
            </Field>
          </div>
          <Field label="Location">
            <Select value={d.locId || ""} onChange={(e) => setD({ ...d, locId: e.target.value || null })}>
              <option value="">Not assigned</option>
              {st.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="Synopsis"><TextArea value={d.synopsis} onChange={(e) => setD({ ...d, synopsis: e.target.value })} /></Field>
        </div>

        <div className="space-y-3">
          <Field label="Cast in this scene">
            <div className="flex flex-wrap gap-1.5">
              {st.characters.map((c) => (
                <button key={c.id} onClick={() => toggleCast(c.id)}
                  className="rounded px-2 py-1 text-xs font-medium"
                  style={{
                    fontFamily: MONO,
                    background: d.cast.includes(c.id) ? `${C.amber}22` : C.board,
                    color: d.cast.includes(c.id) ? C.amber : C.faint,
                    border: `1px solid ${d.cast.includes(c.id) ? C.amber + "66" : C.line}`,
                  }}>
                  {c.name}{c.minor ? " ▪" : ""}
                </button>
              ))}
            </div>
          </Field>

          <div>
            <div className="text-xs uppercase mb-1.5" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>
              Breakdown elements ({els.length})
            </div>
            <div className="rounded" style={{ border: `1px solid ${C.line}`, maxHeight: 210, overflowY: "auto" }}>
              {els.length ? els.map((e) => (
                <div key={e.id} className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderBottom: `1px solid ${C.line}` }}>
                  <span className="rounded-full flex-shrink-0" style={{ width: 6, height: 6, background: catById(e.cat).color }} />
                  <span className="text-xs flex-1 truncate" style={{ color: C.ink, fontFamily: SANS }}>{e.name}</span>
                  <Pill tone={e.status === "Ready" ? "go" : e.status === "Ordered" ? "cool" : "amber"}>{e.status}</Pill>
                </div>
              )) : <div className="px-3 py-6 text-center text-xs" style={{ color: C.faint, fontFamily: SANS }}>
                Nothing tagged yet. Tag elements in Breakdown.</div>}
            </div>
          </div>

          <div className="rounded p-3" style={{ background: C.board, border: `1px solid ${C.line}` }}>
            <div className="text-xs mb-1" style={{ color: C.faint, fontFamily: SANS }}>On the board</div>
            {(() => {
              const day = st.days.find((x) => x.strips.includes(s.id));
              return day
                ? <div className="text-xs" style={{ color: C.ink, fontFamily: MONO }}>
                    DAY {day.n} · {fmtDate(day.date)} · {locById(st, day.locId)?.name}
                  </div>
                : <div className="text-xs" style={{ color: C.amber, fontFamily: MONO }}>Not scheduled</div>;
            })()}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" icon={Check} onClick={save}>Save scene</Btn>
      </div>
    </Modal>
  );
}

function ImportModal({ st, mutate, onClose }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [mode, setMode] = useState("replace");

  const run = () => setParsed(parseScript(text));

  const commit = () => {
    if (!parsed || !parsed.length) return;
    mutate("importScript", { scenes: parsed, mode });
    onClose();
  };

  return (
    <Modal wide title="Import script" sub="Paste screenplay text. Nothing is committed until you confirm the parse." onClose={onClose}>
      {!parsed ? (
        <div className="space-y-3">
          <Field label="Screenplay text" hint="Standard sluglines: INT. / EXT. SET NAME - DAY. Character cues in caps above dialogue become cast.">
            <TextArea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 240, fontFamily: MONO, fontSize: 12 }}
              placeholder="INT. DEPOT OFFICE - DAY&#10;&#10;Ravi waits at the counter..." />
          </Field>
          <div className="flex items-center justify-between">
            <Btn size="sm" onClick={() => setText(SAMPLE_SCRIPT)}>Paste a sample</Btn>
            <div className="flex gap-2">
              <Btn onClick={onClose}>Cancel</Btn>
              <Btn variant="primary" icon={Search} onClick={run} disabled={!text.trim()}>Parse script</Btn>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded px-3 py-2" style={{ background: `${C.cool}12`, border: `1px solid ${C.cool}40` }}>
            <Info size={14} style={{ color: C.cool, flexShrink: 0 }} />
            <div className="text-xs" style={{ color: C.muted, fontFamily: SANS }}>
              Found <b style={{ color: C.ink }}>{parsed.length} scenes</b>, {eighths(sumEighths(parsed))} pages, and{" "}
              <b style={{ color: C.ink }}>{new Set(parsed.flatMap((s) => s.castNames)).size} speaking characters</b>. Check the page counts — they are estimated from line count and are usually the first thing to correct.
            </div>
          </div>
          <div className="rounded overflow-y-auto" style={{ border: `1px solid ${C.line}`, maxHeight: 280 }}>
            {parsed.map((s, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${C.line}` }}>
                <span className="rounded-sm flex-shrink-0" style={{ width: 8, height: 8, background: stripStyle(s).bg }} />
                <span className="text-xs font-bold" style={{ color: C.ink, fontFamily: MONO, minWidth: 24 }}>{s.no}</span>
                <span className="text-xs flex-1 truncate" style={{ color: C.ink, fontFamily: MONO }}>{s.intExt}. {s.set} — {s.dn}</span>
                <span className="text-xs" style={{ color: C.muted, fontFamily: MONO }}>{s.castNames.join(" ")}</span>
                <span className="text-xs font-bold" style={{ color: C.amber, fontFamily: MONO, minWidth: 34, textAlign: "right" }}>{eighths(s.eighths)}</span>
              </div>
            ))}
          </div>
          <Field label="How should this land?">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="replace">Replace the scene list — clears the stripboard</option>
              <option value="append">Add these after the existing scenes</option>
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Btn onClick={() => setParsed(null)}>Back</Btn>
            <Btn variant="primary" icon={Check} onClick={commit}>Commit {parsed.length} scenes</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   3 · BREAKDOWN
   ═══════════════════════════════════════════════════════════════════════════ */

function Breakdown({ st, mutate }) {
  const [view, setView] = useState("scene");
  const [sceneId, setSceneId] = useState(st.scenes[0]?.id);
  const [adding, setAdding] = useState(null); // category id
  const scene = sceneById(st, sceneId);

  const tag = (catId, name, existingId) => {
    mutate("tagElement", { cat: catId, name, existingId, sceneId, sceneNo: scene?.no, dept: "Art" });
    setAdding(null);
  };

  const untag = (elId) => mutate("untagElement", { elementId: elId, sceneId });

  const setStatus = (elId, status) => mutate("setElementStatus", { elementId: elId, status });

  const exportElements = () => download("element-report.csv", toCSV([
    ["Category", "Element", "Department", "Status", "Estimate", "Actual", "Vendor", "Scenes"],
    ...st.elements.map((e) => [catById(e.cat).name, e.name, e.dept, e.status, e.est, e.actual, e.vendor,
      e.scenes.map((s) => sceneById(st, s)?.no).filter(Boolean).join(" ")]),
  ]));

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHead icon={Tag} title="Script breakdown"
          sub={`${st.elements.length} elements across ${st.scenes.length} scenes · estimated ${money(st.elements.reduce((a, e) => a + e.est, 0))}`}
          right={<>
            <Btn size="sm" variant={view === "scene" ? "solid" : "bare"} onClick={() => setView("scene")}>By scene</Btn>
            <Btn size="sm" variant={view === "register" ? "solid" : "bare"} onClick={() => setView("register")}>Element register</Btn>
            <Btn size="sm" icon={Download} onClick={exportElements}>Export</Btn>
          </>} />
      </Panel>

      {view === "scene" ? (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <Panel className="lg:col-span-1">
            <PanelHead title="Scenes" sub="Pick one to break down" />
            <div className="overflow-y-auto" style={{ maxHeight: 560 }}>
              {st.scenes.map((s) => {
                const count = st.elements.filter((e) => e.scenes.includes(s.id)).length;
                return (
                  <button key={s.id} onClick={() => setSceneId(s.id)}
                    className="w-full text-left px-3 py-2 flex items-center gap-2 hover:opacity-80"
                    style={{ borderBottom: `1px solid ${C.line}`, background: sceneId === s.id ? C.raised : "transparent" }}>
                    <span className="rounded-sm flex-shrink-0" style={{ width: 8, height: 8, background: stripStyle(s).bg }} />
                    <span className="text-xs font-bold flex-shrink-0" style={{ color: C.ink, fontFamily: MONO, minWidth: 18 }}>{s.no}</span>
                    <span className="text-xs truncate flex-1" style={{ color: C.muted, fontFamily: MONO }}>{s.set}</span>
                    <span className="text-xs flex-shrink-0" style={{ color: count ? C.amber : C.faint, fontFamily: MONO }}>{count}</span>
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel className="lg:col-span-3">
            {scene ? <>
              <PanelHead title={`Scene ${scene.no} — ${scene.intExt}. ${scene.set}`}
                sub={`${scene.dn} · ${eighths(scene.eighths)} pages · story day ${scene.storyDay} · ${scene.synopsis}`} />
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                {CATEGORIES.map((cat) => {
                  const els = st.elements.filter((e) => e.cat === cat.id && e.scenes.includes(scene.id));
                  return (
                    <div key={cat.id} className="rounded" style={{ background: C.board, border: `1px solid ${C.line}` }}>
                      <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderBottom: `1px solid ${C.line}` }}>
                        <span className="rounded-full" style={{ width: 7, height: 7, background: cat.color }} />
                        <span className="text-xs font-semibold flex-1" style={{ color: C.muted, fontFamily: SANS }}>{cat.name}</span>
                        <button onClick={() => setAdding(cat.id)} style={{ color: C.faint }} className="hover:opacity-70"><Plus size={13} /></button>
                      </div>
                      <div>
                        {els.length ? els.map((e) => (
                          <div key={e.id} className="group flex items-center gap-2 px-2.5 py-1.5">
                            <span className="text-xs flex-1 truncate" style={{ color: C.ink, fontFamily: SANS }}>{e.name}</span>
                            {e.scenes.length > 1 && (
                              <span className="text-xs" style={{ color: C.faint, fontFamily: MONO }} title={`Used in ${e.scenes.length} scenes`}>×{e.scenes.length}</span>
                            )}
                            <select value={e.status} onChange={(ev) => setStatus(e.id, ev.target.value)}
                              className="text-xs rounded px-1 py-0.5 outline-none"
                              style={{ background: "transparent", color: e.status === "Ready" ? C.go : e.status === "Ordered" ? C.cool : C.amber, border: `1px solid ${C.line}`, fontFamily: SANS }}>
                              {["To source", "Ordered", "Received", "Ready", "Returned"].map((s) => <option key={s} style={{ background: C.panel }}>{s}</option>)}
                            </select>
                            <button onClick={() => untag(e.id)} className="opacity-0 group-hover:opacity-60" style={{ color: C.stop }}><X size={12} /></button>
                          </div>
                        )) : <div className="px-2.5 py-2 text-xs" style={{ color: C.faint, fontFamily: SANS }}>—</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </> : <Empty icon={Tag} title="Select a scene." />}
          </Panel>
        </div>
      ) : (
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                  {["Category", "Element", "Dept", "Status", "Scenes", "Estimate", "Actual", "Vendor"].map((h) => (
                    <th key={h} className="text-left px-3 py-2 font-medium uppercase"
                      style={{ color: C.faint, fontFamily: SANS, fontSize: 11, letterSpacing: "0.06em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CATEGORIES.flatMap((cat) => st.elements.filter((e) => e.cat === cat.id)).map((e) => (
                  <tr key={e.id} style={{ borderBottom: `1px solid ${C.line}` }}>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5" style={{ color: C.muted, fontFamily: SANS }}>
                        <span className="rounded-full" style={{ width: 6, height: 6, background: catById(e.cat).color }} />
                        {catById(e.cat).name}
                      </span>
                    </td>
                    <td className="px-3 py-2" style={{ color: C.ink, fontFamily: SANS }}>{e.name}</td>
                    <td className="px-3 py-2" style={{ color: C.muted, fontFamily: SANS }}>{e.dept}</td>
                    <td className="px-3 py-2">
                      <Pill tone={e.status === "Ready" ? "go" : e.status === "Ordered" ? "cool" : "amber"}>{e.status}</Pill>
                    </td>
                    <td className="px-3 py-2" style={{ color: C.muted, fontFamily: MONO }}>
                      {e.scenes.map((s) => sceneById(st, s)?.no).filter(Boolean).join(" ")}
                    </td>
                    <td className="px-3 py-2 text-right" style={{ color: C.ink, fontFamily: MONO }}>{money(e.est)}</td>
                    <td className="px-3 py-2 text-right" style={{ color: e.actual ? C.go : C.faint, fontFamily: MONO }}>{e.actual ? money(e.actual) : "—"}</td>
                    <td className="px-3 py-2" style={{ color: C.muted, fontFamily: SANS }}>{e.vendor || "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `1px solid ${C.line}` }}>
                  <td colSpan={5} className="px-3 py-2 text-right uppercase" style={{ color: C.faint, fontFamily: SANS, fontSize: 11, letterSpacing: "0.06em" }}>Total</td>
                  <td className="px-3 py-2 text-right font-bold" style={{ color: C.amber, fontFamily: MONO }}>{money(st.elements.reduce((a, e) => a + e.est, 0))}</td>
                  <td className="px-3 py-2 text-right font-bold" style={{ color: C.go, fontFamily: MONO }}>{money(st.elements.reduce((a, e) => a + e.actual, 0))}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      )}

      {adding && <AddElementModal st={st} cat={adding} sceneId={sceneId} onTag={tag} onClose={() => setAdding(null)} />}
    </div>
  );
}

function AddElementModal({ st, cat, sceneId, onTag, onClose }) {
  const [name, setName] = useState("");
  const category = catById(cat);
  const reusable = st.elements.filter((e) => e.cat === cat && !e.scenes.includes(sceneId));
  return (
    <Modal title={`Tag ${category.name.toLowerCase()}`} sub={`Scene ${sceneById(st, sceneId)?.no} · ${sceneById(st, sceneId)?.set}`} onClose={onClose}>
      <div className="space-y-4">
        {reusable.length > 0 && (
          <div>
            <div className="text-xs uppercase mb-1.5" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>
              Already on this production
            </div>
            <div className="rounded overflow-y-auto" style={{ border: `1px solid ${C.line}`, maxHeight: 180 }}>
              {reusable.map((e) => (
                <button key={e.id} onClick={() => onTag(cat, e.name, e.id)}
                  className="w-full text-left flex items-center gap-2 px-3 py-2 hover:opacity-75"
                  style={{ borderBottom: `1px solid ${C.line}` }}>
                  <span className="text-xs flex-1" style={{ color: C.ink, fontFamily: SANS }}>{e.name}</span>
                  <span className="text-xs" style={{ color: C.faint, fontFamily: MONO }}>in {e.scenes.length} sc</span>
                  <Plus size={12} style={{ color: C.amber }} />
                </button>
              ))}
            </div>
            <div className="text-xs mt-1.5" style={{ color: C.faint, fontFamily: SANS }}>
              Reusing keeps one cost and one status across every scene it appears in.
            </div>
          </div>
        )}
        <Field label="Or add something new">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`New ${category.name.toLowerCase()}`}
              onKeyDown={(e) => e.key === "Enter" && name.trim() && onTag(cat, name.trim())} />
            <Btn variant="primary" icon={Plus} onClick={() => name.trim() && onTag(cat, name.trim())} disabled={!name.trim()}>Tag</Btn>
          </div>
        </Field>
      </div>
    </Modal>
  );
}
/* ═══════════════════════════════════════════════════════════════════════════
   4 · SCHEDULE — the stripboard
   ═══════════════════════════════════════════════════════════════════════════ */

function Schedule({ st, mutate }) {
  const [view, setView] = useState("board");
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const al = useMemo(() => alerts(st), [st]);
  const unsch = unscheduledScenes(st);

  const move = (sceneId, target) => {
    const toDayId = target === "pool" ? null : target;
    mutate("moveScene", {
      sceneId, toDayId,
      sceneNo: sceneById(st, sceneId)?.no,
      toDayN: toDayId ? st.days.find((d) => d.id === toDayId)?.n : null,
    });
  };

  const patchDay = (dayId, patch, detail) => mutate("updateDay", { dayId, dayN: st.days.find((d) => d.id === dayId)?.n, ...patch, detail });

  const addDay = () => {
    const last = st.days[st.days.length - 1];
    const d = new Date((last?.date || st.production.shootStart) + "T00:00:00");
    d.setDate(d.getDate() + 1);
    mutate("addDay", { date: d.toISOString().slice(0, 10), locId: st.locations[0]?.id, call: "06:00", shootCall: "07:00", wrap: "19:00" });
  };

  const exportOneLiner = () => download("one-liner-schedule.csv", toCSV([
    ["Day", "Date", "Unit", "Location", "Scene", "I/E", "Set", "D/N", "Pages", "Cast", "Synopsis"],
    ...st.days.flatMap((d) => dayScenes(st, d).map((s) => [
      d.n, d.date, d.unit, locById(st, d.locId)?.name || "", s.no, s.intExt, s.set, s.dn,
      eighths(s.eighths), s.cast.map((c) => charById(st, c)?.name).join(" / "), s.synopsis,
    ])),
  ]));

  const DropZone = ({ dayId, children, className = "", style = {} }) => (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(dayId); }}
      onDragLeave={() => setOver((o) => (o === dayId ? null : o))}
      onDrop={(e) => { e.preventDefault(); if (drag) move(drag, dayId); setDrag(null); setOver(null); }}
      className={className}
      style={{ ...style, outline: over === dayId ? `2px dashed ${C.amber}` : "none", outlineOffset: -2 }}>
      {children}
    </div>
  );

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHead icon={CalendarDays} title="Stripboard"
          sub={`${st.days.length} shooting days · ${st.scenes.length - unsch.length} of ${st.scenes.length} scenes placed · drag strips between days`}
          right={<>
            <Btn size="sm" variant={view === "board" ? "solid" : "bare"} onClick={() => setView("board")}>Board</Btn>
            <Btn size="sm" variant={view === "dood" ? "solid" : "bare"} onClick={() => setView("dood")}>Day out of days</Btn>
            <Btn size="sm" icon={Download} onClick={exportOneLiner}>One-liner</Btn>
            <Btn size="sm" variant="primary" icon={Plus} onClick={addDay}>Add day</Btn>
          </>} />
        <div className="flex flex-wrap items-center gap-4 px-4 py-2.5" style={{ borderTop: `1px solid ${C.line}` }}>
          {Object.entries(STRIP).map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1.5 text-xs" style={{ color: C.faint, fontFamily: SANS }}>
              <span className="rounded-sm" style={{ width: 14, height: 9, background: v.bg }} />{v.label}
            </span>
          ))}
        </div>
      </Panel>

      {view === "board" ? (
        <div className="flex gap-3 overflow-x-auto pb-3" style={{ minHeight: 420 }}>
          {/* Unscheduled pool */}
          <DropZone dayId="pool" className="rounded-lg flex-shrink-0" style={{ width: 300, background: C.panel, border: `1px dashed ${C.line}` }}>
            <div className="px-3 py-2.5" style={{ borderBottom: `1px solid ${C.line}` }}>
              <div className="text-xs font-semibold uppercase" style={{ color: C.muted, fontFamily: SANS, letterSpacing: "0.08em" }}>Not on the board</div>
              <div className="text-xs mt-0.5" style={{ color: C.faint, fontFamily: MONO }}>
                {unsch.length} scenes · {eighths(sumEighths(unsch))} pages
              </div>
            </div>
            <div className="p-2 space-y-1 overflow-y-auto" style={{ maxHeight: 460 }}>
              {unsch.length ? unsch.map((s) => (
                <Strip key={s.id} scene={s} st={st} compact onDragStart={() => setDrag(s.id)} />
              )) : (
                <div className="px-2 py-8 text-center text-xs" style={{ color: C.faint, fontFamily: SANS }}>
                  Every scene is scheduled. Drop a strip here to pull it off the board.
                </div>
              )}
            </div>
          </DropZone>

          {/* Day columns */}
          {st.days.map((day) => {
            const t = dayTotals(st, day);
            const dayAlerts = al.filter((a) => a.day === day.n);
            const over12 = t.hours > st.production.dayLengthHours + 0.5;
            const isToday = day.id === st.production.currentDayId;
            return (
              <DropZone key={day.id} dayId={day.id} className="rounded-lg flex-shrink-0"
                style={{ width: 320, background: C.panel, border: `1px solid ${isToday ? C.amber + "77" : C.line}` }}>
                <div className="px-3 py-2.5" style={{ borderBottom: `1px solid ${C.line}` }}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold" style={{ color: isToday ? C.amber : C.ink, fontFamily: MONO }}>DAY {day.n}</span>
                      {isToday && <Pill tone="amber">Shooting</Pill>}
                      {day.status === "Completed" && <Pill tone="go">Wrapped</Pill>}
                    </div>
                    <span className="text-xs" style={{ color: C.faint, fontFamily: MONO }}>
                      {weekday(day.date).slice(0, 3)} {fmtDate(day.date, { day: "2-digit", month: "short" })}
                    </span>
                  </div>
                  <select value={day.locId || ""} onChange={(e) => patchDay(day.id, { locId: e.target.value },
                    `Now ${locById(st, e.target.value)?.name}`)}
                    className="w-full text-xs rounded px-1.5 py-1 outline-none mb-1.5"
                    style={{ background: C.board, color: C.muted, border: `1px solid ${C.line}`, fontFamily: SANS }}>
                    {st.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                  <div className="flex items-center gap-3 text-xs" style={{ fontFamily: MONO }}>
                    <span style={{ color: C.faint }}>{t.scenes} sc</span>
                    <span style={{ color: C.ink, fontWeight: 600 }}>{eighths(t.eighths)} pp</span>
                    <span style={{ color: C.faint }}>{t.cast} cast</span>
                    <span style={{ color: over12 ? C.stop : C.faint, marginLeft: "auto" }}>{t.hours.toFixed(1)}h</span>
                  </div>
                </div>

                <div className="p-2 space-y-1 overflow-y-auto" style={{ minHeight: 120, maxHeight: 340 }}>
                  {dayScenes(st, day).map((s) => (
                    <Strip key={s.id} scene={s} st={st} onDragStart={() => setDrag(s.id)} onRemove={() => move(s.id, "pool")} />
                  ))}
                  {!day.strips.length && (
                    <div className="py-8 text-center text-xs" style={{ color: C.faint, fontFamily: SANS }}>Drop strips here</div>
                  )}
                </div>

                {dayAlerts.length > 0 && (
                  <div className="px-3 py-2 space-y-1" style={{ borderTop: `1px solid ${C.line}` }}>
                    {dayAlerts.slice(0, 3).map((a, i) => (
                      <div key={i} className="flex items-start gap-1.5">
                        <span className="rounded-full flex-shrink-0" style={{ width: 5, height: 5, background: SEV[a.sev].c, marginTop: 5 }} />
                        <span className="text-xs leading-snug" style={{ color: C.faint, fontFamily: SANS }}>{a.msg}</span>
                      </div>
                    ))}
                  </div>
                )}
              </DropZone>
            );
          })}
        </div>
      ) : (
        <DOOD st={st} />
      )}
    </div>
  );
}

function DOOD({ st }) {
  const rows = useMemo(() => dood(st), [st]);
  const days = [...st.days].sort((a, b) => a.n - b.n);
  const markColor = (m) => m === "H" ? C.stop : m ? C.go : C.faint;

  const exportDOOD = () => download("day-out-of-days.csv", toCSV([
    ["Character", "Actor", ...days.map((d) => `Day ${d.n}`), "Work", "Hold", "Total"],
    ...rows.map((r) => [r.ch.name, personById(st, r.ch.castId)?.name || "Not cast", ...r.marks, r.work, r.hold, r.total]),
  ]));

  return (
    <Panel>
      <PanelHead icon={Users} title="Day out of days"
        sub="S start · W work · H hold · F finish. Hold days are paid and are the cheapest thing to schedule away."
        right={<Btn size="sm" icon={Download} onClick={exportDOOD}>Export</Btn>} />
      <div className="overflow-x-auto">
        <table className="text-xs" style={{ fontFamily: MONO, minWidth: "100%" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.line}` }}>
              <th className="text-left px-3 py-2 sticky left-0" style={{ color: C.faint, background: C.panel, minWidth: 150 }}>Character</th>
              {days.map((d) => (
                <th key={d.id} className="px-1.5 py-2 text-center" style={{ color: C.faint, minWidth: 34 }}>{d.n}</th>
              ))}
              {["W", "H", "Total"].map((h) => <th key={h} className="px-2 py-2 text-center" style={{ color: C.faint }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ch.id} style={{ borderBottom: `1px solid ${C.line}` }}>
                <td className="px-3 py-2 sticky left-0" style={{ background: C.panel }}>
                  <div style={{ color: C.ink, fontWeight: 600 }}>{r.ch.name}{r.ch.minor && <span style={{ color: C.amber }}> ▪</span>}</div>
                  <div style={{ color: C.faint, fontFamily: SANS, fontSize: 11 }}>{personById(st, r.ch.castId)?.name || "Not cast"}</div>
                </td>
                {r.marks.map((m, i) => (
                  <td key={i} className="px-1.5 py-2 text-center font-bold" style={{ color: markColor(m), background: m === "H" ? `${C.stop}12` : "transparent" }}>{m}</td>
                ))}
                <td className="px-2 py-2 text-center" style={{ color: C.ink }}>{r.work}</td>
                <td className="px-2 py-2 text-center" style={{ color: r.hold ? C.stop : C.faint }}>{r.hold}</td>
                <td className="px-2 py-2 text-center" style={{ color: C.ink, fontWeight: 600 }}>{r.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-3 text-xs" style={{ borderTop: `1px solid ${C.line}`, color: C.faint, fontFamily: SANS }}>
        {rows.reduce((a, r) => a + r.hold, 0)} paid hold days across the cast. Every one is a day an actor is contracted and not shooting.
      </div>
    </Panel>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   5 · CALL SHEET
   ═══════════════════════════════════════════════════════════════════════════ */

function CallSheetModule({ st, mutate }) {
  const [dayId, setDayId] = useState(st.production.currentDayId || st.days[0]?.id);
  const day = st.days.find((d) => d.id === dayId);
  const cs = st.callSheets[dayId];
  const [draft, setDraft] = useState({ notes: cs?.notes || "", safety: cs?.safety || "" });

  useEffect(() => {
    const c = st.callSheets[dayId];
    setDraft({ notes: c?.notes || "", safety: c?.safety || "" });
  }, [dayId]);

  if (!day) return <Empty icon={ClipboardList} title="No shooting days yet." />;

  const loc = locById(st, day.locId);
  const scenes = dayScenes(st, day);
  const t = dayTotals(st, day);
  const sun = loc ? sunTimes(loc.lat, day.date) : { rise: "—", set: "—" };
  const castOnDay = [...new Set(scenes.flatMap((s) => s.cast))].map((id) => charById(st, id)).filter(Boolean);
  const crewOnDay = st.people.filter((p) => p.type === "crew");
  const dayAlerts = alerts(st).filter((a) => a.day === day.n && a.sev !== "info");

  const publish = () => mutate("publishCallSheet", { dayId, dayN: day.n, notes: draft.notes, safety: draft.safety });

  const ackAll = () => mutate("ackAllCallSheet", { dayId });

  // Cast call times work backwards from the shooting call.
  const castCall = (i) => {
    const [h, m] = day.shootCall.split(":").map(Number);
    const mins = h * 60 + m - 90 - i * 15;
    const hh = Math.floor(((mins % 1440) + 1440) % 1440 / 60), mm = ((mins % 60) + 60) % 60;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHead icon={ClipboardList} title="Call sheet"
          sub={cs ? `Revision ${cs.version} published ${new Date(cs.publishedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · ${cs.ack.length} of ${st.people.length} acknowledged` : "Not published for this day"}
          right={<>
            <select value={dayId} onChange={(e) => setDayId(e.target.value)}
              className="text-xs rounded px-2 py-1 outline-none"
              style={{ background: C.board, color: C.ink, border: `1px solid ${C.line}`, fontFamily: SANS }}>
              {st.days.map((d) => <option key={d.id} value={d.id}>Day {d.n} — {fmtDate(d.date, { day: "2-digit", month: "short" })}</option>)}
            </select>
            <Btn size="sm" icon={Printer} onClick={() => window.print()}>Print</Btn>
            <Btn size="sm" variant="primary" icon={Send} onClick={publish}>
              {cs ? `Publish Rev ${cs.version + 1}` : "Publish"}
            </Btn>
          </>} />
        {dayAlerts.length > 0 && (
          <div className="px-4 py-2.5 flex items-start gap-2" style={{ background: `${C.amber}0F`, borderTop: `1px solid ${C.line}` }}>
            <AlertTriangle size={14} style={{ color: C.amber, flexShrink: 0, marginTop: 1 }} />
            <div className="text-xs" style={{ color: C.muted, fontFamily: SANS }}>
              {dayAlerts.length} unresolved item{dayAlerts.length > 1 ? "s" : ""} on this day. You can still publish — the override is recorded against your name.
            </div>
          </div>
        )}
      </Panel>

      {/* The sheet itself — deliberately dense, the way a call sheet is */}
      <Panel>
        <div className="p-5" style={{ fontFamily: MONO }}>
          <div className="flex flex-wrap items-start justify-between gap-4 pb-3" style={{ borderBottom: `2px solid ${C.line}` }}>
            <div>
              <div className="text-lg font-bold" style={{ color: C.ink }}>{st.production.title.toUpperCase()}</div>
              <div className="text-xs mt-0.5" style={{ color: C.faint }}>{st.production.company} · {st.production.format} · {st.production.languages}</div>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold" style={{ color: C.amber }}>DAY {day.n} OF {st.production.plannedDays}</div>
              <div className="text-xs" style={{ color: C.muted }}>{weekday(day.date).toUpperCase()} · {fmtDate(day.date)}</div>
              {cs && <div className="text-xs mt-0.5" style={{ color: C.faint }}>REV {cs.version}</div>}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 py-3" style={{ borderBottom: `1px solid ${C.line}` }}>
            {[["UNIT CALL", day.call], ["SHOOTING CALL", day.shootCall], ["EST. WRAP", day.wrap], ["UNIT", day.unit],
              ["SUNRISE", sun.rise], ["SUNSET", sun.set], ["PAGES", eighths(t.eighths)], ["SCENES", String(t.scenes)]].map(([l, v]) => (
              <div key={l}>
                <div className="text-xs" style={{ color: C.faint, letterSpacing: "0.06em" }}>{l}</div>
                <div className="text-sm font-bold" style={{ color: C.ink }}>{v}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 py-3" style={{ borderBottom: `1px solid ${C.line}` }}>
            <div className="md:col-span-2">
              <div className="text-xs mb-1" style={{ color: C.faint, letterSpacing: "0.06em" }}>LOCATION</div>
              <div className="text-sm font-bold" style={{ color: C.ink }}>{loc?.name}</div>
              <div className="text-xs mt-0.5" style={{ color: C.muted }}>{loc?.address}</div>
              <div className="text-xs mt-1" style={{ color: C.muted }}>{loc?.contact} · {loc?.phone}</div>
              {loc?.notes && <div className="text-xs mt-1.5" style={{ color: C.faint }}>{loc.notes}</div>}
            </div>
            <div>
              <div className="text-xs mb-1" style={{ color: C.stop, letterSpacing: "0.06em" }}>NEAREST HOSPITAL</div>
              <div className="text-sm" style={{ color: C.ink }}>{loc?.hospital}</div>
              <div className="text-xs mt-2" style={{ color: C.faint, letterSpacing: "0.06em" }}>WEATHER</div>
              <div className="text-xs flex items-center gap-1.5 mt-0.5" style={{ color: C.muted }}>
                <CloudSun size={13} /> 28°C / 19°C · light cloud · rain 20%
              </div>
            </div>
          </div>

          {/* Scenes */}
          <div className="py-3" style={{ borderBottom: `1px solid ${C.line}` }}>
            <div className="text-xs mb-2" style={{ color: C.faint, letterSpacing: "0.06em" }}>SCENES</div>
            <div className="space-y-1">
              {scenes.map((s) => (
                <div key={s.id}>
                  <Strip scene={s} st={st} />
                  <div className="text-xs pl-3 pt-1 pb-1.5" style={{ color: C.faint }}>{s.synopsis}</div>
                </div>
              ))}
              {!scenes.length && <div className="text-xs" style={{ color: C.faint }}>No scenes on this day.</div>}
            </div>
          </div>

          {/* Cast */}
          <div className="py-3" style={{ borderBottom: `1px solid ${C.line}` }}>
            <div className="text-xs mb-2" style={{ color: C.faint, letterSpacing: "0.06em" }}>CAST</div>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ color: C.faint }}>
                  {["#", "Character", "Artist", "Pickup", "Makeup", "On set", "Scenes"].map((h) => (
                    <th key={h} className="text-left pb-1 font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {castOnDay.map((ch, i) => {
                  const p = personById(st, ch.castId);
                  const scs = scenes.filter((s) => s.cast.includes(ch.id)).map((s) => s.no).join(", ");
                  return (
                    <tr key={ch.id} style={{ color: C.ink }}>
                      <td className="py-1" style={{ color: C.faint }}>{i + 1}</td>
                      <td className="py-1 font-bold">{ch.name}{ch.minor && <span style={{ color: C.amber }}> ▪ minor</span>}</td>
                      <td className="py-1" style={{ color: C.muted }}>{p?.name || "Not cast"}</td>
                      <td className="py-1">{castCall(i + 2)}</td>
                      <td className="py-1">{castCall(i + 1)}</td>
                      <td className="py-1 font-bold" style={{ color: C.amber }}>{castCall(0)}</td>
                      <td className="py-1" style={{ color: C.muted }}>{scs}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Elements needed */}
          <div className="py-3" style={{ borderBottom: `1px solid ${C.line}` }}>
            <div className="text-xs mb-2" style={{ color: C.faint, letterSpacing: "0.06em" }}>REQUIREMENTS FROM BREAKDOWN</div>
            <div className="flex flex-wrap gap-1.5">
              {st.elements.filter((e) => e.scenes.some((s) => day.strips.includes(s))).map((e) => (
                <span key={e.id} className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs"
                  style={{ background: C.board, border: `1px solid ${e.status === "Ready" ? C.line : C.amber + "66"}`, color: e.status === "Ready" ? C.muted : C.amber }}>
                  <span className="rounded-full" style={{ width: 5, height: 5, background: catById(e.cat).color }} />
                  {e.name}{e.status !== "Ready" && ` — ${e.status.toLowerCase()}`}
                </span>
              ))}
            </div>
          </div>

          {/* Notes and safety */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-3">
            <Field label="Production notes">
              <TextArea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                placeholder="Anything the unit needs to know before tomorrow." style={{ fontFamily: MONO, fontSize: 12 }} />
            </Field>
            <Field label="Safety notes">
              <TextArea value={draft.safety} onChange={(e) => setDraft({ ...draft, safety: e.target.value })}
                placeholder="Hazards, cordons, marshals, specific risks on this location." style={{ fontFamily: MONO, fontSize: 12, borderColor: C.stop + "55" }} />
            </Field>
          </div>
        </div>
      </Panel>

      {/* Distribution */}
      <Panel>
        <PanelHead icon={Send} title="Distribution"
          sub={cs ? `Revision ${cs.version} · ${cs.ack.length} of ${st.people.length} acknowledged` : "Publish to distribute"}
          right={cs && <Btn size="sm" variant="go" icon={Check} onClick={ackAll}>Mark all acknowledged</Btn>} />
        {cs ? (
          <div className="p-4">
            <Bar pct={(cs.ack.length / st.people.length) * 100} tone={C.go} h={6} />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1.5 mt-4">
              {st.people.map((p) => {
                const done = cs.ack.includes(p.id);
                return (
                  <div key={p.id} className="flex items-center gap-2 text-xs">
                    {done ? <CheckCircle2 size={12} style={{ color: C.go, flexShrink: 0 }} />
                          : <Circle size={12} style={{ color: C.faint, flexShrink: 0 }} />}
                    <span className="truncate" style={{ color: done ? C.muted : C.faint, fontFamily: SANS }}>{p.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : <Empty icon={Send} title="Publish the call sheet to send it and start collecting read receipts." />}
      </Panel>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   6 · DAILY PRODUCTION REPORT
   ═══════════════════════════════════════════════════════════════════════════ */

const DELAY_REASONS = ["Weather", "Talent", "Technical", "Location", "Permission", "Medical", "Other"];

function DPRModule({ st, mutate }) {
  const [dayId, setDayId] = useState(st.production.currentDayId || st.days[0]?.id);
  const day = st.days.find((d) => d.id === dayId);
  const existing = st.dprs[dayId];
  const blank = { dayId, done: [], part: [], eighthsShot: 0, setups: 0, firstShot: "", lunch: "", wrap: "", delays: [], incidents: [], approved: false };
  const [d, setD] = useState(existing || blank);
  const [delay, setDelay] = useState({ reason: "Weather", mins: "", note: "" });

  useEffect(() => { setD(st.dprs[dayId] || { ...blank, dayId }); }, [dayId, st.dprs]);

  if (!day) return <Empty icon={ClipboardList} title="No shooting days yet." />;

  const scenes = dayScenes(st, day);
  const planned = dayTotals(st, day);
  const pr = progress(st);
  const locked = existing?.approved;

  const toggle = (id, key) => {
    if (locked) return;
    const other = key === "done" ? "part" : "done";
    setD((p) => ({
      ...p,
      [key]: p[key].includes(id) ? p[key].filter((x) => x !== id) : [...p[key], id],
      [other]: p[other].filter((x) => x !== id),
    }));
  };

  // Pages shot follows from which scenes were completed, unless overridden.
  const computedEighths = scenes.filter((s) => d.done.includes(s.id)).reduce((a, s) => a + s.eighths, 0)
    + scenes.filter((s) => d.part.includes(s.id)).reduce((a, s) => a + Math.round(s.eighths / 2), 0);

  const save = async (approve) => {
    await mutate("saveDPR", {
      dayId, dayN: day.n, plannedEighths: planned.eighths,
      eighthsShot: Number(d.eighthsShot) || computedEighths, setups: Number(d.setups) || 0,
      firstShot: d.firstShot, lunch: d.lunch, wrap: d.wrap,
      done: d.done, part: d.part, delays: d.delays, incidents: d.incidents,
    });
    if (approve) await mutate("approveDPR", { dayId });
  };

  const addDelay = () => {
    if (!delay.mins) return;
    setD((p) => ({ ...p, delays: [...p.delays, { ...delay, mins: Number(delay.mins) }] }));
    setDelay({ reason: "Weather", mins: "", note: "" });
  };

  const variance = (Number(d.eighthsShot) || computedEighths) - planned.eighths;

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHead icon={ClipboardList} title="Daily production report"
          sub={`Day ${day.n} · ${weekday(day.date)} ${fmtDate(day.date)} · ${locById(st, day.locId)?.name}`}
          right={<>
            <select value={dayId} onChange={(e) => setDayId(e.target.value)}
              className="text-xs rounded px-2 py-1 outline-none"
              style={{ background: C.board, color: C.ink, border: `1px solid ${C.line}`, fontFamily: SANS }}>
              {st.days.map((x) => <option key={x.id} value={x.id}>Day {x.n} — {x.status}</option>)}
            </select>
            {!locked && <Btn size="sm" onClick={() => save(false)}>Save draft</Btn>}
            {!locked
              ? <Btn size="sm" variant="primary" icon={Lock} onClick={() => save(true)}>Approve &amp; lock</Btn>
              : <Pill tone="go"><Lock size={11} /> Approved by {existing.approvedBy}</Pill>}
          </>} />
        {locked && (
          <div className="px-4 py-2.5 text-xs" style={{ borderTop: `1px solid ${C.line}`, color: C.faint, fontFamily: SANS }}>
            This report is locked. Corrections are issued as a revision, never as a silent edit.
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Panel><Stat label="Planned today" value={eighths(planned.eighths)} sub={`${planned.scenes} scenes`} /></Panel>
        <Panel><Stat label="Shot today" value={eighths(Number(d.eighthsShot) || computedEighths)}
          tone={variance < 0 ? C.stop : variance > 0 ? C.go : C.ink} sub={`${d.done.length} completed · ${d.part.length} part`} /></Panel>
        <Panel><Stat label="Day variance" value={`${variance >= 0 ? "+" : "−"}${eighths(Math.abs(variance))}`}
          tone={variance < 0 ? C.stop : C.go} sub="pages against plan" /></Panel>
        <Panel><Stat label="Cumulative" value={`${pr.daysVariance >= 0 ? "+" : ""}${pr.daysVariance.toFixed(1)}d`}
          tone={pr.daysVariance < -0.15 ? C.stop : C.go} sub={`${pr.daysShot} days wrapped`} /></Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel>
          <PanelHead title="Scenes" sub="Mark what actually got shot. Part-shot scenes return to the board." />
          <div className="p-3 space-y-1.5">
            {scenes.map((s) => {
              const isDone = d.done.includes(s.id), isPart = d.part.includes(s.id);
              return (
                <div key={s.id} className="flex items-center gap-2">
                  <div className="flex-1"><Strip scene={s} st={st} compact dim={!isDone && !isPart} /></div>
                  <Btn size="sm" variant={isDone ? "go" : "bare"} onClick={() => toggle(s.id, "done")} disabled={locked}>Shot</Btn>
                  <Btn size="sm" variant={isPart ? "solid" : "bare"} onClick={() => toggle(s.id, "part")} disabled={locked}>Part</Btn>
                </div>
              );
            })}
            {!scenes.length && <Empty icon={Film} title="No scenes were scheduled on this day." />}
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel>
            <PanelHead title="The day" />
            <div className="p-4 grid grid-cols-2 gap-3">
              <Field label="First shot"><Input type="time" value={d.firstShot} disabled={locked} onChange={(e) => setD({ ...d, firstShot: e.target.value })} /></Field>
              <Field label="Lunch"><Input type="time" value={d.lunch} disabled={locked} onChange={(e) => setD({ ...d, lunch: e.target.value })} /></Field>
              <Field label="Wrap"><Input type="time" value={d.wrap} disabled={locked} onChange={(e) => setD({ ...d, wrap: e.target.value })} /></Field>
              <Field label="Setups"><Input type="number" value={d.setups} disabled={locked} onChange={(e) => setD({ ...d, setups: e.target.value })} /></Field>
              <div className="col-span-2">
                <Field label="Pages shot (eighths)" hint={`Computed from scenes: ${eighths(computedEighths)}. Override only if the script supervisor's count differs.`}>
                  <Input type="number" value={d.eighthsShot || computedEighths} disabled={locked}
                    onChange={(e) => setD({ ...d, eighthsShot: e.target.value })} />
                </Field>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHead title="Delays" sub={`${d.delays.reduce((a, x) => a + x.mins, 0)} minutes lost today`} />
            <div className="p-3">
              {d.delays.map((x, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded mb-1.5" style={{ background: C.board }}>
                  <Pill tone="amber">{x.reason}</Pill>
                  <span className="text-xs font-bold" style={{ color: C.stop, fontFamily: MONO }}>{x.mins}m</span>
                  <span className="text-xs flex-1 truncate" style={{ color: C.muted, fontFamily: SANS }}>{x.note}</span>
                  {!locked && <button onClick={() => setD({ ...d, delays: d.delays.filter((_, j) => j !== i) })}
                    style={{ color: C.faint }}><X size={12} /></button>}
                </div>
              ))}
              {!locked && (
                <div className="flex gap-2 mt-2">
                  <Select value={delay.reason} onChange={(e) => setDelay({ ...delay, reason: e.target.value })} className="flex-shrink-0" >
                    {DELAY_REASONS.map((r) => <option key={r}>{r}</option>)}
                  </Select>
                  <Input type="number" placeholder="Min" value={delay.mins} onChange={(e) => setDelay({ ...delay, mins: e.target.value })} style={{ width: 70 }} />
                  <Input placeholder="What happened" value={delay.note} onChange={(e) => setDelay({ ...delay, note: e.target.value })} />
                  <Btn variant="solid" icon={Plus} onClick={addDelay}>Add</Btn>
                </div>
              )}
              {!d.delays.length && locked && <div className="px-2 py-3 text-xs" style={{ color: C.faint, fontFamily: SANS }}>No delays logged.</div>}
            </div>
          </Panel>
        </div>
      </div>

      {/* Shooting log */}
      <Panel>
        <PanelHead icon={Clock} title="Production log" sub="Every approved day, cumulative" />
        <div className="overflow-x-auto">
          <table className="w-full text-xs" style={{ fontFamily: MONO }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                {["Day", "Date", "Location", "Planned", "Shot", "Var", "Setups", "First shot", "Wrap", "Delays", "Status"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 font-medium uppercase" style={{ color: C.faint, fontFamily: SANS, fontSize: 11, letterSpacing: "0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {st.days.map((x) => {
                const r = st.dprs[x.id];
                const plan = r?.plannedEighths ?? dayTotals(st, x).eighths;
                const v = r ? r.eighthsShot - plan : null;
                return (
                  <tr key={x.id} style={{ borderBottom: `1px solid ${C.line}`, opacity: r ? 1 : 0.5 }}>
                    <td className="px-3 py-2 font-bold" style={{ color: C.ink }}>{x.n}</td>
                    <td className="px-3 py-2" style={{ color: C.muted }}>{fmtDate(x.date, { day: "2-digit", month: "short" })}</td>
                    <td className="px-3 py-2 truncate" style={{ color: C.muted, maxWidth: 160 }}>{locById(st, x.locId)?.name}</td>
                    <td className="px-3 py-2" style={{ color: C.muted }}>{eighths(plan)}</td>
                    <td className="px-3 py-2" style={{ color: C.ink }}>{r ? eighths(r.eighthsShot) : "—"}</td>
                    <td className="px-3 py-2 font-bold" style={{ color: v == null ? C.faint : v < 0 ? C.stop : C.go }}>
                      {v == null ? "—" : `${v >= 0 ? "+" : "−"}${eighths(Math.abs(v))}`}
                    </td>
                    <td className="px-3 py-2" style={{ color: C.muted }}>{r?.setups || "—"}</td>
                    <td className="px-3 py-2" style={{ color: C.muted }}>{r?.firstShot || "—"}</td>
                    <td className="px-3 py-2" style={{ color: C.muted }}>{r?.wrap || "—"}</td>
                    <td className="px-3 py-2" style={{ color: r?.delays.length ? C.amber : C.faint }}>
                      {r?.delays.length ? `${r.delays.reduce((a, y) => a + y.mins, 0)}m` : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {r?.approved ? <Pill tone="go">Approved</Pill> : x.status === "Shooting" ? <Pill tone="amber">Shooting</Pill> : <Pill>Planned</Pill>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
/* ═══════════════════════════════════════════════════════════════════════════
   7 · BUDGET & COST REPORT
   ═══════════════════════════════════════════════════════════════════════════ */

function Budget({ st, mutate }) {
  const [open, setOpen] = useState({});
  const [adding, setAdding] = useState(false);
  const bt = useMemo(() => budgetTotals(st), [st]);

  const exportCost = () => download("cost-report.csv", toCSV([
    ["Code", "Account", "Category", "Approved budget", "Actual", "Committed", "Estimate at completion", "Available", "Variance %"],
    ...bt.rows.map((r) => [r.code, r.name, r.cat, Math.round(r.budget), Math.round(r.actual), Math.round(r.committed),
      Math.round(r.eac), Math.round(r.available), r.budget ? ((r.available / r.budget) * 100).toFixed(1) : "0"]),
    [], ["TOTAL", "", "", Math.round(bt.budget), Math.round(bt.actual), Math.round(bt.committed),
      Math.round(bt.actual + bt.committed), Math.round(bt.available), ""],
  ]));

  const catRows = (cat) => bt.rows.filter((r) => r.cat === cat);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Panel><Stat big label="Approved budget" value={money(bt.budget, true)} sub={`${st.accounts.length} accounts`} /></Panel>
        <Panel><Stat big label="Actual to date" value={money(bt.actual, true)} tone={C.amber}
          sub={`${bt.budget ? ((bt.actual / bt.budget) * 100).toFixed(1) : "0"}% of budget`} /></Panel>
        <Panel><Stat big label="Committed" value={money(bt.committed, true)} tone={C.cool}
          sub="Approved POs not yet invoiced" /></Panel>
        <Panel><Stat big label="Available" value={money(bt.available, true)} tone={bt.available < 0 ? C.stop : C.go}
          sub="Budget less actual less commitments" /></Panel>
      </div>

      <Panel>
        <PanelHead icon={Wallet} title="Cost report"
          sub="Budget · Actual · Committed · Estimate at completion · Variance. Commitments count the moment a purchase order is approved."
          right={<>
            <Btn size="sm" icon={Download} onClick={exportCost}>Export</Btn>
            <Btn size="sm" variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add account</Btn>
          </>} />
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                {["", "Code", "Account", "Budget", "Actual", "Committed", "EAC", "Available", ""].map((h, i) => (
                  <th key={i} className={`px-3 py-2 font-medium uppercase ${i >= 3 && i <= 7 ? "text-right" : "text-left"}`}
                    style={{ color: C.faint, fontFamily: SANS, fontSize: 11, letterSpacing: "0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {["ATL", "BTL", "POST", "OTHER"].map((cat) => {
                const c = bt.byCat.find((x) => x.cat === cat);
                const used = c.actual + c.committed;
                return (
                  <React.Fragment key={cat}>
                    <tr style={{ background: C.raised, borderBottom: `1px solid ${C.line}` }}>
                      <td />
                      <td className="px-3 py-2 font-bold uppercase" style={{ color: C.faint, fontFamily: MONO, fontSize: 11 }}>{cat}</td>
                      <td className="px-3 py-2 font-semibold" style={{ color: C.ink, fontFamily: SANS }}>{c.label}</td>
                      <td className="px-3 py-2 text-right font-bold" style={{ color: C.ink, fontFamily: MONO }}>{money(c.budget, true)}</td>
                      <td className="px-3 py-2 text-right" style={{ color: C.amber, fontFamily: MONO }}>{money(c.actual, true)}</td>
                      <td className="px-3 py-2 text-right" style={{ color: C.cool, fontFamily: MONO }}>{money(c.committed, true)}</td>
                      <td className="px-3 py-2 text-right" style={{ color: C.muted, fontFamily: MONO }}>{money(used, true)}</td>
                      <td className="px-3 py-2 text-right font-bold" style={{ color: c.budget - used < 0 ? C.stop : C.go, fontFamily: MONO }}>{money(c.budget - used, true)}</td>
                      <td className="px-3 py-2" style={{ width: 90 }}><Bar pct={(used / c.budget) * 100} tone={used > c.budget ? C.stop : C.amber} h={4} /></td>
                    </tr>
                    {catRows(cat).map((r) => (
                      <React.Fragment key={r.id}>
                        <tr className="cursor-pointer hover:opacity-90" onClick={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}
                          style={{ borderBottom: `1px solid ${C.line}` }}>
                          <td className="pl-3" style={{ color: C.faint }}>
                            {open[r.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </td>
                          <td className="px-3 py-2" style={{ color: C.faint, fontFamily: MONO }}>{r.code}</td>
                          <td className="px-3 py-2" style={{ color: C.ink, fontFamily: SANS }}>{r.name}</td>
                          <td className="px-3 py-2 text-right" style={{ color: C.ink, fontFamily: MONO }}>{money(r.budget)}</td>
                          <td className="px-3 py-2 text-right" style={{ color: r.actual ? C.amber : C.faint, fontFamily: MONO }}>{r.actual ? money(r.actual) : "—"}</td>
                          <td className="px-3 py-2 text-right" style={{ color: r.committed ? C.cool : C.faint, fontFamily: MONO }}>{r.committed ? money(r.committed) : "—"}</td>
                          <td className="px-3 py-2 text-right" style={{ color: C.muted, fontFamily: MONO }}>{money(r.eac)}</td>
                          <td className="px-3 py-2 text-right font-semibold" style={{ color: r.available < 0 ? C.stop : r.available / r.budget < 0.1 ? C.amber : C.muted, fontFamily: MONO }}>{money(r.available)}</td>
                          <td className="px-3 py-2"><Bar pct={(r.eac / r.budget) * 100} tone={r.available < 0 ? C.stop : r.available / r.budget < 0.1 ? C.amber : C.go} h={4} /></td>
                        </tr>
                        {open[r.id] && r.lines.map((l) => (
                          <tr key={l.id} style={{ borderBottom: `1px solid ${C.line}`, background: C.board }}>
                            <td /><td />
                            <td className="px-3 py-1.5 pl-6" style={{ color: C.muted, fontFamily: SANS }}>
                              {l.desc}
                              <span style={{ color: C.faint, fontFamily: MONO }}>
                                {"  "}{l.qty} × {l.unit} @ {money(l.rate)}{l.fringe ? ` +${(l.fringe * 100).toFixed(0)}% fringe` : ""}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-right" style={{ color: C.muted, fontFamily: MONO }}>
                              {money(l.qty * l.rate * (1 + (l.fringe || 0)))}
                            </td>
                            <td colSpan={5} />
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${C.line}` }}>
                <td /><td />
                <td className="px-3 py-3 font-bold uppercase" style={{ color: C.ink, fontFamily: SANS, fontSize: 11, letterSpacing: "0.06em" }}>Total production</td>
                <td className="px-3 py-3 text-right font-bold" style={{ color: C.ink, fontFamily: MONO }}>{money(bt.budget)}</td>
                <td className="px-3 py-3 text-right font-bold" style={{ color: C.amber, fontFamily: MONO }}>{money(bt.actual)}</td>
                <td className="px-3 py-3 text-right font-bold" style={{ color: C.cool, fontFamily: MONO }}>{money(bt.committed)}</td>
                <td className="px-3 py-3 text-right font-bold" style={{ color: C.muted, fontFamily: MONO }}>{money(bt.actual + bt.committed)}</td>
                <td className="px-3 py-3 text-right font-bold" style={{ color: bt.available < 0 ? C.stop : C.go, fontFamily: MONO }}>{money(bt.available)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </Panel>

      {adding && <AddAccountModal mutate={mutate} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddAccountModal({ mutate, onClose }) {
  const [d, setD] = useState({ code: "", cat: "BTL", name: "" });
  const [lines, setLines] = useState([{ desc: "", qty: 1, unit: "flat", rate: "", fringe: "" }]);

  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { desc: "", qty: 1, unit: "flat", rate: "", fringe: "" }]);
  const removeLine = (i) => setLines((ls) => ls.filter((_, j) => j !== i));

  // Fringe is entered as a percentage for humans, stored as a fraction.
  const total = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.rate) || 0) * (1 + (Number(l.fringe) || 0) / 100), 0);

  const save = () => {
    if (!d.code.trim() || !d.name.trim()) return;
    mutate("addAccount", {
      ...d,
      lines: lines.filter((l) => l.desc.trim()).map((l) => ({
        desc: l.desc, qty: Number(l.qty) || 1, unit: l.unit,
        rate: Number(l.rate) || 0, fringe: (Number(l.fringe) || 0) / 100,
      })),
    });
    onClose();
  };

  return (
    <Modal wide title="Add a budget account" sub="A code, a category, and one or more detail lines" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Code" hint="e.g. 2300"><Input value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} /></Field>
          <Field label="Category">
            <Select value={d.cat} onChange={(e) => setD({ ...d, cat: e.target.value })}>
              <option value="ATL">Above the line</option>
              <option value="BTL">Below the line</option>
              <option value="POST">Post-production</option>
              <option value="OTHER">Other &amp; contingency</option>
            </Select>
          </Field>
          <Field label="Name"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Lighting" /></Field>
        </div>

        <div>
          <div className="text-xs uppercase mb-1.5" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>Detail lines</div>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-1.5 items-center">
                <div className="col-span-4"><Input placeholder="Description" value={l.desc} onChange={(e) => setLine(i, { desc: e.target.value })} /></div>
                <div className="col-span-2"><Input type="number" placeholder="Qty" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></div>
                <div className="col-span-2">
                  <Select value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })}>
                    {["flat", "day", "week", "shot", "meal"].map((u) => <option key={u}>{u}</option>)}
                  </Select>
                </div>
                <div className="col-span-2"><Input type="number" placeholder="Rate" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} /></div>
                <div className="col-span-1"><Input type="number" placeholder="Fr%" value={l.fringe} onChange={(e) => setLine(i, { fringe: e.target.value })} /></div>
                <button onClick={() => removeLine(i)} className="col-span-1 flex justify-center" style={{ color: C.faint }} title="Remove line"><X size={13} /></button>
              </div>
            ))}
          </div>
          <button onClick={addLine} className="text-xs mt-2 hover:opacity-70" style={{ color: C.amber, fontFamily: SANS }}>+ Add line</button>
        </div>

        <div className="rounded px-3 py-2 flex justify-between text-xs" style={{ background: C.board, border: `1px solid ${C.line}` }}>
          <span style={{ color: C.faint, fontFamily: SANS }}>Account total, fringes included</span>
          <span style={{ color: C.amber, fontFamily: MONO, fontWeight: 700 }}>{money(total)}</span>
        </div>

        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" icon={Plus} onClick={save} disabled={!d.code.trim() || !d.name.trim()}>Add account</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   8 · COSTS — purchase orders and expenses
   ═══════════════════════════════════════════════════════════════════════════ */

function Costs({ st, mutate }) {
  const [tab, setTab] = useState("expenses");
  const [adding, setAdding] = useState(null);
  const [escalate, setEscalate] = useState(null);

  const available = (accId) => {
    const a = accById(st, accId);
    if (!a) return 0;
    return accountBudget(a) - accountActual(st, accId) - accountCommitted(st, accId);
  };

  const decide = (kind, id, status, force) => {
    const list = kind === "po" ? st.pos : st.expenses;
    const item = list.find((x) => x.id === id);
    if (status === "Approved" && !force && kind === "po" && item.amount > available(item.accId)) {
      setEscalate({ kind, item, avail: available(item.accId) });
      return;
    }
    if (kind === "po") mutate("decidePO", { poId: id, status });
    else mutate("decideExpense", { expenseId: id, status });
    setEscalate(null);
  };

  const pendingPO = st.pos.filter((p) => p.status === "Submitted");
  const pendingX = st.expenses.filter((x) => x.status === "Submitted");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Panel><Stat label="Awaiting approval" value={String(pendingPO.length + pendingX.length)}
          tone={pendingPO.length + pendingX.length ? C.amber : C.ink}
          sub={money(pendingPO.reduce((a, p) => a + p.amount, 0) + pendingX.reduce((a, x) => a + x.amount, 0))} /></Panel>
        <Panel><Stat label="Approved expenses" value={money(st.expenses.filter((x) => x.status === "Approved").reduce((a, x) => a + x.amount, 0), true)}
          sub={`${st.expenses.filter((x) => x.status === "Approved").length} claims`} /></Panel>
        <Panel><Stat label="Open commitments" value={money(st.pos.filter((p) => p.status === "Approved").reduce((a, p) => a + p.amount, 0), true)}
          tone={C.cool} sub={`${st.pos.filter((p) => p.status === "Approved").length} live purchase orders`} /></Panel>
        <Panel><Stat label="Petty cash out" value={money(st.expenses.filter((x) => x.mode === "Petty cash" && x.status === "Approved").reduce((a, x) => a + x.amount, 0), true)}
          sub="Reconciled against float" /></Panel>
      </div>

      <Panel>
        <PanelHead icon={Receipt} title="Costs"
          sub="An approved purchase order commits money immediately — before any invoice arrives."
          right={<>
            <Btn size="sm" variant={tab === "expenses" ? "solid" : "bare"} onClick={() => setTab("expenses")}>Expenses</Btn>
            <Btn size="sm" variant={tab === "pos" ? "solid" : "bare"} onClick={() => setTab("pos")}>Purchase orders</Btn>
            <Btn size="sm" variant="primary" icon={Plus} onClick={() => setAdding(tab)}>
              {tab === "pos" ? "Raise PO" : "Add expense"}
            </Btn>
          </>} />

        <div className="overflow-x-auto">
          {tab === "expenses" ? (
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                  {["Date", "Description", "Account", "Dept", "Mode", "Amount", "Status", ""].map((h, i) => (
                    <th key={i} className={`px-3 py-2 font-medium uppercase ${i === 5 ? "text-right" : "text-left"}`}
                      style={{ color: C.faint, fontFamily: SANS, fontSize: 11, letterSpacing: "0.06em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...st.expenses].reverse().map((x) => (
                  <tr key={x.id} style={{ borderBottom: `1px solid ${C.line}` }}>
                    <td className="px-3 py-2" style={{ color: C.muted, fontFamily: MONO }}>{fmtDate(x.date, { day: "2-digit", month: "short" })}</td>
                    <td className="px-3 py-2" style={{ color: C.ink, fontFamily: SANS }}>
                      {x.desc}<div style={{ color: C.faint, fontSize: 11 }}>by {x.by}</div>
                    </td>
                    <td className="px-3 py-2" style={{ color: C.muted, fontFamily: MONO }}>{accById(st, x.accId)?.code}</td>
                    <td className="px-3 py-2" style={{ color: C.muted, fontFamily: SANS }}>{x.dept}</td>
                    <td className="px-3 py-2" style={{ color: C.faint, fontFamily: SANS }}>{x.mode}</td>
                    <td className="px-3 py-2 text-right font-semibold" style={{ color: C.ink, fontFamily: MONO }}>{money(x.amount)}</td>
                    <td className="px-3 py-2">
                      <Pill tone={x.status === "Approved" ? "go" : x.status === "Rejected" ? "stop" : "amber"}>{x.status}</Pill>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {x.status === "Submitted" && <>
                        <Btn size="sm" variant="go" icon={Check} onClick={() => decide("x", x.id, "Approved")}>Approve</Btn>{" "}
                        <Btn size="sm" variant="danger" onClick={() => decide("x", x.id, "Rejected")}>Reject</Btn>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                  {["PO", "Vendor", "Description", "Account", "Raised by", "Amount", "Status", ""].map((h, i) => (
                    <th key={i} className={`px-3 py-2 font-medium uppercase ${i === 5 ? "text-right" : "text-left"}`}
                      style={{ color: C.faint, fontFamily: SANS, fontSize: 11, letterSpacing: "0.06em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...st.pos].reverse().map((p) => (
                  <tr key={p.id} style={{ borderBottom: `1px solid ${C.line}` }}>
                    <td className="px-3 py-2 font-bold" style={{ color: C.ink, fontFamily: MONO }}>{p.no}</td>
                    <td className="px-3 py-2" style={{ color: C.ink, fontFamily: SANS }}>{p.vendor}</td>
                    <td className="px-3 py-2" style={{ color: C.muted, fontFamily: SANS }}>{p.desc}</td>
                    <td className="px-3 py-2" style={{ color: C.muted, fontFamily: MONO }}>{accById(st, p.accId)?.code}</td>
                    <td className="px-3 py-2" style={{ color: C.faint, fontFamily: SANS }}>{p.raisedBy}</td>
                    <td className="px-3 py-2 text-right font-semibold" style={{ color: C.ink, fontFamily: MONO }}>{money(p.amount)}</td>
                    <td className="px-3 py-2">
                      <Pill tone={p.status === "Approved" ? "cool" : p.status === "Closed" ? "go" : p.status === "Rejected" ? "stop" : "amber"}>{p.status}</Pill>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {p.status === "Submitted" && <>
                        <Btn size="sm" variant="go" icon={Check} onClick={() => decide("po", p.id, "Approved")}>Approve</Btn>{" "}
                        <Btn size="sm" variant="danger" onClick={() => decide("po", p.id, "Rejected")}>Reject</Btn>
                      </>}
                      {p.status === "Approved" && <Btn size="sm" onClick={() => decide("po", p.id, "Closed", true)}>Close</Btn>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Panel>

      {adding && <NewCostModal st={st} mutate={mutate} kind={adding} onClose={() => setAdding(null)} available={available} />}
      {escalate && (
        <Modal title="This exceeds the account balance" sub="Approval escalates to the producer tier" onClose={() => setEscalate(null)}>
          <div className="space-y-4">
            <div className="rounded p-3" style={{ background: `${C.stop}10`, border: `1px solid ${C.stop}44` }}>
              <div className="text-xs mb-2" style={{ color: C.muted, fontFamily: SANS }}>
                Account {accById(st, escalate.item.accId)?.code} {accById(st, escalate.item.accId)?.name}
              </div>
              <div className="grid grid-cols-3 gap-3 text-xs" style={{ fontFamily: MONO }}>
                <div><div style={{ color: C.faint }}>Available</div><div style={{ color: C.ink }}>{money(escalate.avail)}</div></div>
                <div><div style={{ color: C.faint }}>Requested</div><div style={{ color: C.ink }}>{money(escalate.item.amount)}</div></div>
                <div><div style={{ color: C.faint }}>Overrun</div><div style={{ color: C.stop, fontWeight: 700 }}>{money(escalate.item.amount - escalate.avail)}</div></div>
              </div>
            </div>
            <div className="text-xs" style={{ color: C.muted, fontFamily: SANS }}>
              The line producer cannot approve this. A producer can, and the override is recorded against their name in the audit log.
            </div>
            <div className="flex justify-end gap-2">
              <Btn onClick={() => setEscalate(null)}>Cancel</Btn>
              <Btn variant="primary" icon={Check} onClick={() => decide(escalate.kind, escalate.item.id, "Approved", true)}>
                Approve as producer
              </Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NewCostModal({ st, mutate, kind, onClose, available }) {
  const isPO = kind === "pos";
  const [f, setF] = useState({
    desc: "", vendor: "", accId: st.accounts[0].id, dept: "Production",
    amount: "", mode: "Petty cash", date: new Date().toISOString().slice(0, 10),
  });
  const avail = available(f.accId);
  const over = Number(f.amount) > avail;

  const submit = () => {
    const amount = Number(f.amount) || 0;
    if (isPO) mutate("raisePO", { vendor: f.vendor || "Unnamed vendor", accId: f.accId, amount, date: f.date, desc: f.desc });
    else mutate("submitExpense", { date: f.date, desc: f.desc, accId: f.accId, dept: f.dept, amount, mode: f.mode });
    onClose();
  };

  return (
    <Modal title={isPO ? "Raise a purchase order" : "Add an expense"}
      sub={isPO ? "Approved orders commit budget immediately" : "Goes to the line producer for approval"} onClose={onClose}>
      <div className="space-y-3">
        {isPO && <Field label="Vendor"><Input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} placeholder="Who is being paid" /></Field>}
        <Field label="Description"><Input value={f.desc} onChange={(e) => setF({ ...f, desc: e.target.value })} placeholder="What this is for" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Amount (₹)"><Input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0" /></Field>
        </div>
        <Field label="Budget account" hint={`${money(avail)} available on this account`}>
          <Select value={f.accId} onChange={(e) => setF({ ...f, accId: e.target.value })}>
            {st.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
          </Select>
        </Field>
        {!isPO && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Department">
              <Select value={f.dept} onChange={(e) => setF({ ...f, dept: e.target.value })}>
                {DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}
              </Select>
            </Field>
            <Field label="Paid by">
              <Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
                {["Petty cash", "Bank", "Card", "Advance"].map((m) => <option key={m}>{m}</option>)}
              </Select>
            </Field>
          </div>
        )}
        {over && f.amount && (
          <div className="flex items-start gap-2 rounded px-3 py-2" style={{ background: `${C.amber}12`, border: `1px solid ${C.amber}44` }}>
            <AlertTriangle size={13} style={{ color: C.amber, flexShrink: 0, marginTop: 1 }} />
            <div className="text-xs" style={{ color: C.muted, fontFamily: SANS }}>
              This is {money(Number(f.amount) - avail)} more than the account has left. You can still submit it — approval will escalate to the producer.
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" icon={Check} onClick={submit} disabled={!f.desc.trim() || !f.amount}>
            {isPO ? "Submit for approval" : "Submit claim"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   9 · PEOPLE
   ═══════════════════════════════════════════════════════════════════════════ */

function People({ st, mutate }) {
  const [tab, setTab] = useState("cast");
  const [sel, setSel] = useState(null);
  const [adding, setAdding] = useState(false);
  const dd = useMemo(() => dood(st), [st]);

  const list = st.people.filter((p) => (tab === "cast" ? p.type === "cast" : p.type === "crew"));
  const byDept = DEPARTMENTS.map((d) => ({ dept: d, people: list.filter((p) => p.dept === d) })).filter((g) => g.people.length);

  const daysFor = (p) => {
    if (p.type === "cast") {
      const ch = st.characters.find((c) => c.castId === p.id);
      const row = dd.find((r) => r.ch.id === ch?.id);
      return row ? { work: row.work, hold: row.hold } : { work: 0, hold: 0 };
    }
    return { work: st.days.filter((d) => d.status !== "Planned").length, hold: 0 };
  };

  const exportPeople = () => download("cast-and-crew.csv", toCSV([
    ["Name", "Type", "Department", "Role", "Phone", "Email", "Rate", "Basis", "Start", "End", "Work days", "Hold days", "Est. cost"],
    ...st.people.map((p) => {
      const d = daysFor(p);
      return [p.name, p.type, p.dept, p.role, p.phone, p.email, p.rate, p.basis, p.start, p.end, d.work, d.hold,
        p.basis === "day" ? p.rate * (d.work + d.hold) : p.rate];
    }),
  ]));

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHead icon={Users} title="Cast &amp; crew"
          sub={`${st.people.filter((p) => p.type === "cast").length} cast · ${st.people.filter((p) => p.type === "crew").length} crew · personal and bank details are masked by default`}
          right={<>
            <Btn size="sm" variant={tab === "cast" ? "solid" : "bare"} onClick={() => setTab("cast")}>Cast</Btn>
            <Btn size="sm" variant={tab === "crew" ? "solid" : "bare"} onClick={() => setTab("crew")}>Crew</Btn>
            <Btn size="sm" icon={Download} onClick={exportPeople}>Export</Btn>
            <Btn size="sm" variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add person</Btn>
          </>} />
      </Panel>

      {byDept.map((g) => (
        <Panel key={g.dept}>
          <PanelHead title={g.dept} sub={`${g.people.length} ${g.people.length === 1 ? "person" : "people"}`} />
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                  {["Name", "Role", "Contact", "Engaged", "Work", "Hold", "Rate", "Est. cost"].map((h, i) => (
                    <th key={i} className={`px-3 py-2 font-medium uppercase ${i >= 6 ? "text-right" : "text-left"}`}
                      style={{ color: C.faint, fontFamily: SANS, fontSize: 11, letterSpacing: "0.06em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {g.people.map((p) => {
                  const d = daysFor(p);
                  const cost = p.basis === "day" ? p.rate * (d.work + d.hold) : p.rate;
                  return (
                    <tr key={p.id} className="cursor-pointer hover:opacity-90" onClick={() => setSel(p.id)}
                      style={{ borderBottom: `1px solid ${C.line}` }}>
                      <td className="px-3 py-2 font-semibold" style={{ color: C.ink, fontFamily: SANS }}>{p.name}</td>
                      <td className="px-3 py-2" style={{ color: C.muted, fontFamily: MONO }}>{p.role}</td>
                      <td className="px-3 py-2" style={{ color: C.faint, fontFamily: MONO }}>{p.phone}</td>
                      <td className="px-3 py-2" style={{ color: C.faint, fontFamily: MONO }}>
                        {fmtDate(p.start, { day: "2-digit", month: "short" })} – {fmtDate(p.end, { day: "2-digit", month: "short" })}
                      </td>
                      <td className="px-3 py-2" style={{ color: C.ink, fontFamily: MONO }}>{d.work || "—"}</td>
                      <td className="px-3 py-2" style={{ color: d.hold ? C.stop : C.faint, fontFamily: MONO }}>{d.hold || "—"}</td>
                      <td className="px-3 py-2 text-right" style={{ color: C.muted, fontFamily: MONO }}>
                        {p.rate ? `${money(p.rate)}/${p.basis}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold" style={{ color: C.ink, fontFamily: MONO }}>{cost ? money(cost) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      ))}

      {sel && (() => {
        const p = personById(st, sel);
        const ch = st.characters.find((c) => c.castId === p.id);
        const scenes = ch ? st.scenes.filter((s) => s.cast.includes(ch.id)) : [];
        const days = st.days.filter((d) => ch && dayScenes(st, d).some((s) => s.cast.includes(ch.id)));
        return (
          <Modal title={p.name} sub={`${p.role} · ${p.dept}`} onClose={() => setSel(null)} wide>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="space-y-3">
                <div className="rounded p-3 space-y-2" style={{ background: C.board, border: `1px solid ${C.line}` }}>
                  <div className="flex items-center gap-2 text-xs" style={{ color: C.muted, fontFamily: MONO }}><Phone size={12} /> {p.phone}</div>
                  <div className="flex items-center gap-2 text-xs" style={{ color: C.muted, fontFamily: MONO }}><Mail size={12} /> {p.email}</div>
                  <div className="flex items-center gap-2 text-xs" style={{ color: C.faint, fontFamily: MONO }}>
                    <Lock size={12} /> Bank &amp; ID documents — masked, access logged
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Rate"><div className="text-sm" style={{ color: C.ink, fontFamily: MONO }}>{p.rate ? `${money(p.rate)} / ${p.basis}` : "Flat deal"}</div></Field>
                  <Field label="Engagement"><div className="text-sm" style={{ color: C.ink, fontFamily: MONO }}>{fmtDate(p.start)} – {fmtDate(p.end)}</div></Field>
                </div>
                {ch && (
                  <Field label="Day out of days">
                    <div className="text-sm" style={{ color: C.ink, fontFamily: MONO }}>
                      {daysFor(p).work} work · <span style={{ color: daysFor(p).hold ? C.stop : C.faint }}>{daysFor(p).hold} hold</span>
                    </div>
                  </Field>
                )}
              </div>
              <div>
                {ch ? <>
                  <div className="text-xs uppercase mb-2" style={{ color: C.faint, fontFamily: SANS, letterSpacing: "0.08em" }}>
                    {scenes.length} scenes as {ch.name}
                  </div>
                  <div className="space-y-1 overflow-y-auto" style={{ maxHeight: 260 }}>
                    {scenes.map((s) => <Strip key={s.id} scene={s} st={st} compact />)}
                  </div>
                  <div className="text-xs mt-3" style={{ color: C.faint, fontFamily: SANS }}>
                    Scheduled on days {days.map((d) => d.n).join(", ") || "—"}
                  </div>
                </> : (
                  <div className="text-xs" style={{ color: C.faint, fontFamily: SANS }}>
                    Crew engagement. Attendance is captured per shooting day and feeds the payroll export.
                  </div>
                )}
              </div>
            </div>
          </Modal>
        );
      })()}

      {adding && <AddPersonModal tab={tab} mutate={mutate} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddPersonModal({ tab, mutate, onClose }) {
  const [d, setD] = useState({ name: "", type: tab, dept: DEPARTMENTS[0], role: "", phone: "", email: "", rate: "", basis: "day", start: "", end: "" });

  const save = () => {
    if (!d.name.trim()) return;
    mutate("addPerson", { ...d, rate: Number(d.rate) || 0 });
    onClose();
  };

  return (
    <Modal title={`Add ${tab === "cast" ? "a cast member" : "a crew member"}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value })}>
              <option value="cast">Cast</option><option value="crew">Crew</option>
            </Select>
          </Field>
          <Field label="Department">
            <Select value={d.dept} onChange={(e) => setD({ ...d, dept: e.target.value })}>
              {DEPARTMENTS.map((x) => <option key={x}>{x}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Role / character"><Input value={d.role} onChange={(e) => setD({ ...d, role: e.target.value })} placeholder={d.type === "cast" ? "e.g. RAVI" : "e.g. Gaffer"} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone"><Input value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })} /></Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Rate (₹)"><Input type="number" value={d.rate} onChange={(e) => setD({ ...d, rate: e.target.value })} /></Field>
          <Field label="Basis">
            <Select value={d.basis} onChange={(e) => setD({ ...d, basis: e.target.value })}>
              <option value="day">Per day</option><option value="week">Per week</option><option value="flat">Flat</option>
            </Select>
          </Field>
          <Field label="Start"><Input type="date" value={d.start} onChange={(e) => setD({ ...d, start: e.target.value })} /></Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" icon={Plus} onClick={save} disabled={!d.name.trim()}>Add</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · LOCATIONS
   ═══════════════════════════════════════════════════════════════════════════ */

function Locations({ st, mutate }) {
  const [adding, setAdding] = useState(false);
  const setPermit = (id, permit) => mutate("updateLocationPermit", { locId: id, permit });

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHead icon={MapPin} title="Locations"
          sub={`${st.locations.length} locations · ${st.locations.filter((l) => l.permit !== "Granted").length} without a granted permit`}
          right={<>
            <Btn size="sm" icon={Download} onClick={() => download("locations.csv", toCSV([
              ["Location", "Sets", "Address", "Contact", "Phone", "Day rate", "Permit", "Permit expiry", "Hospital", "Shooting days"],
              ...st.locations.map((l) => [l.name, l.sets.join(" / "), l.address, l.contact, l.phone, l.rate, l.permit,
                l.permitExpiry, l.hospital, st.days.filter((d) => d.locId === l.id).map((d) => d.n).join(" ")]),
            ]))}>Export</Btn>
            <Btn size="sm" variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add location</Btn>
          </>} />
      </Panel>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {st.locations.map((l) => {
          const days = st.days.filter((d) => d.locId === l.id);
          const scenes = st.scenes.filter((s) => s.locId === l.id);
          const sun = sunTimes(l.lat, days[0]?.date || st.production.shootStart);
          const expiringSoon = days.some((d) => l.permitExpiry && l.permitExpiry < d.date);
          return (
            <Panel key={l.id}>
              <PanelHead icon={Building2} title={l.name} sub={l.sets.join(" · ")}
                right={
                  <select value={l.permit} onChange={(e) => setPermit(l.id, e.target.value)}
                    className="text-xs rounded px-2 py-1 outline-none"
                    style={{
                      background: l.permit === "Granted" ? `${C.go}1A` : `${C.amber}1A`,
                      color: l.permit === "Granted" ? C.go : C.amber,
                      border: `1px solid ${l.permit === "Granted" ? C.go + "55" : C.amber + "55"}`, fontFamily: SANS,
                    }}>
                    {["Scouted", "Shortlisted", "Applied", "Granted", "Released"].map((s) => (
                      <option key={s} style={{ background: C.panel, color: C.ink }}>{s}</option>
                    ))}
                  </select>
                } />
              <div className="p-4 space-y-3">
                <div className="text-xs" style={{ color: C.muted, fontFamily: SANS }}>{l.address}</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs" style={{ fontFamily: MONO }}>
                  <div><span style={{ color: C.faint }}>CONTACT </span><span style={{ color: C.ink }}>{l.contact}</span></div>
                  <div><span style={{ color: C.faint }}>PHONE </span><span style={{ color: C.ink }}>{l.phone}</span></div>
                  <div><span style={{ color: C.faint }}>DAY RATE </span><span style={{ color: C.ink }}>{l.rate ? money(l.rate) : "No fee"}</span></div>
                  <div><span style={{ color: C.faint }}>PERMIT TO </span>
                    <span style={{ color: expiringSoon ? C.stop : C.ink }}>{fmtDate(l.permitExpiry, { day: "2-digit", month: "short" })}</span>
                  </div>
                  <div className="flex items-center gap-1.5"><Sun size={11} style={{ color: C.amber }} /><span style={{ color: C.ink }}>{sun.rise}</span></div>
                  <div className="flex items-center gap-1.5"><Moon size={11} style={{ color: C.cool }} /><span style={{ color: C.ink }}>{sun.set}</span></div>
                </div>
                <div className="rounded px-2.5 py-2 text-xs" style={{ background: `${C.stop}0D`, border: `1px solid ${C.stop}33`, color: C.muted, fontFamily: SANS }}>
                  Nearest hospital — {l.hospital}
                </div>
                {l.notes && <div className="text-xs" style={{ color: C.faint, fontFamily: SANS }}>{l.notes}</div>}
                <div className="flex flex-wrap items-center gap-2 pt-1" style={{ borderTop: `1px solid ${C.line}` }}>
                  <span className="text-xs pt-2" style={{ color: C.faint, fontFamily: SANS }}>
                    {scenes.length} scenes · {eighths(sumEighths(scenes))} pages ·
                  </span>
                  {days.map((d) => (
                    <span key={d.id} className="text-xs rounded px-1.5 py-0.5 mt-2"
                      style={{ background: C.raised, color: C.muted, fontFamily: MONO }}>DAY {d.n}</span>
                  ))}
                  {!days.length && <span className="text-xs pt-2" style={{ color: C.amber, fontFamily: SANS }}>no days scheduled here</span>}
                </div>
              </div>
            </Panel>
          );
        })}
      </div>

      {adding && <AddLocationModal mutate={mutate} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddLocationModal({ mutate, onClose }) {
  const [d, setD] = useState({ name: "", address: "", contact: "", phone: "", rate: "", hospital: "", notes: "", permit: "Scouted" });

  const save = () => {
    if (!d.name.trim()) return;
    mutate("addLocation", { ...d, sets: [], rate: Number(d.rate) || 0 });
    onClose();
  };

  return (
    <Modal title="Add a location" sub="Scouted first, permit updated as it progresses" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. KSRTC Depot, Kolar" /></Field>
        <Field label="Address"><TextArea value={d.address} onChange={(e) => setD({ ...d, address: e.target.value })} style={{ minHeight: 50 }} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact"><Input value={d.contact} onChange={(e) => setD({ ...d, contact: e.target.value })} /></Field>
          <Field label="Phone"><Input value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Day rate (₹)"><Input type="number" value={d.rate} onChange={(e) => setD({ ...d, rate: e.target.value })} /></Field>
          <Field label="Permit status">
            <Select value={d.permit} onChange={(e) => setD({ ...d, permit: e.target.value })}>
              {["Scouted", "Shortlisted", "Applied", "Granted"].map((s) => <option key={s}>{s}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Nearest hospital"><Input value={d.hospital} onChange={(e) => setD({ ...d, hospital: e.target.value })} /></Field>
        <Field label="Notes"><TextArea value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
        <div className="flex justify-end gap-2 pt-1">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" icon={Plus} onClick={save} disabled={!d.name.trim()}>Add location</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   11 · REPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

function Reports({ st }) {
  const bt = budgetTotals(st);
  const pr = progress(st);
  const days = [...st.days].sort((a, b) => a.n - b.n);

  const reports = [
    { name: "One-liner schedule", desc: "Every scheduled scene by shooting day, with cast and synopsis.", run: () =>
      download("one-liner-schedule.csv", toCSV([
        ["Day", "Date", "Unit", "Location", "Scene", "I/E", "Set", "D/N", "Pages", "Cast", "Synopsis"],
        ...days.flatMap((d) => dayScenes(st, d).map((s) => [d.n, d.date, d.unit, locById(st, d.locId)?.name || "", s.no, s.intExt, s.set, s.dn, eighths(s.eighths), s.cast.map((c) => charById(st, c)?.name).join(" / "), s.synopsis])),
      ])) },
    { name: "Day out of days", desc: "Cast start, work, hold and finish days — the basis of every talent deal.", run: () =>
      download("day-out-of-days.csv", toCSV([
        ["Character", "Artist", ...days.map((d) => `D${d.n}`), "Work", "Hold", "Total"],
        ...dood(st).map((r) => [r.ch.name, personById(st, r.ch.castId)?.name || "Not cast", ...r.marks, r.work, r.hold, r.total]),
      ])) },
    { name: "Breakdown element report", desc: "Every tagged element by category, with status, cost and the scenes it appears in.", run: () =>
      download("element-report.csv", toCSV([
        ["Category", "Element", "Department", "Status", "Estimate", "Actual", "Vendor", "Scenes"],
        ...st.elements.map((e) => [catById(e.cat).name, e.name, e.dept, e.status, e.est, e.actual, e.vendor, e.scenes.map((s) => sceneById(st, s)?.no).filter(Boolean).join(" ")]),
      ])) },
    { name: "Cost report", desc: "Budget, actual, committed, estimate at completion and variance, by account.", run: () =>
      download("cost-report.csv", toCSV([
        ["Code", "Account", "Category", "Budget", "Actual", "Committed", "EAC", "Available"],
        ...bt.rows.map((r) => [r.code, r.name, r.cat, Math.round(r.budget), Math.round(r.actual), Math.round(r.committed), Math.round(r.eac), Math.round(r.available)]),
        [], ["TOTAL", "", "", Math.round(bt.budget), Math.round(bt.actual), Math.round(bt.committed), Math.round(bt.actual + bt.committed), Math.round(bt.available)],
      ])) },
    { name: "Daily production report log", desc: "Planned against shot, day by day, with setups and delays.", run: () =>
      download("dpr-log.csv", toCSV([
        ["Day", "Date", "Location", "Planned eighths", "Shot eighths", "Variance", "Setups", "First shot", "Wrap", "Delay minutes", "Approved by"],
        ...days.map((d) => {
          const r = st.dprs[d.id];
          const plan = dayTotals(st, d).eighths;
          return [d.n, d.date, locById(st, d.locId)?.name || "", plan, r?.eighthsShot ?? "", r ? r.eighthsShot - plan : "", r?.setups ?? "", r?.firstShot ?? "", r?.wrap ?? "", r ? r.delays.reduce((a, x) => a + x.mins, 0) : "", r?.approvedBy ?? ""];
        }),
      ])) },
    { name: "Purchase order register", desc: "Every order raised, its account, approver and current status.", run: () =>
      download("po-register.csv", toCSV([
        ["PO", "Date", "Vendor", "Description", "Account", "Amount", "Raised by", "Status"],
        ...st.pos.map((p) => [p.no, p.date, p.vendor, p.desc, accById(st, p.accId)?.code, p.amount, p.raisedBy, p.status]),
      ])) },
    { name: "Expense register", desc: "All claims with account coding, payment mode and approval state.", run: () =>
      download("expense-register.csv", toCSV([
        ["Date", "Description", "Account", "Department", "Mode", "Amount", "Submitted by", "Status"],
        ...st.expenses.map((x) => [x.date, x.desc, accById(st, x.accId)?.code, x.dept, x.mode, x.amount, x.by, x.status]),
      ])) },
    { name: "Location register", desc: "Locations with permits, expiry dates and the days scheduled there.", run: () =>
      download("location-register.csv", toCSV([
        ["Location", "Sets", "Address", "Contact", "Phone", "Rate", "Permit", "Expiry", "Hospital", "Days"],
        ...st.locations.map((l) => [l.name, l.sets.join(" / "), l.address, l.contact, l.phone, l.rate, l.permit, l.permitExpiry, l.hospital, st.days.filter((d) => d.locId === l.id).map((d) => d.n).join(" ")]),
      ])) },
    { name: "Audit log", desc: "Every state change with actor, action and timestamp.", run: () =>
      download("audit-log.csv", toCSV([
        ["Timestamp", "Actor", "Action", "Object", "Detail"],
        ...st.audit.map((a) => [a.ts, a.actor, a.action, a.object, a.detail]),
      ])) },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Panel><Stat label="Scenes shot" value={`${pr.scenesDone} / ${pr.totalScenes}`} sub={`${eighths(pr.shotEighths)} of ${eighths(pr.totalEighths)} pages`} /></Panel>
        <Panel><Stat label="Setups to date" value={String(pr.setups)} sub={`${pr.daysShot ? (pr.setups / pr.daysShot).toFixed(1) : 0} a day`} /></Panel>
        <Panel><Stat label="Time lost to delays" value={`${Math.floor(pr.delayMins / 60)}h ${pr.delayMins % 60}m`} tone={C.amber} sub="Across approved reports" /></Panel>
        <Panel><Stat label="Cost per page" value={money(pr.shotEighths ? (bt.actual / (pr.shotEighths / 8)) : 0, true)} sub="Actual spend ÷ pages shot" /></Panel>
      </div>

      <Panel>
        <PanelHead icon={BarChart3} title="Reports"
          sub="Every export carries the production name, the exporting user and a timestamp, and is written to the audit log." />
        <div>
          {reports.map((r) => (
            <div key={r.name} className="flex items-center gap-4 px-4 py-3" style={{ borderBottom: `1px solid ${C.line}` }}>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium" style={{ color: C.ink, fontFamily: SANS }}>{r.name}</div>
                <div className="text-xs mt-0.5" style={{ color: C.faint, fontFamily: SANS }}>{r.desc}</div>
              </div>
              <Btn size="sm" icon={Download} onClick={r.run}>CSV</Btn>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   APP SHELL
   ═══════════════════════════════════════════════════════════════════════════ */

const NAV = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "script",    label: "Script",    icon: FileText },
  { id: "breakdown", label: "Breakdown", icon: Tag },
  { id: "schedule",  label: "Schedule",  icon: CalendarDays },
  { id: "callsheet", label: "Call sheet",icon: ClipboardList },
  { id: "dpr",       label: "Daily report", icon: Layers },
  { id: "budget",    label: "Budget",    icon: Wallet },
  { id: "costs",     label: "Costs",     icon: Receipt },
  { id: "people",    label: "Cast & crew", icon: Users },
  { id: "locations", label: "Locations", icon: MapPin },
  { id: "reports",   label: "Reports",   icon: BarChart3 },
];

/* ── Root: auth gate → production picker → the production itself ────────
   Three states, resolved in order:
     1. Still checking the session cookie → a quiet loading screen
     2. No user and not in demo mode      → AuthScreen
     3. User but no production selected   → ProductionPicker
     4. Otherwise                         → the application
   Demo mode short-circuits 2 and 3 entirely.                            */

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [demo, setDemo] = useState(false);
  const [productions, setProductions] = useState([]);
  const [productionId, setProductionId] = useState(null);

  // Resolve the session once on load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.me();
        if (!cancelled && res.user) {
          setUser(res.user);
          const list = await api.listProductions();
          if (!cancelled) setProductions(list.productions || []);
        }
      } catch (e) {
        // No backend bound (static-only deploy) or not signed in — either
        // way the demo remains available, so this is not an error state.
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const refreshProductions = useCallback(async () => {
    try {
      const list = await api.listProductions();
      setProductions(list.productions || []);
    } catch (e) { /* leave the existing list in place */ }
  }, []);

  const signOut = async () => {
    try { await api.signout(); } catch (e) { /* clearing local state anyway */ }
    setUser(null); setProductions([]); setProductionId(null); setDemo(false);
  };

  if (checking) {
    return (
      <div className="flex items-center justify-center" style={{ background: C.board, minHeight: "100vh" }}>
        <div className="text-sm" style={{ color: C.faint, fontFamily: MONO }}>Checking your session…</div>
      </div>
    );
  }

  if (!user && !demo) {
    return <AuthScreen
      onSignedIn={async (u) => { setUser(u); await refreshProductions(); }}
      onTryDemo={() => setDemo(true)} />;
  }

  if (user && !productionId && !demo) {
    return <ProductionPicker
      user={user}
      productions={productions}
      onPick={setProductionId}
      onCreated={async (id) => { await refreshProductions(); setProductionId(id); }}
      onSignOut={signOut} />;
  }

  return <ProductionView
    productionId={productionId}
    demo={demo}
    user={user}
    onLeave={() => { setProductionId(null); if (demo) { setDemo(false); } }} />;
}

function ProductionView({ productionId, demo, user, onLeave }) {
  const { state: st, member, mutate, status, error, setError, resetDemo } = useProduction({ productionId, demo });
  const [route, setRoute] = useState("dashboard");
  const [navOpen, setNavOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showMembers, setShowMembers] = useState(false);

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center" style={{ background: C.board, minHeight: "100vh" }}>
        <div className="text-sm" style={{ color: C.faint, fontFamily: MONO }}>Opening production…</div>
      </div>
    );
  }

  if (status === "error" || !st) {
    return (
      <div className="flex items-center justify-center p-6" style={{ background: C.board, minHeight: "100vh" }}>
        <div className="max-w-sm text-center">
          <AlertTriangle size={22} style={{ color: C.stop, margin: "0 auto 12px" }} />
          <div className="text-sm mb-2" style={{ color: C.ink, fontFamily: SANS }}>Couldn't open this production</div>
          <div className="text-xs mb-4" style={{ color: C.faint, fontFamily: SANS }}>{error || "The production could not be loaded."}</div>
          <Btn onClick={onLeave}>Back</Btn>
        </div>
      </div>
    );
  }

  const pr = progress(st);
  const bt = budgetTotals(st);
  const al = alerts(st);
  const blockers = al.filter((a) => a.sev === "stop").length;
  const behind = pr.daysVariance < -0.15;
  const role = member?.role || "producer";

  const Page = {
    dashboard: <Dashboard st={st} go={setRoute} />,
    script:    <ScriptModule st={st} mutate={mutate} />,
    breakdown: <Breakdown st={st} mutate={mutate} />,
    schedule:  <Schedule st={st} mutate={mutate} />,
    callsheet: <CallSheetModule st={st} mutate={mutate} />,
    dpr:       <DPRModule st={st} mutate={mutate} />,
    budget:    <Budget st={st} mutate={mutate} />,
    costs:     <Costs st={st} mutate={mutate} />,
    people:    <People st={st} mutate={mutate} />,
    locations: <Locations st={st} mutate={mutate} />,
    reports:   <Reports st={st} />,
  }[route];

  const saveLabel = { saving: "Saving", saved: "Saved", ready: "", loading: "", error: "" }[status];

  return (
    <div className="min-h-screen flex" style={{ background: C.board, color: C.ink }}>
      <nav className={`flex-shrink-0 flex flex-col ${navOpen ? "fixed inset-y-0 left-0 z-40" : "hidden md:flex"}`}
        style={{ width: 208, background: C.panel, borderRight: `1px solid ${C.line}` }}>
        <div className="px-4 py-4" style={{ borderBottom: `1px solid ${C.line}` }}>
          <button onClick={onLeave} className="flex items-center gap-2 w-full text-left hover:opacity-80">
            <div className="rounded flex items-center justify-center flex-shrink-0"
              style={{ width: 24, height: 24, background: C.amber }}>
              <Film size={14} style={{ color: "#1A1206" }} />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-bold tracking-wide" style={{ color: C.ink, fontFamily: MONO }}>FPMS</div>
              <div className="text-xs truncate" style={{ color: C.faint, fontFamily: SANS, fontSize: 10 }}>
                {demo ? "Demo production" : st.production.company || "Switch production"}
              </div>
            </div>
          </button>
        </div>

        <div className="flex-1 py-2 overflow-y-auto">
          {NAV.map((n) => {
            const active = route === n.id;
            const badge = n.id === "costs"
              ? st.pos.filter((p) => p.status === "Submitted").length + st.expenses.filter((x) => x.status === "Submitted").length
              : 0;
            return (
              <button key={n.id} onClick={() => { setRoute(n.id); setNavOpen(false); }}
                className="w-full flex items-center gap-2.5 px-4 py-2 text-left"
                style={{
                  color: active ? C.ink : C.muted,
                  background: active ? C.raised : "transparent",
                  borderLeft: `2px solid ${active ? C.amber : "transparent"}`,
                  fontFamily: SANS, fontSize: 13,
                }}>
                <n.icon size={15} style={{ color: active ? C.amber : C.faint, flexShrink: 0 }} />
                <span className="flex-1 truncate">{n.label}</span>
                {badge > 0 && (
                  <span className="rounded-full px-1.5 text-xs font-bold"
                    style={{ background: C.amber, color: "#1A1206", fontFamily: MONO, fontSize: 10 }}>{badge}</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="px-4 py-3 space-y-2" style={{ borderTop: `1px solid ${C.line}` }}>
          <div className="flex items-center gap-1.5 text-xs" style={{ color: C.faint, fontFamily: SANS }}>
            <span className="rounded-full" style={{ width: 5, height: 5, background: demo ? C.amber : C.go }} />
            {demo ? "Demo — this browser only" : "Saved to the server"}
          </div>
          {!demo && (
            <div className="text-xs" style={{ color: C.faint, fontFamily: SANS }}>
              {user?.name} · {role.replace(/_/g, " ")}
            </div>
          )}
          {!demo && role === "producer" && (
            <button onClick={() => setShowMembers(true)} className="text-xs hover:opacity-70 block"
              style={{ color: C.faint, fontFamily: SANS }}>Manage crew access</button>
          )}
          {demo && (
            <button onClick={() => setConfirmReset(true)} className="text-xs hover:opacity-70 block"
              style={{ color: C.faint, fontFamily: SANS }}>Reset the demo</button>
          )}
        </div>
      </nav>

      {navOpen && <div className="fixed inset-0 z-30 md:hidden" style={{ background: "rgba(0,0,0,.6)" }} onClick={() => setNavOpen(false)} />}

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex items-center gap-3 px-4 py-3 flex-wrap"
          style={{ background: C.panel, borderBottom: `1px solid ${C.line}` }}>
          <button className="md:hidden" onClick={() => setNavOpen(true)} style={{ color: C.muted }} title="Menu"><Menu size={18} /></button>
          <div className="min-w-0">
            <div className="text-sm font-bold truncate" style={{ color: C.ink, fontFamily: MONO, letterSpacing: "0.02em" }}>
              {(st.production.title || "Untitled").toUpperCase()}
            </div>
            <div className="text-xs" style={{ color: C.faint, fontFamily: SANS }}>
              {st.production.status} · Day {pr.dayNo} of {st.production.plannedDays || "—"}
              {st.production.territory ? ` · ${st.production.territory}` : ""}
            </div>
          </div>

          <div className="flex items-center gap-2 ml-auto flex-wrap">
            {saveLabel && <span className="text-xs" style={{ color: C.faint, fontFamily: SANS }}>{saveLabel}</span>}
            <Pill tone={behind ? "stop" : "go"} mono>
              {behind ? "BEHIND" : pr.daysVariance > 0.15 ? "AHEAD" : "ON PLAN"} {pr.daysVariance >= 0 ? "+" : ""}{pr.daysVariance.toFixed(1)}d
            </Pill>
            <Pill tone={bt.available < 0 ? "stop" : "cool"} mono>{money(bt.available, true)} LEFT</Pill>
            {blockers > 0 && <Pill tone="stop" mono><AlertTriangle size={11} /> {blockers}</Pill>}
          </div>
        </header>

        {/* A rejected action — usually a permission the role doesn't have —
            surfaces here rather than failing silently. */}
        {error && (
          <div className="flex items-start gap-2 px-4 py-2.5" style={{ background: `${C.stop}12`, borderBottom: `1px solid ${C.stop}44` }}>
            <AlertTriangle size={14} style={{ color: C.stop, flexShrink: 0, marginTop: 1 }} />
            <div className="text-xs flex-1" style={{ color: C.muted, fontFamily: SANS }}>{error}</div>
            <button onClick={() => setError("")} style={{ color: C.faint }}><X size={14} /></button>
          </div>
        )}

        <main className="flex-1 p-4 overflow-x-hidden">{Page}</main>
      </div>

      {confirmReset && (
        <Modal title="Reset the demo?" sub="Everything you have changed here will be replaced" onClose={() => setConfirmReset(false)}>
          <div className="space-y-4">
            <div className="text-xs" style={{ color: C.muted, fontFamily: SANS }}>
              This restores <i>The Last Bus to Kolar</i> as it ships — 18 scenes, 8 shooting days, four approved daily reports and the seeded budget.
            </div>
            <div className="flex justify-end gap-2">
              <Btn onClick={() => setConfirmReset(false)}>Keep my changes</Btn>
              <Btn variant="danger" icon={Trash2} onClick={() => { resetDemo(); setConfirmReset(false); setRoute("dashboard"); }}>Reset</Btn>
            </div>
          </div>
        </Modal>
      )}

      {showMembers && <MembersModal productionId={productionId} onClose={() => setShowMembers(false)} />}
    </div>
  );
}

function MembersModal({ productionId, onClose }) {
  const [members, setMembers] = useState([]);
  const [f, setF] = useState({ email: "", role: "first_ad", department: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setMembers((await api.listMembers(productionId)).members || []); }
    catch (e) { setErr(e.message); }
  }, [productionId]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    setBusy(true); setErr("");
    try {
      await api.addMember(productionId, f);
      setF({ email: "", role: "first_ad", department: "" });
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const ROLE_LABELS = [
    ["producer", "Producer"], ["line_producer", "Line producer"], ["first_ad", "1st AD"],
    ["second_ad", "2nd AD"], ["director", "Director"], ["dept_head", "Department head"],
    ["accountant", "Accountant"], ["post_supervisor", "Post supervisor"],
    ["crew", "Crew"], ["viewer", "Viewer"],
  ];

  return (
    <Modal title="Crew access" sub="Who can open this production, and what they can do" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded overflow-hidden" style={{ border: `1px solid ${C.line}` }}>
          {members.map((m) => (
            <div key={m.id} className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${C.line}` }}>
              <div className="min-w-0 flex-1">
                <div className="text-xs" style={{ color: C.ink, fontFamily: SANS }}>{m.name}</div>
                <div className="text-xs" style={{ color: C.faint, fontFamily: SANS }}>{m.email}</div>
              </div>
              <Pill tone="cool">{m.role.replace(/_/g, " ")}</Pill>
              {m.department && <span className="text-xs" style={{ color: C.faint, fontFamily: SANS }}>{m.department}</span>}
            </div>
          ))}
          {!members.length && <div className="px-3 py-4 text-xs" style={{ color: C.faint, fontFamily: SANS }}>No one else yet.</div>}
        </div>

        <div className="space-y-2">
          <Field label="Add someone by email"
            hint="They need an FPMS account first — have them sign up, then add the email they used.">
            <Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="name@example.in" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {ROLE_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            <Select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}>
              <option value="">No department</option>
              {DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}
            </Select>
          </div>
          {f.role === "dept_head" && !f.department && (
            <div className="text-xs" style={{ color: C.amber, fontFamily: SANS }}>
              A department head needs a department — that's what scopes their budget access.
            </div>
          )}
        </div>

        {err && <div className="text-xs" style={{ color: C.stop, fontFamily: SANS }}>{err}</div>}

        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>Done</Btn>
          <Btn variant="primary" icon={Plus} onClick={add} disabled={busy || !f.email.trim()}>Add to production</Btn>
        </div>
      </div>
    </Modal>
  );
}
