import React, { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Info, CheckCircle2, AlertTriangle, Plus, Trash2, Download, Upload, ChevronDown } from "lucide-react";
import { motion } from "framer-motion";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * DP Multi‑Timing Bandwidth Checker – modes‑first UI
 *
 * Changes requested:
 * 1) Surface "Predefined mode" on each card (not in submenu). Selecting a mode updates
 *    H/V/Hz, blanking (per generator), and updates peak_bw / peak_bw_dsc.
 * 2) Manual timing entry is moved into a collapsible submenu.
 * 3) Cards are stacked in a single column (no 2‑up grid).
 *
 * Note: Strict CVT formula fidelity is deferred; leaving a memo to implement exact
 * rounding/guard/duty later and to sync predefined_modes from Tom's list.
 */

// ----- Memo: future strictness tasks -----
// TODO(strict-CVT): implement exact CVT/CVT‑RB/RB2 generation (guard bands, duty cycle,
// rounding/quantization to pixel clock granularities), and import Tom's predefined_modes JSON.

// DP presets (per‑lane raw line rate in Gbps)
const DP_PRESETS = [
  { id: "custom", label: "Custom", rate: 8.1, coding: "8b10b" as const, lanes: 4 },
  { id: "dp20_uhbr20", label: "DP 2.0 – UHBR20 (20 Gbps ×4, 128b/132b)", rate: 20.0, coding: "128b132b" as const, lanes: 4 },
  { id: "dp20_uhbr13_5", label: "DP 2.0 – UHBR13.5 (13.5 Gbps ×4, 128b/132b)", rate: 13.5, coding: "128b132b" as const, lanes: 4 },
  { id: "dp20_uhbr10", label: "DP 2.0 – UHBR10 (10 Gbps ×4, 128b/132b)", rate: 10.0, coding: "128b132b" as const, lanes: 4 },
  { id: "dp13_hbr3", label: "DP 1.3/1.4 – HBR3 (8.1 Gbps ×4, 8b/10b)", rate: 8.1, coding: "8b10b" as const, lanes: 4 },
  { id: "dp12_hbr2", label: "DP 1.2 – HBR2 (5.4 Gbps ×4, 8b/10b)", rate: 5.4, coding: "8b10b" as const, lanes: 4 },
  { id: "dp12_hbr", label: "DP 1.1 – HBR (2.7 Gbps ×4, 8b/10b)", rate: 2.7, coding: "8b10b" as const, lanes: 4 },
  { id: "dp11_rbr", label: "DP 1.1 – RBR (1.62 Gbps ×4, 8b/10b)", rate: 1.62, coding: "8b10b" as const, lanes: 4 },
];

type Coding = "8b10b" | "128b132b";

type CvtKind = "manual" | "cvt" | "cvt_rb" | "cvt_rb2";

type PredefinedMode = { label: string; h: number; v: number; hz: number; };

const PREDEFINED_MODES: PredefinedMode[] = [
  { label: "1920×1080 @ 60",  h: 1920, v: 1080, hz:  60 },
  { label: "1920×1080 @ 144", h: 1920, v: 1080, hz: 144 },
  { label: "2560×1440 @ 60",  h: 2560, v: 1440, hz:  60 },
  { label: "2560×1440 @ 144", h: 2560, v: 1440, hz: 144 },
  { label: "3440×1440 @ 144", h: 3440, v: 1440, hz: 144 },
  { label: "3840×2160 @ 60",  h: 3840, v: 2160, hz:  60 },
  { label: "3840×2160 @ 120", h: 3840, v: 2160, hz: 120 },
  { label: "3840×2160 @ 144", h: 3840, v: 2160, hz: 144 },
  { label: "3840×2160 @ 240", h: 3840, v: 2160, hz: 240 },
  { label: "5120×1440 @ 120", h: 5120, v: 1440, hz: 120 },
];

const COLOR_FORMATS = {
  rgb: { label: "RGB", factor: 3 },
  yuv444: { label: "YUV 4:4:4", factor: 3 },
  yuv422: { label: "YUV 4:2:2", factor: 2 },
  yuv420: { label: "YUV 4:2:0", factor: 1.5 },
} as const;

type ColorFormatId = keyof typeof COLOR_FORMATS;

const DEFAULT_BPC = 8;
const DEFAULT_COLOR_FORMAT: ColorFormatId = "rgb";
const LANE_OPTIONS = [1, 2, 4] as const;




const CVT_CELL_GRAN = 8;
const CVT_HSYNC_PERCENT = 0.08;
const CVT_MIN_V_PORCH = 3;
const CVT_MIN_VSYNC_BP = 550;
const CVT_MIN_V_BPORCH = 6;
const CVT_MARGIN_PERCENT = 1.8;
const CVT_C_PRIME = 30;
const CVT_M_PRIME = 300;

type CvtProfile = Exclude<CvtKind, "manual">;

interface CvtTimingResult {
  pixelClockMHz: number;
  hTotal: number;
  vTotal: number;
  hBlank: number;
  vBlank: number;
  hFront: number;
  hSync: number;
  hBack: number;
  vFront: number;
  vSync: number;
  vBack: number;
}

