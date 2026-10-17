/* Timestep count charts for TensorBoard Time Series. */
const BINS = 1000;
const BOX = {left: 62, top: 24, width: 556, height: 330};

export function binAt(value) {
  return Math.max(0, Math.min(BINS - 1, Math.floor(value)));
}

export function zoomDomain(domain, anchor, factor) {
  const width = domain[1] - domain[0];
  const nextWidth = Math.max(2, Math.min(BINS, width * factor));
  const fraction = Math.max(0, Math.min(1, (anchor - domain[0]) / width));
  const left = Math.max(0, Math.min(BINS - nextWidth, anchor - fraction * nextWidth));
  return [left, left + nextWidth];
}

export function barPath(counts, domain, maximum) {
  const [low, high] = domain;
  const x = value => BOX.left + (high - value) / (high - low) * BOX.width;
  const bottom = BOX.top + BOX.height;
  const paths = [];
  for (let index = Math.max(0, Math.floor(low)); index < Math.min(BINS, Math.ceil(high)); index++) {
    if (!counts[index]) continue;
    const left = x(Math.min(high, index + 1));
    const right = x(Math.max(low, index));
    const height = counts[index] / maximum * BOX.height;
    paths.push(`M${left},${bottom}v${-height}h${right - left}v${height}Z`);
  }
  return paths.join('');
}

export function countScale(maximum) {
  const target = Math.max(1,maximum * 1.05 / 5);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const fraction = target / magnitude;
  const step = (fraction<=1?1:fraction<=2?2:fraction<=5?5:10)*magnitude;
  return {step, maximum:Math.max(step,Math.ceil(maximum*1.05/step)*step)};
}

const STYLE = `
  :host {display:block;color:inherit;font:13px Roboto,Arial,sans-serif;margin:0 16px 20px;}
  * {box-sizing:border-box} [hidden] {display:none!important}
  details>summary {cursor:pointer;padding:17px 0;font-size:14px;font-weight:500;}
  .cards {display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:20px;}
  article {border:1px solid #8886;border-radius:4px;padding:16px;max-width:600px;min-width:0;}
  article.expanded {grid-column:1/-1;max-width:none;}
  header {display:flex;align-items:center;gap:8px;margin-bottom:12px;}
  .run {font-size:15px;font-weight:500;flex:1;min-width:0;overflow-wrap:anywhere;}
  button {font:inherit;background:transparent;color:inherit;cursor:pointer;border:1px solid #8887;
    border-radius:3px;padding:5px 8px;line-height:18px;}
  button:hover {background:#8883} button:focus-visible,svg:focus-visible {outline:2px solid #4c9aff;}
  .legend {display:flex;align-items:center;gap:8px;flex-wrap:wrap;line-height:22px;}
  .dot {width:10px;height:10px;border-radius:50%;background:var(--run-color,#4c9aff);flex:none}
  .tag {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}
  .stats {margin-left:auto;opacity:.8;white-space:nowrap;font-variant-numeric:tabular-nums;}
  .plot {position:relative;margin-top:10px;}
  svg {display:block;width:100%;height:auto;max-height:420px;user-select:none;touch-action:none;}
  article.expanded svg {max-height:650px;}
  svg text {fill:currentColor;font:16px Roboto,Arial,sans-serif;}
  .grid {stroke:currentColor;opacity:.2;stroke-width:1;}
  .axis {stroke:currentColor;opacity:.65;fill:none;stroke-width:1;}
  .bars {fill:var(--run-color,#4c9aff);}
  .cross {stroke:currentColor;opacity:.7;stroke-dasharray:3 3;pointer-events:none;}
  .selection {fill:var(--run-color,#4c9aff);fill-opacity:.2;stroke:var(--run-color,#4c9aff);pointer-events:none;}
  .tooltip {position:absolute;z-index:1;pointer-events:none;padding:8px 10px;border-radius:4px;
    background:var(--tip-bg,#202124);color:var(--tip-fg,#fff);border:1px solid #8889;
    box-shadow:0 3px 12px #0004;white-space:pre-line;line-height:20px;font-variant-numeric:tabular-nums;}
  .hint {font-size:11px;opacity:.65;text-align:center;margin-top:2px;}
  .error {font-size:12px;color:#e57373;min-height:0;}
`;

