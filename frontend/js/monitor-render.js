/* ================================================================
   monitor-render.js — Dashboard, Charts, Logs rendering
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.monitorRenderMixin = {
  renderDashboard() {
    const el = document.getElementById('monitorDashboard');
    if (!el) return;
    const d = this.monitorData||{}, gpu=this.gpuInfo, sys=this.sysInfo;
    const t = (k,fb) => this.t('monitor.'+k)||fb||k;
    const firstRender = !this._dashboardRendered; this._dashboardRendered=true;
    const tab = this.dashTab||'overview';
    const prevBars = this._prevBarValues||{};
    const vramPct = gpu?(gpu.vram_total_mb>0?gpu.vram_used_mb/gpu.vram_total_mb*100:0):0;
    const loadPct = gpu?(gpu.gpu_load_pct||0):0;
    const cpuPct = sys?sys.cpu_pct:0, ramPct = sys?sys.ram_pct:0;
    this._prevBarValues = {vram:vramPct, load:loadPct, cpu:cpuPct, ram:ramPct};

    let html = '<div class="monitor-dashboard">';
    html += '<div class="monitor-row" style="margin-bottom:12px">';
    html += this._statusCard(d,t); if (sys) html += this._systemCard(sys,t); if (gpu) html += this._gpuCard(gpu,t);
    html += '</div>';
    if (tab==='overview') html += this._renderOverview(d,t);
    else if (tab==='charts') html += this._renderCharts(d,t);
    else if (tab==='samples') html += this._renderSamples(t);
    else if (tab==='tensorboard') html += this._renderTensorBoard();
    html += '</div>';
    this._destroyCharts(); el.innerHTML = html;

    const bars = el.querySelectorAll('.monitor-bar-fill[data-bar]');
    if (firstRender) { bars.forEach(bar=>{bar.style.transition='none';bar.style.width=bar.dataset.target+'%';}); }
    else { bars.forEach(bar=>{const key=bar.dataset.bar,prev=prevBars[key]!=null?prevBars[key]:0;bar.style.width=prev+'%';});
      requestAnimationFrame(()=>{requestAnimationFrame(()=>{bars.forEach(bar=>{bar.style.width=bar.dataset.target+'%';});});}); }
    setTimeout(()=>this._drawCharts(),100);
  },

  _renderOverview(d,t) {
    let html='';
    html+='<div class="card card-params" style="margin-top:12px"><div class="card-header">'+t('trainParams','Parameters')+'</div>';
    if (this.trainParams.length) { html+='<div class="param-grid">'; this.trainParams.forEach(p=>{html+=`<div class="param-item"><span class="param-label">${p.label}</span><span class="param-value">${p.value}</span></div>`;}); html+='</div>'; }
    else html+='<div class="dashboard-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><p>'+t('noTrainingHint','Start training to see parameters')+'</p></div>';
    html+='</div>';
    if (this.previews.length) { html+='<div class="card card-preview" style="margin-top:12px"><div class="card-header">'+t('previewSamples','Preview')+'</div><div class="preview-grid" style="grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px">';
      this.previews.slice(0,6).forEach(p=>{html+=`<div class="preview-item" @click="dashTab='samples';renderDashboard()" style="cursor:pointer"><img src="${p.url}" alt="${p.name}" loading="lazy" style="height:80px;object-fit:cover"/><span style="font-size:10px">${p.name}</span></div>`;});
      html+='</div></div>'; }
    return html;
  },

  _renderCharts(d,t) {
    let html='<div class="card card-charts"><div class="card-header" style="display:flex;justify-content:space-between;align-items:center"><span>'+t('lossCurve','Loss/LR')+'</span><label style="font-size:11px;display:flex;align-items:center;gap:4px;font-weight:400"><span style="color:var(--text-tertiary)">Smooth</span><input type="range" min="0" max="0.99" step="0.01" x-model="chartSmoothing" @input="renderDashboard()" style="width:60px;accent-color:var(--accent)" value="0.6"></label></div>';
    html+='<div class="chart-grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px">';
    const tags = this.lossSeries.length?this.lossSeries:[{tag:'loss/average',name:'loss average',latest:null,points:[]},{tag:'loss/current',name:'loss current',latest:null,points:[]},{tag:'loss/epoch_average',name:'loss epoch average',latest:null,points:[]},{tag:'lr/unet',name:'lr unet',latest:null,points:[]}];
    tags.forEach(s=>{html+=`<div class="chart-panel"><div class="chart-title">${s.name} <span class="chart-val">${s.latest!=null?s.latest.toFixed(4):'--'}</span></div><canvas id="chart-${s.tag.replace(/[/.]/g,'-')}" width="360" height="200"></canvas></div>`;});
    html+='</div></div>'; return html;
  },

  _renderSamples(t) {
    let html='<div class="card card-preview"><div class="card-header">'+t('previewSamples','Preview')+'</div>';
    if (this.previews.length) { html+='<div class="preview-controls" style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><button class="btn btn-sm" @click="previewStep=Math.max(0,previewStep-1)" :disabled="previewStep<=0">&larr; Prev</button><span style="font-size:13px">Step <b x-text="previewStep+1"></b> / <b>'+this.previews.length+'</b></span><button class="btn btn-sm" @click="previewStep=Math.min('+(this.previews.length-1)+',previewStep+1)" :disabled="previewStep>='+(this.previews.length-1)+'">Next &rarr;</button></div><div class="preview-grid">';
      const p=this.previews[this.previewStep]||this.previews[0];
      html+=`<div class="preview-item" style="grid-column:1/-1"><img src="${p.url}" alt="${p.name}" loading="lazy" onclick="window.open('${p.url}')" style="max-height:400px;object-fit:contain"/><span>${p.name}</span></div>`;
      this.previews.forEach((pv,i)=>{html+=`<div class="preview-item" style="cursor:pointer;${i===this.previewStep?'border:2px solid var(--accent);':''}" @click="previewStep=${i}"><img src="${pv.url}" alt="${pv.name}" loading="lazy" style="height:60px;object-fit:cover"/></div>`;});
      html+='</div>'; }
    else html+='<div class="dashboard-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><p>'+t('noTrainingHint','Preview images appear during training')+'</p></div>';
    html+='</div>'; return html;
  },

  _renderTensorBoard() { return `<div class="card" style="padding:0;overflow:hidden;height:calc(100vh - 240px);min-height:500px"><iframe src="/proxy/tensorboard/" style="width:100%;height:100%;border:none" onload="this.style.opacity='1'" style="opacity:0;transition:opacity 0.5s"></iframe></div>`; },

  _statusCard(d,t) {
    const stateCode=d.state||'IDLE', stateLabels={'RUNNING':t('training','Training'),'FINISHED':t('finished','Finished'),'TERMINATED':t('terminated','Terminated'),'CREATED':t('created','Pending'),'IDLE':t('idle','Idle')};
    const state=stateLabels[stateCode]||stateCode, isTraining=stateCode==='RUNNING';
    const color=isTraining?'var(--success)':(d.has_error?'var(--danger)':'var(--text-secondary)');
    let html=`<div class="card card-status flex-1"><div class="card-header">${t('status','Status')}</div><div style="font-size:20px;font-weight:700;color:${color};margin:8px 0">${state}</div>`;
    if (isTraining) { if(d.percent>0) html+=`<div class="monitor-bar-track" style="height:8px;margin:8px 0"><div class="monitor-bar-fill low" style="width:${d.percent}%;transition:width 1s ease"></div></div>`;
      if(d.step) html+=`<div>${t('step','Steps')}: <b>${d.step}</b> / ${d.total_steps||'?'} (${d.percent||0}%)</div>`;
      if(d.loss) html+=`<div>${t('loss','Loss')}: <b>${d.loss}</b></div>`; if(d.lr) html+=`<div>${t('lr','LR')}: <b>${d.lr}</b></div>`;
      if(d.epoch) html+=`<div>${t('epoch','Epoch')}: <b>${d.epoch}</b></div>`; if(d.speed) html+=`<div>${t('speed','Speed')}: <b>${d.speed}</b></div>`;
      if(d.eta) html+=`<div>ETA: <b>${d.eta}</b></div>`; }
    else if(d.last_config&&d.last_config.name) { const lc=d.last_config;
      html+=`<div style="font-size:12px;color:var(--text-secondary);margin-top:4px">${t('lastTraining','Last')}: <b>${lc.name}</b></div><div style="font-size:12px;color:var(--text-tertiary)">${lc.model} · LR:${lc.lr} · Dim:${lc.dim} · Epochs:${lc.epochs}</div>`; }
    if(d.has_error) html+=`<div style="color:var(--danger);margin-top:8px">${d.error_msg||t('error','Error')}</div>`;
    html+='</div>'; return html;
  },

  _gpuCard(gpu,t) {
    const vramPct=gpu.vram_total_mb>0?gpu.vram_used_mb/gpu.vram_total_mb*100:0, vramGrade=vramPct>90?'high':vramPct>70?'mid':'low';
    const loadPct=gpu.gpu_load_pct||0, loadGrade=loadPct>80?'high':loadPct>50?'mid':'low';
    let html=`<div class="card card-gpu flex-1"><div class="card-header">${t('gpu','GPU')}</div><div style="font-size:14px;font-weight:600;margin:4px 0">${gpu.name||'GPU'}</div>`;
    html+=`<div class="monitor-stat">${t('vramUsed','VRAM')}: <b class="${vramGrade}">${gpu.vram_used_mb} MB (${Math.round(vramPct)}%)</b> / ${gpu.vram_total_mb} MB</div><div class="monitor-bar-track"><div class="monitor-bar-fill ${vramGrade}" data-bar="vram" data-target="${vramPct}"></div></div>`;
    html+=`<div class="monitor-stat" style="margin-top:8px">${t('gpuLoad','Load')}: <b class="${loadGrade}">${loadPct}%</b></div><div class="monitor-bar-track"><div class="monitor-bar-fill ${loadGrade}" data-bar="load" data-target="${loadPct}"></div></div>`;
    if(gpu.temperature_c!=null) html+=`<div style="font-size:12px;margin-top:6px">${t('gpuTemp','Temp')}: <b>${gpu.temperature_c}&deg;C</b></div>`;
    if(gpu.power_w!=null) html+=`<div style="font-size:12px">${t('gpuPower','Power')}: <b>${gpu.power_w}W</b></div>`;
    html+='</div>'; return html;
  },

  _systemCard(sys,t) {
    const cpuGrade=sys.cpu_pct>80?'high':sys.cpu_pct>50?'mid':'low', ramGrade=sys.ram_pct>80?'high':sys.ram_pct>50?'mid':'low';
    let html=`<div class="card card-system flex-1"><div class="card-header">${t('system','System')}</div>`;
    if(sys.cpu_name) html+=`<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${sys.cpu_name}</div>`;
    html+=`<div class="monitor-stat">${t('cpu','CPU')}: <b class="${cpuGrade}">${sys.cpu_pct}%</b></div><div class="monitor-bar-track"><div class="monitor-bar-fill ${cpuGrade}" data-bar="cpu" data-target="${sys.cpu_pct}"></div></div>`;
    html+=`<div class="monitor-stat" style="margin-top:8px">${t('ram','RAM')}: <b class="${ramGrade}">${sys.ram_used_gb} GB (${sys.ram_pct}%)</b> / ${sys.ram_total_gb} GB</div><div class="monitor-bar-track"><div class="monitor-bar-fill ${ramGrade}" data-bar="ram" data-target="${sys.ram_pct}"></div></div>`;
    html+='</div>'; return html;
  },

  _drawCharts() {
    if (!this._chartInstances) this._chartInstances={};
    const isDark=this.resolvedTheme==='dark', gridColor=isDark?'rgba(255,255,255,0.08)':'rgba(0,0,0,0.08)', textColor=isDark?'#a0a0a0':'#6b7280';
    const smoothing=this.chartSmoothing||0, colors=['#8b5cf6','#06b6d4','#f59e0b','#10b981'];
    const tooltipBg=isDark?'#1e1e1e':'#ffffff', tooltipBorder=isDark?'#404040':'#e5e7eb';

    this.lossSeries.forEach((s,idx)=>{
      const id='chart-'+s.tag.replace(/[/.]/g,'-'), canvas=document.getElementById(id);
      if(!canvas||!s.points||s.points.length<2) return;
      let points=s.points;
      if(smoothing>0){points=[];let ema=s.points[0].value,alpha=1-smoothing;s.points.forEach((p,i)=>{if(i===0)ema=p.value;else ema=alpha*p.value+(1-alpha)*ema;points.push({step:p.step,value:ema});});}
      const xs=points.map(p=>p.step), xMin=Math.min(...xs), xMax=Math.max(...xs), color=colors[idx%colors.length], ctx=canvas.getContext('2d');
      if(this._chartInstances[id]){try{this._chartInstances[id].destroy()}catch(_){}}

      this._chartInstances[id]=new Chart(ctx,{type:'line',
        plugins:[{id:'gradientFill'+id,beforeDatasetsDraw(chart){const{gctx,chartArea}=chart;if(!chartArea)return;const grad=gctx.createLinearGradient(0,chartArea.top,0,chartArea.bottom);grad.addColorStop(0,color+'40');grad.addColorStop(1,color+'05');chart.data.datasets[0].backgroundColor=grad;}}],
        data:{datasets:[{label:s.name,data:points.map(p=>({x:p.step,y:p.value})),borderColor:color,fill:true,tension:0.3,pointRadius:0,pointHitRadius:8,pointHoverRadius:5,pointHoverBackgroundColor:color,borderWidth:1.8}]},
        options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{mode:'nearest',intersect:false},layout:{padding:{top:4,right:8,bottom:0,left:0}},
          plugins:{legend:{display:false},tooltip:{backgroundColor:tooltipBg,titleColor:textColor,bodyColor:textColor,borderColor:tooltipBorder,borderWidth:1,padding:8,displayColors:false,callbacks:{title:(items)=>'Step '+items[0].parsed.x,label:(item)=>item.dataset.label+': '+item.parsed.y.toFixed(6)}}},
          scales:{x:{type:'linear',min:xMin,max:xMax,grid:{color:gridColor},ticks:{color:textColor,font:{size:10},maxTicksLimit:8,callback:(v)=>v>=1000?(v/1000).toFixed(0)+'k':v}},y:{grid:{color:gridColor},ticks:{color:textColor,font:{size:10},maxTicksLimit:6,callback:(v)=>parseFloat(v.toFixed(4))}}}}});
    });
  },

  renderLogs() {
    const el=document.getElementById('monitorLogs'); if(!el) return;
    const t=(k,fb)=>this.t('monitor.'+k)||fb||k;
    if(!this.logLines.length){el.innerHTML='<div class="dashboard-empty" style="padding:48px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><p>'+t('noTrainingHint','No logs yet')+'</p></div>';return;}
    const search=(this.logSearch||'').toLowerCase(), level=this.logLevel||'all'; let lines=this.logLines;
    if(search) lines=lines.filter(l=>l.toLowerCase().includes(search));
    if(level==='error') lines=lines.filter(l=>l.toLowerCase().includes('error')||l.toLowerCase().includes('traceback'));
    else if(level==='warn') lines=lines.filter(l=>l.toLowerCase().includes('warn'));
    else if(level==='info') lines=lines.filter(l=>!l.toLowerCase().includes('error')&&!l.toLowerCase().includes('traceback')&&!l.toLowerCase().includes('warn'));
    let html='<div class="log-lines">';
    if(!lines.length) html+='<div class="dashboard-empty" style="padding:20px"><p>'+t('noResults','No matches')+'</p></div>';
    else lines.forEach(line=>{const lower=line.toLowerCase(),cls=lower.includes('error')||lower.includes('traceback')?'log-error':lower.includes('warning')?'log-warn':'';html+=`<div class="log-line ${cls}">${this._escapeHtml(line)}</div>`;});
    html+='</div>'; el.innerHTML=html; if(this.logAutoScroll) el.scrollTop=el.scrollHeight;
  },

  renderHistory() {
    const el = document.getElementById('historyList');
    if (!el) return;
    const t = (k, fb) => this.t('monitor.' + k) || fb || k;
    const hasRunning = this.runningTask && this.runningTask.status === 'RUNNING';
    const hasHistory = this.historyItems && this.historyItems.length;

    if (!hasRunning && !hasHistory) {
      el.innerHTML = '<div class="dashboard-empty" style="padding:48px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><p>' + t('historyNoRecords', 'No training history') + '</p><p style="font-size:12px;color:var(--text-tertiary);margin-top:4px">' + t('historyWillAppear', 'Records will appear after training') + '</p></div>';
      return;
    }

    let html = '';

    // Running task
    if (hasRunning) {
      const r = this.runningTask;
      html += '<div class="card history-card history-running" style="border-left:3px solid var(--primary)">';
      html += '<div class="card-header">' + t('running', 'Running') + ' <span class="badge badge-running">● ' + (t('training', 'Training') || 'Training') + '</span></div>';
      html += '<div><b>' + (r.name || r.id || '') + '</b></div>';
      html += '<div style="font-size:12px;color:var(--text-secondary)">' + t('historyModel', 'Model') + ': ' + ((r.model || '').split(/[\\\/]/).pop() || 'Unknown') + '</div>';
      html += '<div style="font-size:12px;color:var(--text-secondary)">' + t('historyLR', 'LR') + ': ' + (r.lr || '?') + ' | ' + t('historyDim', 'Dim') + ': ' + (r.dim || '?') + ' | ' + t('historyEpochs', 'Epochs') + ': ' + (r.epochs || '?') + '</div>';
      if (r.run_dir) html += '<div style="font-size:11px;color:var(--text-tertiary);margin-top:4px">' + (t('runDir', 'Folder') || 'Folder') + ': ' + r.run_dir + '</div>';
      html += '</div>';
    }

    // History items
    if (hasHistory) {
      if (hasRunning) html += '<div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin:16px 0 8px">' + t('pastRuns', 'Past Runs') + '</div>';
      html += '<div class="history-grid">';
      this.historyItems.forEach(h => {
        html += '<div class="card history-card" @click="navigate(\'monitor-dashboard\')" style="cursor:pointer">';
        html += '<div class="card-header">' + h.time + '</div>';
        html += '<div><b>' + (h.name || '') + '</b></div>';
        html += '<div style="font-size:12px;color:var(--text-secondary)">' + t('historyModel', 'Model') + ': ' + (h.model || '') + '</div>';
        html += '<div style="font-size:12px;color:var(--text-secondary)">' + t('historyLR', 'LR') + ': ' + (h.lr || '') + ' | ' + t('historyDim', 'Dim') + ': ' + (h.dim || '') + ' | ' + t('historyEpochs', 'Epochs') + ': ' + (h.epochs || '') + '</div>';
        if (h.dataset) html += '<div style="font-size:11px;color:var(--text-tertiary);margin-top:4px">' + (t('dataset', 'Dataset') || 'Dataset') + ': ' + h.dataset + '</div>';
        if (h.run_dir) html += '<div style="font-size:11px;color:var(--text-tertiary)">' + (t('runDir', 'Folder') || 'Folder') + ': ' + h.run_dir + '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    el.innerHTML = html;
  }
};