function calculateCvtTiming({
  hActive,
  vActive,
  refreshHz,
  reducedBlanking,
  margins = false,
  interlaced = false,
  videoOptimized = false,
}: {
  hActive: number;
  vActive: number;
  refreshHz: number;
  reducedBlanking: CvtProfile;
  margins?: boolean;
  interlaced?: boolean;
  videoOptimized?: boolean;
}): CvtTimingResult {
  const clockParams = (() => {
    switch (reducedBlanking) {
      case "cvt":
        return { clockStep: 0.25, clockStepInv: 4, rbHBlank: 160, rbHSync: 32, rbMinVBlank: 460, rbVFrontPorch: 3, refreshMultiplier: 1 };
      case "cvt_rb":
        return { clockStep: 0.25, clockStepInv: 4, rbHBlank: 160, rbHSync: 32, rbMinVBlank: 460, rbVFrontPorch: 3, refreshMultiplier: 1 };
      case "cvt_rb2":
      default:
        return { clockStep: 0.001, clockStepInv: 1000, rbHBlank: 80, rbHSync: 32, rbMinVBlank: 460, rbVFrontPorch: 1, refreshMultiplier: videoOptimized ? 1000 / 1001 : 1 };
    }
  })();

  const cellGran = Math.floor(CVT_CELL_GRAN);
  const fieldRateRequired = interlaced ? refreshHz * 2 : refreshHz;
  const hPixelsRounded = Math.floor(hActive / cellGran) * cellGran;
  const leftMargin = margins ? Math.floor((hPixelsRounded * CVT_MARGIN_PERCENT / 100) / cellGran) * cellGran : 0;
  const totalActivePixels = hPixelsRounded + leftMargin * 2;

  const vLinesRounded = interlaced ? Math.floor(vActive / 2) : Math.floor(vActive);
  const topMargin = margins ? Math.floor(vLinesRounded * CVT_MARGIN_PERCENT / 100) : 0;
  const bottomMargin = topMargin;
  const interlaceFactor = interlaced ? 0.5 : 0;

  const verPixels = interlaced ? 2 * vLinesRounded : vLinesRounded;
  const aspectCandidates: Array<[string, number]> = [
    ["4:3", 4 / 3],
    ["16:9", 16 / 9],
    ["16:10", 16 / 10],
    ["5:4", 5 / 4],
    ["15:9", 15 / 9],
    ["43:18", 43 / 18],
    ["64:27", 64 / 27],
    ["12:5", 12 / 5],
  ];
  const aspectRatio = aspectCandidates.find(([_, ratio]) => (cellGran * Math.round(verPixels * ratio / cellGran)) === hPixelsRounded)?.[0] ?? "Unknown";

  let vSyncRounded: number;
  if (reducedBlanking === "cvt_rb2") vSyncRounded = 8;
  else if (aspectRatio === "4:3") vSyncRounded = 4;
  else if (aspectRatio === "16:9") vSyncRounded = 5;
  else if (aspectRatio === "16:10") vSyncRounded = 6;
  else if (aspectRatio === "5:4") vSyncRounded = 7;
  else if (aspectRatio === "15:9") vSyncRounded = 7;
  else vSyncRounded = 10;

  let hBlank: number;
  let hFrontPorch: number;
  let hSync: number;
  let hBackPorch: number;
  let vFrontPorch: number;
  let vBackPorch: number;
  let vBlank: number;
  let totalPixels: number;
  let totalVLines: number;
  let pixelClockMHz: number;

  if (reducedBlanking === "cvt") {
    const hPeriodEst = ((1 / fieldRateRequired) - CVT_MIN_VSYNC_BP / 1_000_000) / (vLinesRounded + (2 * topMargin) + CVT_MIN_V_PORCH + interlaceFactor) * 1_000_000;

    let vSyncBackPorch = Math.floor(CVT_MIN_VSYNC_BP / hPeriodEst) + 1;
    if (vSyncBackPorch < (vSyncRounded + CVT_MIN_V_BPORCH)) {
      vSyncBackPorch = vSyncRounded + CVT_MIN_V_BPORCH;
    }

    vBlank = vSyncBackPorch + CVT_MIN_V_PORCH;
    vFrontPorch = CVT_MIN_V_PORCH;
    vBackPorch = vSyncBackPorch - vSyncRounded;

    totalVLines = vLinesRounded + topMargin + bottomMargin + vSyncBackPorch + interlaceFactor + CVT_MIN_V_PORCH;

    const idealDutyCycle = CVT_C_PRIME - (CVT_M_PRIME * hPeriodEst / 1000);
    const minDutyCycle = 20;
    if (idealDutyCycle < minDutyCycle) {
      hBlank = Math.floor(totalActivePixels * minDutyCycle / (100 - minDutyCycle) / (2 * cellGran)) * (2 * cellGran);
    } else {
      hBlank = Math.floor(totalActivePixels * idealDutyCycle / (100 - idealDutyCycle) / (2 * cellGran)) * (2 * cellGran);
    }

    totalPixels = totalActivePixels + hBlank;

    hSync = Math.floor(CVT_HSYNC_PERCENT * totalPixels / cellGran) * cellGran;
    hBackPorch = hBlank / 2;
    hFrontPorch = hBlank - hSync - hBackPorch;

    pixelClockMHz = clockParams.clockStep * Math.floor(totalPixels / hPeriodEst / clockParams.clockStep);
  } else {
    const hPeriodEst = ((1_000_000 / fieldRateRequired) - clockParams.rbMinVBlank) / (vLinesRounded + topMargin + bottomMargin);
    hBlank = clockParams.rbHBlank;

    const vbiLines = Math.floor(clockParams.rbMinVBlank / hPeriodEst) + 1;
    const rbMinVbi = clockParams.rbVFrontPorch + vSyncRounded + CVT_MIN_V_BPORCH;
    const activeVbiLines = vbiLines < rbMinVbi ? rbMinVbi : vbiLines;

    vBlank = activeVbiLines;
    totalVLines = activeVbiLines + vLinesRounded + topMargin + bottomMargin + interlaceFactor;
    totalPixels = totalActivePixels + clockParams.rbHBlank;

    pixelClockMHz = Math.floor(fieldRateRequired * totalVLines * totalPixels * clockParams.clockStepInv / 1_000_000) * clockParams.refreshMultiplier / clockParams.clockStepInv;

    if (reducedBlanking === "cvt_rb2") {
      vFrontPorch = activeVbiLines - vSyncRounded - 6;
      vBackPorch = 6;
      hSync = clockParams.rbHSync;
      hBackPorch = 40;
      hFrontPorch = hBlank - hSync - hBackPorch;
    } else {
      vFrontPorch = 3;
      vBackPorch = activeVbiLines - vFrontPorch - vSyncRounded;
      hSync = clockParams.rbHSync;
      hBackPorch = 80;
      hFrontPorch = hBlank - hSync - hBackPorch;
    }
  }

  return {
    pixelClockMHz,
    hTotal: Math.round(totalPixels),
    vTotal: Math.round(totalVLines),
    hBlank: Math.round(hBlank),
    vBlank: Math.round(vBlank),
    hFront: Math.round(hFrontPorch),
    hSync: Math.round(hSync),
    hBack: Math.round(hBackPorch),
    vFront: Math.round(vFrontPorch),
    vSync: Math.round(vSyncRounded),
    vBack: Math.round(vBackPorch),
  };
}