const format = value => Number(value).toLocaleString('en-US', {maximumFractionDigits:0});
const svgNode = (name, attributes = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
};

class DistributionCard {
  constructor(run) {
    this.domain = [0, BINS];
    this.data = null;
    this.dragStart = null;
    this.element = document.createElement('article');
    this.element.setAttribute('aria-label', `Timestep distribution for ${run}`);
    this.element.innerHTML = `<header><span class="dot"></span><span class="run"></span>
      <button type="button" class="reset" title="Reset zoom" aria-label="Reset zoom">↺</button>
      <button type="button" class="expand" title="Expand chart" aria-label="Expand chart">⛶</button></header>
      <div class="legend"><span class="tag">timestep/distribution</span><span class="stats"></span></div>
      <div class="plot"><svg viewBox="0 0 640 420" tabindex="0" role="img"
        aria-label="Interactive timestep sampling histogram"></svg>
        <div class="tooltip" role="status" hidden></div></div>
      <div class="hint">Drag to zoom · Alt + scroll to zoom · Double-click to reset</div>
      <div class="error" role="status"></div>`;
    this.element.querySelector('.run').textContent = run;
    this.plot = this.element.querySelector('.plot');
    this.svg = this.element.querySelector('svg');
    this.tooltip = this.element.querySelector('.tooltip');
    this.element.querySelector('.reset').addEventListener('click', () => this.reset());
    this.element.querySelector('.expand').addEventListener('click', event => {
      const expanded = this.element.classList.toggle('expanded');
      event.currentTarget.setAttribute('aria-label', expanded ? 'Collapse chart' : 'Expand chart');
    });
    this.svg.addEventListener('dblclick', () => this.reset());
    this.svg.addEventListener('pointermove', event => this.move(event));
    this.svg.addEventListener('pointerleave', () => { if (this.dragStart === null) this.hideTooltip(); });
    this.svg.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !this.data) return;
      const point = this.point(event);
      if (!this.inside(point)) return;
      this.dragStart = point.x;
      this.svg.setPointerCapture(event.pointerId);
      this.move(event);
    });
    this.svg.addEventListener('pointerup', event => {
      if (this.dragStart === null) return;
      const end = this.point(event).x;
      if (Math.abs(end - this.dragStart) > 6) {
        const values = [this.valueAt(this.dragStart), this.valueAt(end)].sort((a,b) => a-b);
        if (values[1] - values[0] >= 2) this.domain = values;
      }
      this.dragStart = null;
      this.render();
      this.move(event);
    });
    this.svg.addEventListener('pointercancel', () => { this.dragStart = null; this.render(); });
    this.svg.addEventListener('wheel', event => {
      if ((!event.altKey && !event.ctrlKey) || !this.data) return;
      const point = this.point(event);
      if (!this.inside(point)) return;
      event.preventDefault();
      this.domain = zoomDomain(this.domain, this.valueAt(point.x), event.deltaY > 0 ? 1.25 : .8);
      this.render();
      this.move(event);
    }, {passive:false});
    this.svg.addEventListener('keydown', event => {
      if (event.key === 'Home' || event.key === 'Escape') this.reset();
      else if (event.key === '+' || event.key === '=' || event.key === '-') {
        event.preventDefault();
        this.domain = zoomDomain(this.domain, (this.domain[0]+this.domain[1])/2, event.key === '-' ? 1.25 : .8);
        this.render();
      }
    });
  }

  reset() { this.domain = [0, BINS]; this.render(); this.hideTooltip(); }
  point(event) {
    return new DOMPoint(event.clientX,event.clientY).matrixTransform(this.svg.getScreenCTM().inverse());
  }
  inside({x,y}) { return x>=BOX.left && x<=BOX.left+BOX.width && y>=BOX.top && y<=BOX.top+BOX.height; }
  valueAt(x) {
    const fraction = Math.max(0,Math.min(1,(x-BOX.left)/BOX.width));
    return this.domain[1] - fraction*(this.domain[1]-this.domain[0]);
  }
  hideTooltip() { this.tooltip.hidden = true; if (this.cross) this.cross.setAttribute('visibility','hidden'); }
  move(event) {
    if (!this.data) return;
    const point = this.point(event);
    if (this.dragStart !== null && this.selection) {
      const end = Math.max(BOX.left, Math.min(BOX.left+BOX.width,point.x));
      this.selection.setAttribute('x', Math.min(this.dragStart,end));
      this.selection.setAttribute('width', Math.abs(end-this.dragStart));
    }
    if (!this.inside(point)) { this.hideTooltip(); return; }
    this.lastPointer={clientX:event.clientX,clientY:event.clientY};
    const index = binAt(this.valueAt(point.x));
    this.tooltip.textContent = `Timestep: ${index}–${index+1}\nCount: ${format(this.data.counts[index])}\nStep: ${format(this.data.step)}`;
    this.tooltip.hidden = false;
    const rect = this.plot.getBoundingClientRect();
    this.tooltip.style.left = Math.max(0, Math.min(rect.width-175, event.clientX-rect.left+12))+'px';
    this.tooltip.style.top = Math.max(0,event.clientY-rect.top-80)+'px';
    this.cross.setAttribute('x1',point.x); this.cross.setAttribute('x2',point.x);
    this.cross.setAttribute('visibility','visible');
  }
  update(data) {
    const changed = !this.data || data.wall_time !== this.data.wall_time || data.total !== this.data.total;
    this.data = data;
    this.element.querySelector('.error').textContent = '';
    if (changed) this.render();
  }
  render() {
    if (!this.data) return;
    const {counts,step,total} = this.data;
    const [low,high] = this.domain;
    const {maximum,step:tickStep} = countScale(Math.max(1,...counts.slice(Math.floor(low),Math.ceil(high))));
    this.svg.replaceChildren();
    const bottom = BOX.top+BOX.height;
    for (let value=0; value<=maximum; value+=tickStep) {
      const y = bottom-BOX.height*value/maximum;
      this.svg.append(svgNode('line',{x1:BOX.left,x2:BOX.left+BOX.width,y1:y,y2:y,class:'grid'}));
      const yLabel = svgNode('text',{x:BOX.left-10,y:y+5,'text-anchor':'end'});
      yLabel.textContent = format(value); this.svg.append(yLabel);
    }
    for (let tick=0; tick<=5; tick++) {
      const x = BOX.left+BOX.width*tick/5;
      const xLabel = svgNode('text',{x,y:bottom+22,'text-anchor':'middle'});
      xLabel.textContent = (high-(high-low)*tick/5).toLocaleString('en-US', {
        maximumFractionDigits:high-low<10?1:0,
      }); this.svg.append(xLabel);
    }
    this.svg.append(svgNode('path',{d:`M${BOX.left},${BOX.top}V${bottom}H${BOX.left+BOX.width}`,class:'axis'}));
    this.svg.append(svgNode('path',{d:barPath(counts,this.domain,maximum),class:'bars'}));
    const xTitle=svgNode('text',{x:BOX.left+BOX.width/2,y:404,'text-anchor':'middle'});
    xTitle.textContent='Timestep (left=noisy, right=clean)'; this.svg.append(xTitle);
    const yTitle=svgNode('text',{x:18,y:BOX.top+BOX.height/2,transform:`rotate(-90 18 ${BOX.top+BOX.height/2})`,'text-anchor':'middle'});
    yTitle.textContent='Count'; this.svg.append(yTitle);
    this.cross=svgNode('line',{y1:BOX.top,y2:bottom,class:'cross',visibility:'hidden'});
    this.selection=svgNode('rect',{x:BOX.left,y:BOX.top,width:0,height:BOX.height,class:'selection'});
    this.svg.append(this.cross,this.selection);
    this.element.querySelector('.stats').textContent=`Step ${format(step)} · n=${format(total)}`;
    if (!this.tooltip.hidden && this.lastPointer) this.move(this.lastPointer);
  }
}

