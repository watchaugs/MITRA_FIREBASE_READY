'use strict';
// ════════════════════════════════════════════════════════════════════════════
// lib/summary_report.js — MITRA light summary workbook engine (themed, 16 sheets)
//
// Pure formatter: takes ONE scope's pre-computed aggregates + benchmarks, returns
// an .xlsx Buffer. No BigQuery / Firestore here — Refresh computes the numbers.
// Static values only, no RAW sheets, no formulas → cannot hit Excel row limits.
//
// Styling: navy + India-tricolor theme, KPI tiles, insight callouts, data bars,
// red→green color-scales, green/red verdicts, dense full-width tables, landscape.
//
// DATA CONTRACT (per scope) — see buildMock() at bottom for the exact shape.
// ════════════════════════════════════════════════════════════════════════════
const ExcelJS = require('exceljs');

// palette (ARGB)
const NAVY='FF1F3864', BLUE='FF2E5090', LTBLUE='FFD9E2F3', ZEBRA='FFEEF3FB',
      SAFFRON='FFE8820C', SAFF_L='FFFFF4E0', GREEN='FF0E7A4B', TEAL='FF0F766E',
      INK='FF1F2937', GREY='FF6B7280', WHITE='FFFFFFFF',
      POS_F='FFD6F5E3', POS_T='FF0E7A4B', NEG_F='FFFCE4E4', NEG_T='FF9C1C1C', NA_T='FF9AA3AF',
      GREEN_L='FFE8F7EE', YEL_L='FFFEF7E0', RED_L='FFFDECEC';
const TILE=[NAVY,SAFFRON,GREEN,BLUE,TEAL];
const IND='[>=10000000]#\\,##\\,##\\,##0;[>=100000]#\\,##\\,##0;#,##0';

const f=(o)=>Object.assign({name:'Calibri'},o);
const solid=(argb)=>({type:'pattern',pattern:'solid',fgColor:{argb}});
const bd=()=>{const s={style:'thin',color:{argb:'FFC7D0E0'}};return{top:s,left:s,right:s,bottom:s};};
const CTR={horizontal:'center',vertical:'middle',wrapText:true};
const LFT={horizontal:'left',vertical:'middle'};
const col=(i)=>{let s='';i++;while(i>0){const m=(i-1)%26;s=String.fromCharCode(65+m)+s;i=Math.floor((i-1)/26);}return s;};

function fmtNum(value,unit){
  if(value==null)return null;
  if(unit==='pct')return value/100;
  return value;
}
function numFmtFor(unit){
  if(unit==='pct')return '0.0%';
  if(unit==='min')return '0.0" min"';
  if(unit==='int')return IND;
  if(unit==='num')return '0.00';
  return null;
}
function meets(value,target){
  if(!target||target==='—'||value==null)return '—';
  const m=String(target).match(/(≥|>=|<=|<|>)\s*([\d.]+)/);
  if(!m)return '—';
  const op=m[1],t=parseFloat(m[2]);
  if(op==='≥'||op==='>=')return value>=t?'✓':'✗';
  if(op==='<=')return value<=t?'✓':'✗';
  if(op==='<')return value<t?'✓':'✗';
  if(op==='>')return value>t?'✓':'✗';
  return '—';
}