function codingEfficiency(coding: Coding) { return coding === "8b10b" ? 0.8 : 128/132; }
function clamp(n:number, lo:number, hi:number){ return Math.max(lo, Math.min(hi,n)); }

interface TimingRow {
  id: string; label: string; peakBw: string; peakBwDsc: string; useDsc: boolean;
  calcOpen?: boolean; modeIndex?: number; cvtKind?: CvtKind;
  h?: number; v?: number; hz?: number;
  hFront?: number; hSync?: number; hBack?: number;
  vFront?: number; vSync?: number; vBack?: number;
  bpp?: number; dscRatio?: number; // 3 or 2.4
  bpc?: number; colorFormat?: ColorFormatId;
  pixelClock?: number;
}

const DEFAULT_PRESET_TIMING = calculateCvtTiming({
  hActive: 3840,
  vActive: 2160,
  refreshHz: 144,
  reducedBlanking: "cvt_rb2",
});

const defaultCalc: Partial<TimingRow> = {
  calcOpen: false,
  modeIndex: 0,
  cvtKind: "cvt_rb2",
  h: 3840,
  v: 2160,
  hz: 144,
  hFront: DEFAULT_PRESET_TIMING.hFront,
  hSync: DEFAULT_PRESET_TIMING.hSync,
  hBack: DEFAULT_PRESET_TIMING.hBack,
  vFront: DEFAULT_PRESET_TIMING.vFront,
  vSync: DEFAULT_PRESET_TIMING.vSync,
  vBack: DEFAULT_PRESET_TIMING.vBack,
  bpc: DEFAULT_BPC,
  colorFormat: DEFAULT_COLOR_FORMAT,
  bpp: DEFAULT_BPC * COLOR_FORMATS[DEFAULT_COLOR_FORMAT].factor,
  dscRatio: 3,
  pixelClock: DEFAULT_PRESET_TIMING.pixelClockMHz,
};

const emptyTiming = (i: number): TimingRow => ({ id: `${Date.now()}_${i}`, label: `Timing ${i+1}`, peakBw:"", peakBwDsc:"", useDsc:true, ...defaultCalc });

function pixelClockMHzFromTotals(
  h:number, v:number, hz:number,
  hFront:number, hSync:number, hBack:number,
  vFront:number, vSync:number, vBack:number
){
  const hTotal = h + hFront + hSync + hBack;
  const vTotal = v + vFront + vSync + vBack;
  return (hTotal * vTotal * hz) / 1e6;
}

function streamGbpsFromClock(clockMHz:number, bpp:number){
  return (clockMHz * 1e6 * bpp) / 1e9;
}

function utilColor(fits:boolean, marginPct:number){
  if(!fits) return "bg-red-500";
  if(marginPct < 10) return "bg-amber-400";
  return "bg-emerald-500";
}