function start() {
  const api = new URL('./',import.meta.url);
  const host = document.createElement('section');
  host.id='anima-timestep-distributions';
  host.setAttribute('aria-label','Timestep sampling distributions');
  const shadow = host.attachShadow({mode:'open'});
  shadow.innerHTML=`<style>${STYLE}</style><details open><summary>timestep · sampled counts</summary><div class="cards"></div></details>`;
  const grid=shadow.querySelector('.cards');
  const cards=new Map();
  const selections=new Map();
  const colors=new Map();
  let runRegex=/(?:)/, tagRegex=/(?:)/;
  let mounted=false, loading=false, lastRuns=0, runs=[], scheduled=false;
  async function get(name, params={}) {
    const url=new URL(name,api);
    for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
    const response=await fetch(url,{cache:'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  async function refresh(force=false) {
    if (!mounted || document.hidden || loading) return;
    loading=true;
    try {
      if (force || Date.now()-lastRuns>15000) { runs=await get('runs'); lastRuns=Date.now(); }
      for (const [run,card] of cards) if (!runs.includes(run)) { card.element.remove(); cards.delete(run); }
      for (const run of runs) if (!cards.has(run)) { const card=new DistributionCard(run); cards.set(run,card); grid.append(card.element); }
      filterCards();
      await Promise.all(runs.filter(run=>!cards.get(run).element.hidden).map(async run => {
        const card=cards.get(run);
        try { card.update(await get('distribution',{run})); }
        catch { card.element.querySelector('.error').textContent='Unable to refresh counts. Retrying…'; }
      }));
    } catch { /* Keep existing charts during startup, reloads, or disconnection. */ }
    finally { loading=false; }
  }
  function filterCards() {
    for (const row of document.querySelectorAll('runs-data-table tb-data-table-content-row')) {
      const name=row.querySelector('.table-column-run')?.textContent.trim();
      const checkbox=row.querySelector('input[type="checkbox"]');
      if (name && checkbox) selections.set(name,checkbox.checked);
      const swatch=row.querySelector('.run-color-swatch');
      if (name && swatch) colors.set(name,getComputedStyle(swatch).backgroundColor);
    }
    const runFilter=document.querySelector('runs-data-table input[placeholder="Filter runs (regex)"]')?.value;
    const tagFilter=document.querySelector('input[placeholder="Filter tags (regex)"]')?.value;
    try { runRegex=new RegExp(runFilter || '', 'i'); } catch { /* Retain the last valid filter. */ }
    try { tagRegex=new RegExp(tagFilter || '', 'i'); } catch { /* Retain the last valid filter. */ }
    const chosen=[...document.querySelectorAll('button[role="checkbox"][aria-checked="true"]')].map(button=>button.textContent.trim());
    const showType=(chosen.includes('All') || chosen.includes('Histogram') || !chosen.length)
      && tagRegex.test('timestep/distribution');
    let visible=0;
    for (const [run,card] of cards) {
      if (colors.has(run)) card.element.style.setProperty('--run-color',colors.get(run));
      card.element.hidden=!showType || selections.get(run)===false || !runRegex.test(run);
      if (!card.element.hidden) visible++;
    }
    host.style.display=visible?'block':'none';
    // Native tag metadata excludes this extension's cards. Its empty-result
    // message is misleading when our matching distributions are visible.
    const empty=document.querySelector('metrics-empty-tag-match-component');
    if (empty) empty.style.display=visible?'none':'';
  }
  function mount() {
    scheduled=false;
    const main=document.querySelector('metrics-main-view-component');
    const groups=main?.querySelector('metrics-card-groups');
    mounted=Boolean(groups && main.getClientRects().length && location.hash.startsWith('#timeseries'));
    if (!mounted) { host.remove(); return; }
    if (host.parentElement!==groups.parentElement) { groups.before(host); refresh(true); }
    const color=getComputedStyle(main).color;
    host.style.color=color;
    const rgb=color.match(/\d+/g);
    const dark=rgb && Number(rgb[0])+Number(rgb[1])+Number(rgb[2])>380;
    host.style.setProperty('--tip-bg',dark?'#202124':'#fff');
    host.style.setProperty('--tip-fg',dark?'#eee':'#222');
    filterCards();
  }
  const schedule=()=>{ if (!scheduled) { scheduled=true; requestAnimationFrame(mount); } };
  new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true});
  window.addEventListener('hashchange',schedule);
  document.addEventListener('change',()=>{ schedule(); refresh(); });
  document.addEventListener('input',schedule);
  document.addEventListener('click',schedule);
  document.addEventListener('visibilitychange',()=>refresh(true));
  document.addEventListener('click',event=>{ if (event.target.closest('tb-header button')) refresh(true); },true);
  setInterval(()=>refresh(),5000);
  mount();
}

if (typeof document!=='undefined') start();