function newSheet(wb,name,cspan){
  const ws=wb.addWorksheet(name,{
    views:[{showGridLines:false}],
    pageSetup:{orientation:'landscape',fitToWidth:1,fitToHeight:0,
      margins:{left:0.3,right:0.3,top:0.4,bottom:0.4,header:0.2,footer:0.2}},
    properties:{}
  });
  ws.pageSetup.fitToPage=true;
  ws._cspan=cspan;
  return ws;
}
function tri(ws,r,cspan){
  const third=Math.max(1,Math.floor(cspan/3));
  for(let i=0;i<cspan;i++){
    ws.getCell(r,i+1).fill=solid(i<third?SAFFRON:(i<2*third?WHITE:GREEN));
  }
  ws.getRow(r).height=5;
}
function title(ws,text,scope,month,gen,cspan){
  ws.mergeCells(1,1,1,cspan);
  const t=ws.getCell(1,1);t.value=text;t.font=f({bold:true,size:17,color:{argb:NAVY}});t.alignment=LFT;
  ws.getRow(1).height=27;
  ws.mergeCells(2,1,2,cspan);
  const s=ws.getCell(2,1);
  s.value=`Scope:  ${scope}      •      Month:  ${month}      •      Generated:  ${gen}`;
  s.font=f({italic:true,size:9,color:{argb:GREY}});s.alignment=LFT;
  tri(ws,3,cspan);
  return 5;
}
function tiles(ws,row,items,cspan){
  const n=items.length,base=Math.floor(cspan/n),extra=cspan%n;
  let start=1;
  for(let i=0;i<n;i++){
    const w=base+(i<extra?1:0),c0=start,c1=start+w-1;start+=w;
    const color=items[i][2]!=null?TILE[items[i][2]%TILE.length]:TILE[i%TILE.length];
    ws.mergeCells(row,c0,row,c1);
    const v=ws.getCell(row,c0);v.value=items[i][0];v.fill=solid(color);
    v.font=f({bold:true,size:18,color:{argb:WHITE}});v.alignment=CTR;
    ws.mergeCells(row+1,c0,row+1,c1);
    const l=ws.getCell(row+1,c0);l.value=items[i][1];l.fill=solid(color);
    l.font=f({bold:true,size:9,color:{argb:WHITE}});l.alignment=CTR;
  }
  ws.getRow(row).height=34;ws.getRow(row+1).height=16;
  return row+3;
}
function band(ws,r,text,cspan){
  ws.mergeCells(r,1,r,cspan);
  const c=ws.getCell(r,1);c.value=text;c.fill=solid(BLUE);
  c.font=f({bold:true,size:11,color:{argb:WHITE}});
  c.alignment={horizontal:'left',vertical:'middle',indent:1};
  ws.getRow(r).height=20;
  return r+1;
}
function insight(ws,r,text,cspan){
  ws.mergeCells(r,1,r,cspan);
  const c=ws.getCell(r,1);c.value='   ▸  '+text;c.fill=solid(SAFF_L);
  c.font=f({italic:true,size:10,color:{argb:'FF7A4E00'}});
  c.alignment={vertical:'middle',wrapText:true,indent:1};
  c.border={left:{style:'thick',color:{argb:SAFFRON}}};
  ws.getRow(r).height=26;
  return r+2;
}
function header(ws,r,headers){
  headers.forEach((h,i)=>{
    const c=ws.getCell(r,i+1);c.value=h;c.fill=solid(NAVY);
    c.font=f({bold:true,size:10,color:{argb:WHITE}});c.alignment=CTR;c.border=bd();
  });
  ws.getRow(r).height=26;
  return r+1;
}
function dataRows(ws,r0,data,opts){
  opts=opts||{};const centerFrom=opts.centerFrom||3;
  for(let i=0;i<data.length;i++){
    const r=r0+i,row=data[i];let rf=null;
    if(opts.tintCol!=null){
      const v=parseFloat(row[opts.tintCol]);
      if(!isNaN(v)){
        rf=opts.tintRev?(v<20?GREEN_L:v<35?YEL_L:RED_L):(v>=75?GREEN_L:v>=60?YEL_L:RED_L);
      }
    }
    for(let c=0;c<row.length;c++){
      const cell=ws.getCell(r,c+1);
      cell.value=(row[c]===null||row[c]===undefined||row[c]==='')?'—':row[c];
      cell.border=bd();cell.font=f({size:10,color:{argb:INK}});
      cell.alignment=(c+1>=centerFrom)?{horizontal:'center',vertical:'middle'}:LFT;
      if(rf)cell.fill=solid(rf);
      else if(i%2===1)cell.fill=solid(ZEBRA);
    }
    ws.getRow(r).height=17;
  }
  return r0+data.length;
}
function kpiTable(ws,r,kpis){
  r=header(ws,r,['#','Metric','Value','Benchmark','Meets?']);
  kpis.forEach((k,i)=>{
    const rr=r+i,z=(i%2===1);
    const a=ws.getCell(rr,1);a.value=i+1;a.border=bd();a.alignment=CTR;a.font=f({size:10,color:{argb:GREY}});
    const m=ws.getCell(rr,2);m.value=k.label;m.border=bd();m.font=f({size:10,color:{argb:INK}});m.alignment=LFT;
    const v=ws.getCell(rr,3);v.border=bd();v.alignment=CTR;v.font=f({bold:true,size:12,color:{argb:NAVY}});
    if(k.value==null){v.value='n/a';v.font=f({bold:true,size:11,color:{argb:NA_T}});}
    else{v.value=fmtNum(k.value,k.unit);const nf=numFmtFor(k.unit);if(nf)v.numFmt=nf;}
    const b=ws.getCell(rr,4);b.value=k.target||'—';b.border=bd();b.font=f({italic:true,size:9,color:{argb:GREY}});b.alignment=CTR;
    const vd=k.value==null?'—':meets(k.value,k.target);
    const mc=ws.getCell(rr,5);mc.value=vd;mc.alignment=CTR;mc.border=bd();
    if(vd==='✓'){mc.fill=solid(POS_F);mc.font=f({bold:true,size:11,color:{argb:POS_T}});}
    else if(vd==='✗'){mc.fill=solid(NEG_F);mc.font=f({bold:true,size:11,color:{argb:NEG_T}});}
    else{mc.font=f({size:10,color:{argb:NA_T}});}
    if(z){[1,2,4].forEach(c=>{if(!ws.getCell(rr,c).fill||!ws.getCell(rr,c).fill.fgColor)ws.getCell(rr,c).fill=solid(ZEBRA);});}
    ws.getRow(rr).height=19;
  });
  return r+kpis.length+1;
}
function colorScale(ws,ref,rev){
  const lo=rev?'FF63BE7B':'FFF8696B',hi=rev?'FFF8696B':'FF63BE7B';
  ws.addConditionalFormatting({ref,rules:[{type:'colorScale',
    cfvo:[{type:'min'},{type:'percentile',value:50},{type:'max'}],
    color:[{argb:lo},{argb:'FFFFEB84'},{argb:hi}]}]});
}
function dataBar(ws,ref){
  ws.addConditionalFormatting({ref,rules:[{type:'dataBar',
    cfvo:[{type:'min'},{type:'max'}],color:{argb:BLUE},
    gradient:false,showValue:true}]});
}
function setWidths(ws,arr){arr.forEach((w,i)=>{ws.getColumn(i+1).width=w;});}
function setNumFmt(ws,c,r0,r1,fmt){for(let r=r0;r<r1;r++)ws.getCell(r,c).numFmt=fmt;}
function freeze(ws,x,y){ws.views=[{state:'frozen',xSplit:x||0,ySplit:y||5,showGridLines:false}];}