export default function App(){
  const [timings, setTimings] = useState<TimingRow[]>([emptyTiming(0)]);
  const [presetId, setPresetId] = useState<string>("dp13_hbr3");
  const preset = useMemo(()=> DP_PRESETS.find(p=>p.id===presetId) || DP_PRESETS[0], [presetId]);
  const [lanes, setLanes] = useState<number>(preset.lanes);
  const [rate, setRate] = useState<number>(preset.rate);
  const [coding, setCoding] = useState<Coding>(preset.coding);

  React.useEffect(()=>{ setRate(preset.rate); setCoding(preset.coding); setLanes(preset.lanes); },[presetId]);

  const eff = codingEfficiency(coding);
  const rawCapacityGbps = rate * lanes;
  const payloadCapacityGbps = rawCapacityGbps * eff;

  const parsed = timings.map(t=>({ ...t, peak: Number(t.peakBw)||0, peakDsc: Number(t.peakBwDsc)||0 }));
  const totalGbps = parsed.reduce((s,t)=> s + (t.useDsc ? t.peakDsc : t.peak), 0);
  const fits = totalGbps <= payloadCapacityGbps + 1e-9;
  const margin = payloadCapacityGbps - totalGbps;
  const marginPct = payloadCapacityGbps>0 ? (margin/payloadCapacityGbps)*100 : 0;
  const utilPct = clamp((totalGbps/Math.max(payloadCapacityGbps,1e-6))*100, 0, 100);
  const barColor = utilColor(fits, marginPct);

  const chartRows = parsed.map((t, index) => ({
    name: t.label || Timing ,
    selected: t.useDsc ? t.peakDsc : t.peak,
    raw: t.peak,
  }));
  const chartData = chartRows.length ? chartRows : [{ name: 'Timing 1', selected: 0, raw: 0 }];
  const chartPeak = chartData.reduce((max, row) => Math.max(max, row.selected, row.raw), 0);
  const chartDomainUpper = chartPeak > 0 || payloadCapacityGbps > 0
    ? Math.max(chartPeak, payloadCapacityGbps) * 1.1
    : 1;

  const updateTiming = (id:string, patch:Partial<TimingRow>)=> setTimings(ts=> ts.map(t=> t.id===id ? ({...t, ...patch}) : t));
  const addTiming = ()=> { if(timings.length<4) setTimings(ts=>[...ts, emptyTiming(ts.length)]); };
  const removeTiming = (id:string)=> setTimings(ts=> ts.filter(t=> t.id!==id));

  // When a mode is chosen, set H/V/Hz and refresh blanking by current generator, then compute and fill peaks.
  function onChooseMode(t:TimingRow, modeIdx:number){
    const m = PREDEFINED_MODES[modeIdx];
    const kind = (t.cvtKind || "cvt_rb2") as CvtKind;

    const bpc = Number(t.bpc) || DEFAULT_BPC;
    const colorFormat = (t.colorFormat || DEFAULT_COLOR_FORMAT) as ColorFormatId;
    const formatInfo = COLOR_FORMATS[colorFormat] ?? COLOR_FORMATS[DEFAULT_COLOR_FORMAT];
    const ratio = t.dscRatio && t.dscRatio > 0 ? t.dscRatio : 3;

    let timingResult: CvtTimingResult | null = null;
    if (kind !== "manual") {
      timingResult = calculateCvtTiming({
        hActive: m.h,
        vActive: m.v,
        refreshHz: m.hz,
        reducedBlanking: kind as CvtProfile,
      });
    }

    const hFront = timingResult ? timingResult.hFront : (t.hFront ?? 8);
    const hSync = timingResult ? timingResult.hSync : (t.hSync ?? 32);
    const hBack = timingResult ? timingResult.hBack : (t.hBack ?? 120);
    const vFront = timingResult ? timingResult.vFront : (t.vFront ?? 3);
    const vSync = timingResult ? timingResult.vSync : (t.vSync ?? 6);
    const vBack = timingResult ? timingResult.vBack : (t.vBack ?? 9);
    const pixelClock = timingResult
      ? timingResult.pixelClockMHz
      : pixelClockMHzFromTotals(m.h, m.v, m.hz, hFront, hSync, hBack, vFront, vSync, vBack);

    const bpp = bpc * formatInfo.factor;
    const peak = streamGbpsFromClock(pixelClock, bpp);
    const peakDsc = peak / ratio;

    updateTiming(t.id, {
      modeIndex: modeIdx,
      h: m.h,
      v: m.v,
      hz: m.hz,
      hFront,
      hSync,
      hBack,
      vFront,
      vSync,
      vBack,
      bpc,
      colorFormat,
      bpp,
      dscRatio: ratio,
      pixelClock,
      peakBw: peak.toFixed(4),
      peakBwDsc: peakDsc.toFixed(4),
    });
  }

  // Manual recompute based on current fields (inside submenu)
  function computeAndFill(id:string){
    setTimings(ts=> ts.map(t=>{
      if(t.id!==id) return t;
      const h = Number(t.h) || 1920;
      const v = Number(t.v) || 1080;
      const hz = Number(t.hz) || 60;
      const kind = (t.cvtKind || "cvt_rb2") as CvtKind;

      const bpc = Number(t.bpc) || DEFAULT_BPC;
      const colorFormat = (t.colorFormat || DEFAULT_COLOR_FORMAT) as ColorFormatId;
      const formatInfo = COLOR_FORMATS[colorFormat] ?? COLOR_FORMATS[DEFAULT_COLOR_FORMAT];
      const ratio = t.dscRatio && t.dscRatio > 0 ? t.dscRatio : 3;

      let hFront: number;
      let hSync: number;
      let hBack: number;
      let vFront: number;
      let vSync: number;
      let vBack: number;
      let pixelClock: number;

      if (kind === "manual") {
        hFront = Number(t.hFront) || 8;
        hSync = Number(t.hSync) || 32;
        hBack = Number(t.hBack) || 120;
        vFront = Number(t.vFront) || 3;
        vSync = Number(t.vSync) || 6;
        vBack = Number(t.vBack) || 9;
        pixelClock = pixelClockMHzFromTotals(h, v, hz, hFront, hSync, hBack, vFront, vSync, vBack);
      } else {
        const result = calculateCvtTiming({
          hActive: h,
          vActive: v,
          refreshHz: hz,
          reducedBlanking: kind as CvtProfile,
        });
        hFront = result.hFront;
        hSync = result.hSync;
        hBack = result.hBack;
        vFront = result.vFront;
        vSync = result.vSync;
        vBack = result.vBack;
        pixelClock = result.pixelClockMHz;
      }

      const bpp = bpc * formatInfo.factor;
      const peak = streamGbpsFromClock(pixelClock, bpp);
      const peakDsc = peak / ratio;

      return {
        ...t,
        h,
        v,
        hz,
        hFront,
        hSync,
        hBack,
        vFront,
        vSync,
        vBack,
        bpc,
        colorFormat,
        bpp,
        dscRatio: ratio,
        pixelClock,
        peakBw: peak.toFixed(4),
        peakBwDsc: peakDsc.toFixed(4),
      };
    }));
  }

  const exportJson = ()=>{
    const data = { timings: parsed.map(({id,label,peakBw,peakBwDsc,useDsc,...rest})=>({id,label,peakBw,peakBwDsc,useDsc,...rest})), transport:{rate,lanes,coding,eff}, presetId };
    const blob = new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href=url; a.download="dp_multi_timing_config.json"; a.click(); URL.revokeObjectURL(url);
  };

  const onImport = (e:React.ChangeEvent<HTMLInputElement>)=>{
    const file = e.target.files?.[0]; if(!file) return; const r=new FileReader();
    r.onload = ()=>{ try{ const j=JSON.parse(String(r.result||"{}")); if(Array.isArray(j.timings)){
      const restored:TimingRow[] = j.timings.map((t:any,i:number)=>{
        const importedFormat = typeof t.colorFormat === "string" && t.colorFormat in COLOR_FORMATS ? (t.colorFormat as ColorFormatId) : DEFAULT_COLOR_FORMAT;
        const rawBpc = Number(t.bpc);
        const bpc = Number.isFinite(rawBpc) && rawBpc > 0 ? rawBpc : DEFAULT_BPC;
        const formatInfo = COLOR_FORMATS[importedFormat] ?? COLOR_FORMATS[DEFAULT_COLOR_FORMAT];
        const rawBpp = Number(t.bpp);
        const bpp = Number.isFinite(rawBpp) && rawBpp > 0 ? rawBpp : bpc * formatInfo.factor;

        const h = Number(t.h);
        const v = Number(t.v);
        const hz = Number(t.hz);
        const hFront = Number(t.hFront);
        const hSync = Number(t.hSync);
        const hBack = Number(t.hBack);
        const vFront = Number(t.vFront);
        const vSync = Number(t.vSync);
        const vBack = Number(t.vBack);

        const hasTotals = [h, v, hz, hFront, hSync, hBack, vFront, vSync, vBack].every((value) => Number.isFinite(value));
        const rawPixelClock = Number(t.pixelClock);
        const computedPixelClock = hasTotals
          ? pixelClockMHzFromTotals(
              h as number,
              v as number,
              hz as number,
              hFront as number,
              hSync as number,
              hBack as number,
              vFront as number,
              vSync as number,
              vBack as number
            )
          : undefined;
        const pixelClock = Number.isFinite(rawPixelClock) && rawPixelClock > 0 ? rawPixelClock : computedPixelClock;

        return {
          id: t.id || `${Date.now()}_${i}`,
          label: String(t.label ?? `Timing ${i + 1}`),
          peakBw: String(t.peakBw ?? ""),
          peakBwDsc: String(t.peakBwDsc ?? ""),
          useDsc: Boolean(t.useDsc),
          calcOpen: Boolean(t.calcOpen),
          modeIndex: typeof t.modeIndex === 'number' ? t.modeIndex : 0,
          cvtKind: t.cvtKind || "cvt_rb2",
          h: Number.isFinite(h) ? (h as number) : undefined,
          v: Number.isFinite(v) ? (v as number) : undefined,
          hz: Number.isFinite(hz) ? (hz as number) : undefined,
          hFront: Number.isFinite(hFront) ? (hFront as number) : undefined,
          hSync: Number.isFinite(hSync) ? (hSync as number) : undefined,
          hBack: Number.isFinite(hBack) ? (hBack as number) : undefined,
          vFront: Number.isFinite(vFront) ? (vFront as number) : undefined,
          vSync: Number.isFinite(vSync) ? (vSync as number) : undefined,
          vBack: Number.isFinite(vBack) ? (vBack as number) : undefined,
          bpp,
          bpc,
          colorFormat: importedFormat,
          dscRatio: t.dscRatio,
          pixelClock,
        };
      }).slice(0,4);
      setTimings(restored.length? restored : [emptyTiming(0)]);
    }
    if(j.transport){
      setRate(Number(j.transport.rate)||rate);
      const importedLanes = Number(j.transport.lanes);
      const laneOption = LANE_OPTIONS.includes(importedLanes as (typeof LANE_OPTIONS)[number]) ? importedLanes : LANE_OPTIONS[LANE_OPTIONS.length-1];
      setLanes(laneOption);
      setCoding(j.transport.coding==="8b10b"?"8b10b":"128b/132b" as any);
    }
    if(typeof j.presetId==="string") setPresetId(j.presetId); } catch(err){ alert("Invalid JSON file."); } };
    r.readAsText(file); e.target.value="";
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 text-slate-800">
      <div className="max-w-3xl mx-auto p-6">
        <motion.h1 initial={{opacity:0,y:-6}} animate={{opacity:1,y:0}} className="text-3xl md:text-4xl font-bold tracking-tight">DP Multi‑Timing Bandwidth Checker</motion.h1>
        <p className="mt-2 text-sm text-slate-600 flex items-start gap-2"><Info className="w-4 h-4 mt-0.5"/>Pick modes first; manual overrides live in the submenu. Up to 4 timings, stacked vertically.</p>

        {/* Transport */}
        <Card className="mt-6 rounded-2xl shadow-sm"><CardContent className="p-5 grid gap-4">
          <div className="text-sm font-semibold uppercase tracking-wide text-slate-500">DisplayPort Link</div>
          <div className="grid gap-3">
            <div>
              <label className="text-sm font-medium">Transport preset</label>
              <Select value={presetId} onValueChange={setPresetId}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Select preset"/></SelectTrigger>
                <SelectContent>{DP_PRESETS.map(p=>(<SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>))}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-3 items-end">
              <div>
                <label className="text-sm font-medium">Lanes</label>
                <Select value={String(lanes)} onValueChange={(value)=>setLanes(Number(value))}>
                  <SelectTrigger className="mt-1"><SelectValue/></SelectTrigger>
                  <SelectContent>
                    {LANE_OPTIONS.map(option => (
                      <SelectItem key={option} value={String(option)}>
                        {option} Lane{option > 1 ? "s" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div><label className="text-sm font-medium">Per‑lane rate (Gbps)</label><Input type="number" step="0.01" className="mt-1" value={rate} onChange={e=>setRate(Number(e.target.value)||0)}/></div>
              <div>
                <label className="text-sm font-medium">Coding</label>
                <Select value={coding} onValueChange={(v:any)=>setCoding(v)}>
                  <SelectTrigger className="mt-1"><SelectValue/></SelectTrigger>
                  <SelectContent><SelectItem value="8b10b">8b/10b</SelectItem><SelectItem value="128b132b">128b/132b</SelectItem></SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-3 text-sm">
            <div className="p-3 rounded-xl bg-white border"><div className="font-medium">Raw line rate</div><div className="text-2xl font-bold">{rawCapacityGbps.toFixed(2)} <span className="text-base font-medium">Gbps</span></div><div className="text-slate-500">{rate.toFixed(2)} × {lanes} lanes</div></div>
            <div className="p-3 rounded-xl bg-white border"><div className="font-medium">Coding efficiency</div><div className="text-2xl font-bold">{(eff*100).toFixed(2)}%</div><div className="text-slate-500">{coding==="8b10b"?"8b/10b (×0.8)":"128b/132b (×128/132)"}</div></div>
            <div className="p-3 rounded-xl bg-white border"><div className="font-medium">Usable payload</div><div className="text-2xl font-bold">{payloadCapacityGbps.toFixed(2)} <span className="text-base font-medium">Gbps</span></div><div className="text-slate-500">After line‑coding overhead</div></div>
          </div>
        </CardContent></Card>
        <div className="my-8 border-t border-slate-200" />

        {/* Timings (stacked) */}
        <div className="mt-6 grid grid-cols-1 gap-4">
          {timings.map((t)=> {
            const activeH = Number(t.h) || 0;
            const activeV = Number(t.v) || 0;
            const refreshValue = Number(t.hz) || 0;
            const frontPorchH = Number(t.hFront) || 0;
            const syncWidthH = Number(t.hSync) || 0;
            const backPorchH = Number(t.hBack) || 0;
            const frontPorchV = Number(t.vFront) || 0;
            const syncWidthV = Number(t.vSync) || 0;
            const backPorchV = Number(t.vBack) || 0;
            const pixelClockRaw = typeof t.pixelClock === "number" ? t.pixelClock : undefined;
            const derivedPixelClock = pixelClockRaw ?? (activeH > 0 && activeV > 0 && refreshValue > 0
              ? pixelClockMHzFromTotals(
                  activeH,
                  activeV,
                  refreshValue,
                  frontPorchH,
                  syncWidthH,
                  backPorchH,
                  frontPorchV,
                  syncWidthV,
                  backPorchV
                )
              : undefined);
            const normalizedPixelClock = typeof derivedPixelClock === "number" && Number.isFinite(derivedPixelClock) && derivedPixelClock > 0
              ? derivedPixelClock
              : undefined;
            const pixelClockText = normalizedPixelClock ? `${normalizedPixelClock.toFixed(3)} MHz` : "—";
            return (
              <motion.div key={t.id} initial={{opacity:0,y:6}} animate={{opacity:1,y:0}}>
              <Card className="rounded-2xl shadow-sm"><CardContent className="p-5 grid gap-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">{t.label}</div>
                  <div className="flex items-center gap-2">
                    <Switch checked={t.useDsc} onCheckedChange={v=>updateTiming(t.id,{useDsc:v})}/>
                    <span className="text-xs text-slate-600">Use DSC value</span>
                    <Button size="icon" variant="ghost" onClick={()=>updateTiming(t.id,{calcOpen:!t.calcOpen})}><ChevronDown className={`w-4 h-4 transition-transform ${t.calcOpen? 'rotate-180':''}`}/></Button>
                    <Button size="icon" variant="ghost" onClick={()=>removeTiming(t.id)} disabled={timings.length<=1}><Trash2 className="w-4 h-4"/></Button>
                  </div>
                </div>

                {/* Modes-first row */}
                <div className="grid md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium">Predefined mode</label>
                    <Select value={String(t.modeIndex??0)} onValueChange={(v)=> onChooseMode(t, Number(v))}>
                      <SelectTrigger className="mt-1"><SelectValue/></SelectTrigger>
                      <SelectContent>{PREDEFINED_MODES.map((m,i)=>(<SelectItem key={i} value={String(i)}>{m.label}</SelectItem>))}</SelectContent>
                    </Select>
                    <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-slate-600">
                      <div><div className="font-medium">Pixel clock</div><div>{pixelClockText}</div></div>
                      <div><div className="font-medium">H blank</div><div>{(t.hFront??0)+(t.hSync??0)+(t.hBack??0)} px</div></div>
                      <div><div className="font-medium">V blank</div><div>{(t.vFront??0)+(t.vSync??0)+(t.vBack??0)} lines</div></div>
                      <div><div className="font-medium">Gen</div><div>{t.cvtKind||'cvt_rb2'}</div></div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium">Peak BW (Gbps)</label>
                      <Input className="mt-1" type="number" step="0.01" value={t.peakBw} onChange={e=>updateTiming(t.id,{peakBw:e.target.value})} />
                    </div>
                    <div>
                      <label className="text-xs font-medium">Peak BW w/ DSC (Gbps)</label>
                      <Input className="mt-1" type="number" step="0.01" value={t.peakBwDsc} onChange={e=>updateTiming(t.id,{peakBwDsc:e.target.value})} />
                    </div>
                  </div>
                </div>

                {/* Manual submenu */}
                {t.calcOpen && (
                  <div className="mt-2 p-3 rounded-xl border bg-slate-50 grid gap-2 text-xs">
                    <div className="grid md:grid-cols-3 gap-2">
                      <div>
                        <label className="font-medium">Generator</label>
                        <Select value={t.cvtKind||"cvt_rb2"} onValueChange={(v:any)=>{
                          const next: CvtKind = v as CvtKind; updateTiming(t.id,{cvtKind: next});
                          // If a mode is already chosen, reapply its H/V/Hz with new template blanking
                          if(typeof t.modeIndex === 'number') onChooseMode({...t, cvtKind: next}, t.modeIndex);
                        }}>
                          <SelectTrigger className="mt-1"><SelectValue/></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="manual">Manual totals</SelectItem>
                            <SelectItem value="cvt">CVT</SelectItem>
                            <SelectItem value="cvt_rb">CVT-RB</SelectItem>
                            <SelectItem value="cvt_rb2">CVT-RB2</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div><label className="font-medium">H</label><Input className="mt-1" type="number" value={t.h??3840} onChange={e=>updateTiming(t.id,{h:Number(e.target.value)||0})}/></div>
                        <div><label className="font-medium">V</label><Input className="mt-1" type="number" value={t.v??2160} onChange={e=>updateTiming(t.id,{v:Number(e.target.value)||0})}/></div>
                        <div><label className="font-medium">Hz</label><Input className="mt-1" type="number" step="0.01" value={t.hz??144} onChange={e=>updateTiming(t.id,{hz:Number(e.target.value)||0})}/></div>
                      </div>
                      <div className="grid md:grid-cols-3 gap-2">
                        <div>
                          <label className="font-medium">Bits per component (bpc)</label>
                          <Select value={String(t.bpc ?? DEFAULT_BPC)} onValueChange={(value)=>{
                            const nextBpc = Number(value) || DEFAULT_BPC;
                            const formatKey = (t.colorFormat || DEFAULT_COLOR_FORMAT) as ColorFormatId;
                            const formatInfo = COLOR_FORMATS[formatKey] ?? COLOR_FORMATS[DEFAULT_COLOR_FORMAT];
                            updateTiming(t.id,{ bpc: nextBpc, bpp: nextBpc * formatInfo.factor });
                          }}>
                            <SelectTrigger className="mt-1"><SelectValue/></SelectTrigger>
                            <SelectContent>
                              {[5,6,8,10,12,16].map(option=> (<SelectItem key={option} value={String(option)}>{option}-bit</SelectItem>))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className="font-medium">Color format</label>
                          <Select value={(t.colorFormat || DEFAULT_COLOR_FORMAT) as string} onValueChange={(value)=>{
                            const formatKey = (value as ColorFormatId);
                            const bpc = Number(t.bpc) || DEFAULT_BPC;
                            const formatInfo = COLOR_FORMATS[formatKey] ?? COLOR_FORMATS[DEFAULT_COLOR_FORMAT];
                            updateTiming(t.id,{ colorFormat: formatKey, bpp: bpc * formatInfo.factor });
                          }}>
                            <SelectTrigger className="mt-1"><SelectValue/></SelectTrigger>
                            <SelectContent>
                              {Object.entries(COLOR_FORMATS).map(([key, info]) => (<SelectItem key={key} value={key}>{info.label}</SelectItem>))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className="font-medium">DSC ratio</label>
                          <Select value={String(t.dscRatio??3)} onValueChange={(v)=> updateTiming(t.id,{ dscRatio: Number(v) })}>
                            <SelectTrigger className="mt-1"><SelectValue/></SelectTrigger>
                            <SelectContent>
                              <SelectItem value={String(3)}>3:1</SelectItem>
                              <SelectItem value={String(2.4)}>2.4:1</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>

                    <div className="grid md:grid-cols-3 gap-2">
                      <div className="grid grid-cols-3 gap-2">
                        <div><label>H fp</label><Input className="mt-1" type="number" value={t.hFront??8} onChange={e=>updateTiming(t.id,{hFront:Number(e.target.value)||0})}/></div>
                        <div><label>H sync</label><Input className="mt-1" type="number" value={t.hSync??32} onChange={e=>updateTiming(t.id,{hSync:Number(e.target.value)||0})}/></div>
                        <div><label>H back</label><Input className="mt-1" type="number" value={t.hBack??120} onChange={e=>updateTiming(t.id,{hBack:Number(e.target.value)||0})}/></div>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div><label>V fp</label><Input className="mt-1" type="number" value={t.vFront??3} onChange={e=>updateTiming(t.id,{vFront:Number(e.target.value)||0})}/></div>
                        <div><label>V sync</label><Input className="mt-1" type="number" value={t.vSync??6} onChange={e=>updateTiming(t.id,{vSync:Number(e.target.value)||0})}/></div>
                        <div><label>V back</label><Input className="mt-1" type="number" value={t.vBack??9} onChange={e=>updateTiming(t.id,{vBack:Number(e.target.value)||0})}/></div>
                      </div>
                      <div className="flex items-end justify-end">
                        <Button size="sm" variant="secondary" onClick={()=>computeAndFill(t.id)}>Recompute</Button>
                      </div>
                    </div>
                  </div>
                )}

                <div className="text-xs text-slate-600">Using: <span className="font-medium">{t.useDsc ? (Number(t.peakBwDsc)||0).toFixed(2) : (Number(t.peakBw)||0).toFixed(2)} Gbps</span></div>
              </CardContent></Card>
            </motion.div>
          );
        })}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={addTiming} disabled={timings.length>=4}><Plus className="w-4 h-4 mr-1"/> Add timing</Button>
          <div className="flex items-center gap-2 ml-auto">
            <Button variant="outline" onClick={exportJson}><Download className="w-4 h-4 mr-1"/> Export JSON</Button>
            <label className="inline-flex items-center">
              <input type="file" accept="application/json" onChange={onImport} className="hidden" id="import-json"/>
              <Button variant="outline" asChild>
                <span><label htmlFor="import-json" className="cursor-pointer flex items-center"><Upload className="w-4 h-4 mr-1"/> Import JSON</label></span>
              </Button>
            </label>
          </div>
        </div>

        {/* Summary */}
        <Card className="mt-6 rounded-2xl shadow-sm border-2">
          <CardContent className="p-5 grid gap-5">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">{fits ? (<CheckCircle2 className="w-6 h-6 text-emerald-600"/>) : (<AlertTriangle className="w-6 h-6 text-amber-500"/>) }<div className="text-xl font-semibold">{fits?"Fits within selected DP payload":"Exceeds selected DP payload"}</div></div>
              <div className="grid gap-3 text-sm md:grid-cols-3">
                <div className="rounded-xl border bg-white p-3"><div className="font-medium">Total required (selected)</div><div className={`text-2xl font-bold ${fits?"":"text-red-600"}`}>{totalGbps.toFixed(2)} <span className="text-base font-medium">Gbps</span></div><div className="text-slate-500">Sum of chosen peak_bw / peak_bw_dsc</div></div>
                <div className="rounded-xl border bg-white p-3"><div className="font-medium">Payload capacity</div><div className="text-2xl font-bold">{payloadCapacityGbps.toFixed(2)} <span className="text-base font-medium">Gbps</span></div><div className="text-slate-500">Rate × lanes × coding efficiency</div></div>
                <div className="rounded-xl border bg-white p-3"><div className="font-medium">Margin</div><div className={`text-2xl font-bold ${margin<0?"text-red-600":""}`}>{margin.toFixed(2)} <span className="text-base font-medium">Gbps</span></div><div className="text-slate-500">{marginPct.toFixed(1)}% of capacity</div></div>
              </div>
            </div>

            <div className="rounded-xl border bg-white p-4 text-xs text-slate-600">
              <div className="font-semibold text-slate-500">Utilization</div>
              <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-slate-200">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${utilPct}%` }}
                  className={`h-full ${barColor}`}
                  transition={{ type: "spring", stiffness: 140, damping: 18 }}
                />
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-slate-500">
                <span>{utilPct.toFixed(1)}% used</span>
                <span>{margin.toFixed(2)} Gbps slack</span>
              </div>
              <div className="mt-3 leading-relaxed text-[11px] text-slate-500">
                <p className="mb-1">Assumes only line coding overhead. Protocol framing is ignored.</p>
                <p>Adjust lanes when modeling eDP or MST shares.</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <div className="mt-8 text-center text-xs text-slate-500">Built for quick feasibility checks.</div>
      </div>
    </div>
  );
}

// ---------------------------
// Lightweight runtime tests (no external deps)
// ---------------------------
if(typeof window!=="undefined"){
  // RB <= CVT and RB2 <= RB1 clock monotonicity
  const clk1 = pixelClockMHzFromTotals(1920,1080,60,88,44,148,4,5,36);
  const clk2 = pixelClockMHzFromTotals(1920,1080,60,48,32,80,3,6,33);
  const clk3 = pixelClockMHzFromTotals(1920,1080,60,8,32,120,3,6,9);
  console.assert(clk2 < clk1 && clk3 <= clk2, "RB clocks monotonicity", clk1, clk2, clk3);

  const gb1 = streamGbpsFromClock(148.5,24); const gb2 = gb1/3; const gb3 = gb1/2.4;
  console.assert(gb2 < gb1 && gb3 < gb1, "DSC reduces bandwidth");

  console.assert(utilColor(false,50)==='bg-red-500', 'Color: over capacity');
  console.assert(utilColor(true,5)==='bg-amber-400', 'Color: low margin');
  console.assert(utilColor(true,20)==='bg-emerald-500', 'Color: healthy');
}