// ════════════════════════════════════════════════════════════════════════════
async function buildSummaryWorkbook({scope,month,generated,data}){
  const wb=new ExcelJS.Workbook();wb.creator='MITRA';wb.created=new Date();
  const d=data||{};const M=(x)=>x||{};
  const CONSENT='Note: demographic splits (gender / mobile-owner) cover students with affirmative data consent (DPDPA).';
  let ws,r;

  // 01 About
  ws=newSheet(wb,'01 About',3);setWidths(ws,[3,24,70]);tri(ws,1,3);
  ws.mergeCells(3,2,3,3);ws.getCell(3,2).value='MITRA — Analytics Summary Report';ws.getCell(3,2).font=f({bold:true,size:24,color:{argb:NAVY}});
  ws.mergeCells(4,2,4,3);ws.getCell(4,2).value='AR-based learning for government schools — monthly usage & outcomes';ws.getCell(4,2).font=f({italic:true,size:11,color:{argb:SAFFRON}});
  r=6;
  [['Scope',scope],['Report Month',month],['Generated',generated],['Prepared for','Department of Education'],
   ['Data source','MITRA cloud telemetry warehouse (BigQuery) + dashboard content registry'],
   ['Basis','Pre-computed aggregates — no row-level data; cannot hit Excel limits'],
   ['Full raw data',"Available as CSV / Parquet via the dashboard 'Raw dataset' export"]].forEach(([k,v])=>{
    const kc=ws.getCell(r,2);kc.value=k;kc.font=f({bold:true,size:10,color:{argb:WHITE}});kc.fill=solid(NAVY);kc.alignment={indent:1,vertical:'middle'};kc.border=bd();
    const vc=ws.getCell(r,3);vc.value=v;vc.font=f({size:10,color:{argb:INK}});vc.fill=solid(LTBLUE);vc.alignment={indent:1,vertical:'middle',wrapText:true};vc.border=bd();
    ws.getRow(r).height=20;r++;
  });
  r++;ws.getCell(r,2).value='LEGEND';ws.getCell(r,2).font=f({bold:true,size:11,color:{argb:NAVY}});r++;
  [['✓','Meets / exceeds target',POS_T],['✗','Below target',NEG_T],['n/a','Not yet captured',NA_T],
   ['▰','Color scale: red = low, green = high',BLUE]].forEach(([sym,txt,c])=>{
    const s=ws.getCell(r,2);s.value=sym;s.font=f({bold:true,size:11,color:{argb:c}});s.alignment=CTR;
    ws.getCell(r,3).value=txt;ws.getCell(r,3).font=f({size:10,color:{argb:INK}});r++;
  });

  // 03 Report Parameters
  ws=newSheet(wb,'02 Report Parameters',4);setWidths(ws,[3,28,34,40]);
  r=title(ws,'REPORT PARAMETERS',scope,month,generated,4);
  [['Selected Scope (State)',scope],['Selected Gender','All'],['Selected Mobile Owner','All'],
   ['Report Month',month],['Generated',generated],['Scopes available','All India + each State (choose before download)']].forEach(([k,v])=>{
    const kc=ws.getCell(r,2);kc.value=k;kc.font=f({bold:true,size:10,color:{argb:WHITE}});kc.fill=solid(NAVY);kc.border=bd();kc.alignment={indent:1,vertical:'middle'};
    ws.mergeCells(r,3,r,4);const vc=ws.getCell(r,3);vc.value=v;vc.font=f({bold:true,size:11,color:{argb:NAVY}});vc.fill=solid(LTBLUE);vc.border=bd();vc.alignment={indent:1,vertical:'middle'};
    ws.getRow(r).height=22;r++;
  });
  insight(ws,r+1,'This report is a static snapshot for the selected scope. Change scope on the dashboard and re-download for a different state.',4);

  // 02 Curriculum Map
  ws=newSheet(wb,'03 Curriculum Coverage',6);setWidths(ws,[5,12,16,42,10,12]);
  r=title(ws,'CURRICULUM COVERAGE MAP',scope,month,generated,6);
  r=insight(ws,r,'AR-mapped topics across Classes 6–12, aligned to NCERT. (Full list below — bounded.)',6);
  r=band(ws,r,'Class / Subject / Topic Coverage',6);
  r=header(ws,r,['#','Class','Subject','Topic','Board','Language']);
  dataRows(ws,r,(d.curriculum||[]).map((x,i)=>[i+1,...x]));
  freeze(ws,0,6);

  // 04 Reference Lists
  ws=newSheet(wb,'04 Reference Lists',6);setWidths(ws,[4,18,16,16,16,16]);
  r=title(ws,'REFERENCE LISTS',scope,month,generated,6);
  r=band(ws,r,'Master Lookup Lists',6);
  r=header(ws,r,['#','Classes','Subjects','Boards','AR Tiers','Languages']);
  const ref=M(d.reference);const maxL=Math.max((ref.classes||[]).length,(ref.subjects||[]).length,(ref.boards||[]).length,(ref.ar_tiers||[]).length,(ref.languages||[]).length,1);
  const refRows=[];for(let i=0;i<maxL;i++)refRows.push([i+1,(ref.classes||[])[i]||'',(ref.subjects||[])[i]||'',(ref.boards||[])[i]||'',(ref.ar_tiers||[])[i]||'',(ref.languages||[])[i]||'']);
  dataRows(ws,r,refRows);

  // 16 Govt KPI
  ws=newSheet(wb,'05 Govt KPI Summary',5);setWidths(ws,[5,34,16,13,10]);
  r=title(ws,'GOVERNMENT KPI SUMMARY — EXECUTIVE VIEW',scope,month,generated,5);
  const gk=M(d.govt_kpi);
  if(gk.tiles)r=tiles(ws,r,gk.tiles,5);
  if(gk.insight)r=insight(ws,r,gk.insight,5);
  r=band(ws,r,'Executive Summary (single-page view)',5);
  r=kpiTable(ws,r,gk.kpis||[]);
  freeze(ws,0,6);

  // 05 Reach
  ws=newSheet(wb,'06 Reach & Engagement',6);setWidths(ws,[5,26,13,13,15,16]);
  r=title(ws,'REACH & ENGAGEMENT DASHBOARD',scope,month,generated,6);
  const re=M(d.reach);
  if(re.tiles)r=tiles(ws,r,re.tiles,6);
  if(re.insight)r=insight(ws,r,re.insight,6);
  r=band(ws,r,'Top-Line Reach KPIs',6);r=kpiTable(ws,r,re.kpis||[]);
  r=band(ws,r,'Gender Split — Active Students',6);let hr=r;
  r=header(ws,r,['#','Gender','Students','% of Total','Sessions','Avg Session Min']);
  r=dataRows(ws,r,(re.gender||[]));
  setNumFmt(ws,3,hr+1,r,'#,##0');setNumFmt(ws,4,hr+1,r,'0.0"%"');setNumFmt(ws,5,hr+1,r,'#,##0');if(r>hr+1)dataBar(ws,`C${hr+1}:C${r-1}`);
  r=band(ws,r,'Mobile Owner Split',6);hr=r;
  r=header(ws,r,['#','Mobile Owner','Students','% of Total','Sessions','Avg Session Min']);
  r=dataRows(ws,r,(re.owner||[]));
  setNumFmt(ws,3,hr+1,r,'#,##0');setNumFmt(ws,4,hr+1,r,'0.0"%"');setNumFmt(ws,5,hr+1,r,'#,##0');if(r>hr+1)dataBar(ws,`C${hr+1}:C${r-1}`);
  r=band(ws,r,'Class-wise Engagement',6);hr=r;
  r=header(ws,r,['#','Class','Students','Sessions','Avg Session Min','AR Completion %']);
  r=dataRows(ws,r,(re.classwise||[]),{tintCol:5});
  setNumFmt(ws,3,hr+1,r,'#,##0');setNumFmt(ws,4,hr+1,r,'#,##0');setNumFmt(ws,6,hr+1,r,'0"%"');if(r>hr+1)colorScale(ws,`F${hr+1}:F${r-1}`);
  ws.mergeCells(r,1,r,6);const fc=ws.getCell(r,1);fc.value=CONSENT;fc.font=f({italic:true,size:9,color:{argb:GREY}});
  freeze(ws,0,6);

  // 06 Learning
  ws=newSheet(wb,'07 Learning Outcomes',6);setWidths(ws,[5,24,12,13,12,14]);
  r=title(ws,'LEARNING OUTCOMES DASHBOARD',scope,month,generated,6);
  const lo=M(d.learning);
  if(lo.tiles)r=tiles(ws,r,lo.tiles,6);if(lo.insight)r=insight(ws,r,lo.insight,6);
  r=band(ws,r,'Overall Learning Outcomes',6);r=kpiTable(ws,r,lo.kpis||[]);
  r=band(ws,r,'Subject-wise Learning Outcomes',6);hr=r;
  r=header(ws,r,['#','Subject','Attempts','Avg Score %','Completed','Completion %']);
  r=dataRows(ws,r,(lo.subject||[]),{tintCol:3});
  setNumFmt(ws,3,hr+1,r,'#,##0');setNumFmt(ws,4,hr+1,r,'0"%"');setNumFmt(ws,5,hr+1,r,'#,##0');setNumFmt(ws,6,hr+1,r,'0"%"');
  if(r>hr+1){colorScale(ws,`D${hr+1}:D${r-1}`);colorScale(ws,`F${hr+1}:F${r-1}`);}
  freeze(ws,0,6);

  // 07 Sessions
  ws=newSheet(wb,'08 Sessions & Behavior',6);setWidths(ws,[5,28,14,14,16,14]);
  r=title(ws,'SESSIONS & BEHAVIOR DASHBOARD',scope,month,generated,6);
  const se=M(d.sessions);
  if(se.tiles)r=tiles(ws,r,se.tiles,6);if(se.insight)r=insight(ws,r,se.insight,6);
  r=band(ws,r,'Session Duration Distribution',6);hr=r;
  r=header(ws,r,['#','Duration Band','Sessions','% of Total','','']);
  r=dataRows(ws,r,(se.distribution||[]));
  setNumFmt(ws,3,hr+1,r,'#,##0');setNumFmt(ws,4,hr+1,r,'0.0"%"');if(r>hr+1)dataBar(ws,`C${hr+1}:C${r-1}`);
  r=band(ws,r,'Session Behavior KPIs',6);r=kpiTable(ws,r,se.kpis||[]);
  r=band(ws,r,'AR Tier Distribution',6);hr=r;
  r=header(ws,r,['#','AR Tier','Sessions','% Share','Avg Duration Min','Completion %']);
  r=dataRows(ws,r,(se.ar_tier||[]),{tintCol:5});
  setNumFmt(ws,3,hr+1,r,'#,##0');setNumFmt(ws,4,hr+1,r,'0.0"%"');setNumFmt(ws,6,hr+1,r,'0"%"');if(r>hr+1){colorScale(ws,`F${hr+1}:F${r-1}`);dataBar(ws,`C${hr+1}:C${r-1}`);}
  freeze(ws,0,6);

  // 08 Devices
  ws=newSheet(wb,'09 Devices & Connectivity',6);setWidths(ws,[5,30,14,12,16,14]);
  r=title(ws,'DEVICES & CONNECTIVITY DASHBOARD',scope,month,generated,6);
  const dv=M(d.devices);
  if(dv.tiles)r=tiles(ws,r,dv.tiles,6);if(dv.insight)r=insight(ws,r,dv.insight,6);
  r=band(ws,r,'Device Overview',6);r=kpiTable(ws,r,dv.overview||[]);
  r=band(ws,r,'Network Type Distribution',6);hr=r;
  r=header(ws,r,['#','Network Type','Sessions','% of Total','','']);
  r=dataRows(ws,r,(dv.network||[]));
  setNumFmt(ws,3,hr+1,r,'#,##0');setNumFmt(ws,4,hr+1,r,'0.0"%"');if(r>hr+1)dataBar(ws,`C${hr+1}:C${r-1}`);
  freeze(ws,0,6);

  // 09 Language
  ws=newSheet(wb,'10 Language & Accessibility',6);setWidths(ws,[5,32,14,12,10,10]);
  r=title(ws,'LANGUAGE & ACCESSIBILITY DASHBOARD',scope,month,generated,6);
  const la=M(d.language);
  if(la.tiles)r=tiles(ws,r,la.tiles,6);if(la.insight)r=insight(ws,r,la.insight,6);
  r=band(ws,r,'Language Usage (Sessions)',6);hr=r;
  r=header(ws,r,['#','Language','Sessions','% of Total','','']);
  r=dataRows(ws,r,(la.usage||[]));
  setNumFmt(ws,3,hr+1,r,'#,##0');setNumFmt(ws,4,hr+1,r,'0.0"%"');if(r>hr+1)dataBar(ws,`C${hr+1}:C${r-1}`);
  r=band(ws,r,'Accessibility Feature Usage',6);r=kpiTable(ws,r,la.features||[]);
  freeze(ws,0,6);

  // 10 Curriculum & AR
  ws=newSheet(wb,'11 Curriculum & AR',13);setWidths(ws,[5,9,10,22,16,11,10,9,10,12,9,7,7]);
  r=title(ws,'CURRICULUM & AR CONTENT DASHBOARD',scope,month,generated,13);
  const ca=M(d.curriculum_ar);
  if(ca.tiles)r=tiles(ws,r,ca.tiles,13);if(ca.insight)r=insight(ws,r,ca.insight,13);
  r=band(ws,r,'AR Module Performance (all published modules)',13);hr=r;
  r=header(ws,r,['#','Class','Subject','Topic','AR Tier','Status','Launches','Unique','Avg Dwell','Completion %','Replay %','Pre %','Post %']);
  r=dataRows(ws,r,(ca.modules||[]),{tintCol:9});
  [10,11,12,13].forEach(c=>setNumFmt(ws,c,hr+1,r,'0"%"'));
  if(r>hr+1){colorScale(ws,`J${hr+1}:J${r-1}`);colorScale(ws,`M${hr+1}:M${r-1}`);dataBar(ws,`G${hr+1}:G${r-1}`);}
  freeze(ws,4,6);

  // 11 Quiz
  ws=newSheet(wb,'12 Quiz Performance',11);setWidths(ws,[5,9,10,22,12,8,10,10,12,12,11]);
  r=title(ws,'QUIZ PERFORMANCE DASHBOARD',scope,month,generated,11);
  const qz=M(d.quiz);
  if(qz.tiles)r=tiles(ws,r,qz.tiles,11);if(qz.insight)r=insight(ws,r,qz.insight,11);
  r=band(ws,r,'Quiz KPIs',11);r=kpiTable(ws,r,qz.kpis||[]);
  r=band(ws,r,'Quiz Bank Performance (all quizzes)',11);hr=r;
  r=header(ws,r,['#','Class','Subject','Quiz Title',"Bloom's",'Board','Questions','Attempts','Avg Score %','Completions','Abandoned']);
  r=dataRows(ws,r,(qz.bank||[]),{tintCol:8});
  setNumFmt(ws,8,hr+1,r,'#,##0');setNumFmt(ws,9,hr+1,r,'0"%"');setNumFmt(ws,10,hr+1,r,'#,##0');
  if(r>hr+1){colorScale(ws,`I${hr+1}:I${r-1}`);dataBar(ws,`H${hr+1}:H${r-1}`);}
  freeze(ws,4,6);

  // 12 Notifications
  ws=newSheet(wb,'13 Notifications',8);setWidths(ws,[5,24,12,10,10,9,9,9]);
  r=title(ws,'NOTIFICATIONS DASHBOARD',scope,month,generated,8);
  const nt=M(d.notifications);
  if(nt.tiles)r=tiles(ws,r,nt.tiles,8);if(nt.insight)r=insight(ws,r,nt.insight,8);
  r=band(ws,r,'Campaign Performance (all campaigns)',8);hr=r;
  r=header(ws,r,['#','Type','Target Class','Sent','Delivered','Opened','Clicked','Opt-Outs']);
  r=dataRows(ws,r,(nt.campaigns||[]));
  [4,5,6,7,8].forEach(c=>setNumFmt(ws,c,hr+1,r,'#,##0'));if(r>hr+1)dataBar(ws,`D${hr+1}:D${r-1}`);
  freeze(ws,0,6);

  // 13 Feedback
  ws=newSheet(wb,'14 Feedback & NPS',5);setWidths(ws,[5,26,14,13,10]);
  r=title(ws,'FEEDBACK & NPS DASHBOARD',scope,month,generated,5);
  const fb=M(d.feedback);
  if(fb.tiles)r=tiles(ws,r,fb.tiles,5);if(fb.insight)r=insight(ws,r,fb.insight,5);
  r=band(ws,r,'Feedback KPIs',5);r=kpiTable(ws,r,fb.kpis||[]);
  freeze(ws,0,6);

  // 14 Advertising
  ws=newSheet(wb,'15 Advertising',10);setWidths(ws,[5,24,9,13,11,9,8,13,13,12]);
  r=title(ws,'ADVERTISING DASHBOARD',scope,month,generated,10);
  const ad=M(d.advertising);
  if(ad.tiles)r=tiles(ws,r,ad.tiles,10);if(ad.insight)r=insight(ws,r,ad.insight,10);
  r=band(ws,r,'Campaign Performance (all campaigns)',10);hr=r;
  r=header(ws,r,['#','Campaign','Type','Impressions','Reach','Clicks','CTR %','Avg View Sec','Completion %','Compliance']);
  r=dataRows(ws,r,(ad.campaigns||[]));
  setNumFmt(ws,4,hr+1,r,'#,##0');setNumFmt(ws,5,hr+1,r,'#,##0');setNumFmt(ws,7,hr+1,r,'0.0"%"');setNumFmt(ws,9,hr+1,r,'0"%"');if(r>hr+1)dataBar(ws,`D${hr+1}:D${r-1}`);
  freeze(ws,0,6);

  // 15 District Drilldown
  ws=newSheet(wb,'16 District Drilldown',11);setWidths(ws,[5,14,14,9,12,13,13,10,12,15,9]);
  r=title(ws,'DISTRICT DRILLDOWN',scope,month,generated,11);
  const ds=M(d.districts);
  if(ds.tiles)r=tiles(ws,r,ds.tiles,11);if(ds.insight)r=insight(ws,r,ds.insight,11);
  r=band(ws,r,'Per-District Reach & Outcomes (all districts in scope)',11);hr=r;
  r=header(ws,r,['#','State','District','Area','Aspirational','Active Users','Quiz Attempts','Avg Quiz %','AR Sessions','AR Completion %','Schools']);
  r=dataRows(ws,r,(ds.rows||[]),{tintCol:9});
  setNumFmt(ws,6,hr+1,r,'#,##0');setNumFmt(ws,7,hr+1,r,'#,##0');setNumFmt(ws,9,hr+1,r,'#,##0');setNumFmt(ws,8,hr+1,r,'0"%"');setNumFmt(ws,10,hr+1,r,'0"%"');
  if(r>hr+1){dataBar(ws,`F${hr+1}:F${r-1}`);colorScale(ws,`H${hr+1}:H${r-1}`);colorScale(ws,`J${hr+1}:J${r-1}`);}
  freeze(ws,3,6);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports={buildSummaryWorkbook};