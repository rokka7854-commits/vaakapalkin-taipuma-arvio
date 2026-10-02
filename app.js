const elements = {
  spanPreset: document.querySelector('#spanPreset'),
  spanInput: document.querySelector('#spanInput'),
  warningPercent: document.querySelector('#warningPercent'),
  limitText: document.querySelector('#limitText'),
  openCameraButton: document.querySelector('#openCameraButton'),
  imageUpload: document.querySelector('#imageUpload'),
  freezeButton: document.querySelector('#freezeButton'),
  baselineButton: document.querySelector('#baselineButton'),
  undoButton: document.querySelector('#undoButton'),
  resetButton: document.querySelector('#resetButton'),
  calculateButton: document.querySelector('#calculateButton'),
  saveRecordButton: document.querySelector('#saveRecordButton'),
  downloadImageButton: document.querySelector('#downloadImageButton'),
  installButton: document.querySelector('#installButton'),
  cameraVideo: document.querySelector('#cameraVideo'),
  imageCanvas: document.querySelector('#imageCanvas'),
  overlayCanvas: document.querySelector('#overlayCanvas'),
  viewer: document.querySelector('#viewer'),
  zoomOutButton: document.querySelector('#zoomOutButton'),
  zoomInButton: document.querySelector('#zoomInButton'),
  resetZoomButton: document.querySelector('#resetZoomButton'),
  zoomValue: document.querySelector('#zoomValue'),
  panModeButton: document.querySelector('#panModeButton'),
  markModeButton: document.querySelector('#markModeButton'),
  emptyView: document.querySelector('#emptyView'),
  cameraStatus: document.querySelector('#cameraStatus'),
  instructionText: document.querySelector('#instructionText'),
  resultGrid: document.querySelector('#resultGrid'),
  assessment: document.querySelector('#assessment'),
  deflectionValue: document.querySelector('#deflectionValue'),
  limitValue: document.querySelector('#limitValue'),
  ratioValue: document.querySelector('#ratioValue'),
  records: document.querySelector('#records')
};

const ctx = elements.imageCanvas.getContext('2d');
const overlay = elements.overlayCanvas.getContext('2d');
const state = {
  stream: null,
  imageLoaded: false,
  frozen: false,
  tool: null,
  baseline: [],
  detectedEdge: [],
  result: null,
  deferredPrompt: null,
  pointer: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  interactionMode: 'pan'
};

function spanMm() {
  return Math.max(500, Math.min(6000, Number(elements.spanInput.value) || 2700));
}

function thresholdMm() {
  return spanMm() / 200;
}

function asMillimetres(value) {
  return `${value.toLocaleString('fi-FI', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} mm`;
}

function updateLimit() {
  const limit = thresholdMm();
  elements.limitText.textContent = asMillimetres(limit);
  if (state.result) calculate();
}

function setInstruction(message) {
  elements.instructionText.textContent = message;
}

function sourceSize() {
  return { width: elements.imageCanvas.width, height: elements.imageCanvas.height };
}

function scaledPoint(event) {
  const rect = elements.overlayCanvas.getBoundingClientRect();
  const { width, height } = sourceSize();
  return {
    x: (event.clientX - rect.left) * (width / rect.width),
    y: (event.clientY - rect.top) * (height / rect.height)
  };
}

function drawPoint(point, color, label) {
  overlay.fillStyle = color;
  overlay.beginPath();
  overlay.arc(point.x, point.y, Math.max(7, elements.imageCanvas.width * .008), 0, Math.PI * 2);
  overlay.fill();
  if (label) {
    overlay.font = `${Math.max(18, elements.imageCanvas.width * .022)}px system-ui`;
    overlay.fillStyle = '#ffffff';
    overlay.fillText(label, point.x + 10, point.y - 10);
  }
}

function drawLine(a, b, color, width = 4) {
  overlay.strokeStyle = color;
  overlay.lineWidth = Math.max(width, elements.imageCanvas.width * .004);
  overlay.lineCap = 'round';
  overlay.beginPath();
  overlay.moveTo(a.x, a.y);
  overlay.lineTo(b.x, b.y);
  overlay.stroke();
}

function drawTrace(points) {
  if (points.length < 2) return;
  overlay.strokeStyle = '#f2b134';
  overlay.lineWidth = Math.max(4, elements.imageCanvas.width * .0035);
  overlay.lineCap = 'round';
  overlay.lineJoin = 'round';
  overlay.beginPath();
  overlay.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => overlay.lineTo(point.x, point.y));
  overlay.stroke();
}

function redraw() {
  if (!state.imageLoaded) return;
  overlay.clearRect(0, 0, elements.overlayCanvas.width, elements.overlayCanvas.height);
  if (state.baseline.length === 2) {
    drawLine(state.baseline[0], state.baseline[1], '#25c1dc');
    drawPoint(state.baseline[0], '#0f5563', 'A');
    drawPoint(state.baseline[1], '#0f5563', 'B');
  } else {
    state.baseline.forEach((point, index) => drawPoint(point, '#0f5563', index === 0 ? 'A' : 'B'));
  }
  drawTrace(state.detectedEdge);
  if (state.result?.maxPoint && state.baseline.length === 2) {
    const projected = projectOntoLine(state.result.maxPoint, state.baseline[0], state.baseline[1]);
    drawLine(projected, state.result.maxPoint, '#dc3f3f', 5);
    drawPoint(state.result.maxPoint, '#dc3f3f', 'D');
  }
}

function updateZoom() {
  clampPan();
  const transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  elements.imageCanvas.style.transform = transform;
  elements.overlayCanvas.style.transform = transform;
  elements.zoomValue.textContent = `${Math.round(state.zoom * 100)} %`;
  elements.zoomOutButton.disabled = !state.imageLoaded || state.zoom <= 1;
  elements.zoomInButton.disabled = !state.imageLoaded || state.zoom >= 3;
  elements.resetZoomButton.disabled = !state.imageLoaded || (state.zoom === 1 && state.panX === 0 && state.panY === 0);
  elements.viewer.classList.toggle('is-panning', state.interactionMode === 'pan');
  elements.panModeButton.classList.toggle('is-active', state.interactionMode === 'pan');
  elements.markModeButton.classList.toggle('is-active', state.interactionMode === 'mark');
  elements.panModeButton.setAttribute('aria-pressed', String(state.interactionMode === 'pan'));
  elements.markModeButton.setAttribute('aria-pressed', String(state.interactionMode === 'mark'));
}

function clampPan() {
  if (state.zoom <= 1) {
    state.panX = 0;
    state.panY = 0;
    return;
  }
  const rect = elements.viewer.getBoundingClientRect();
  const maxX = rect.width * (state.zoom - 1) / 2;
  const maxY = rect.height * (state.zoom - 1) / 2;
  state.panX = Math.max(-maxX, Math.min(maxX, state.panX));
  state.panY = Math.max(-maxY, Math.min(maxY, state.panY));
}

function resetView() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  updateZoom();
}

function setInteractionMode(mode) {
  if (!state.imageLoaded || !state.frozen) return;
  state.interactionMode = mode;
  state.pointer = null;
  if (mode === 'pan') {
    setInstruction('Lähennä tarvittaessa +/−-painikkeilla ja vedä kuvaa sormella. Valitse “Aseta merkinnät”, kun palkin kiinnityskohdat tai reuna ovat kohdallaan.');
  } else if (state.baseline.length < 2) {
    setInstruction('Valitse “1. Aseta kaksi vertailupistettä” ja merkitse palkin sama alareuna vasemman ja oikean kiinnityskohdan läheltä.');
  } else {
    setInstruction('Kaksi vertailupistettä on asetettu. Sovellus hakee palkin alareunan automaattisesti niiden välistä.');
  }
  updateControls();
}

function setImageDimensions(width, height) {
  elements.imageCanvas.width = width;
  elements.imageCanvas.height = height;
  elements.overlayCanvas.width = width;
  elements.overlayCanvas.height = height;
  elements.imageCanvas.hidden = false;
  elements.overlayCanvas.hidden = false;
  elements.emptyView.hidden = true;
}

function resetMarks() {
  state.baseline = [];
  state.detectedEdge = [];
  state.result = null;
  elements.resultGrid.hidden = true;
  elements.assessment.hidden = true;
  elements.saveRecordButton.disabled = true;
  elements.downloadImageButton.disabled = !state.imageLoaded;
  updateControls();
  redraw();
}

function updateControls() {
  const ready = state.imageLoaded && state.frozen;
  elements.freezeButton.disabled = !state.imageLoaded || state.frozen;
  elements.panModeButton.disabled = !ready;
  elements.markModeButton.disabled = !ready;
  elements.baselineButton.disabled = !ready;
  elements.undoButton.disabled = !ready || state.baseline.length === 0;
  elements.resetButton.disabled = !ready || state.baseline.length === 0;
  elements.calculateButton.disabled = !ready || state.baseline.length !== 2;
  updateZoom();
}

function markerRadius() {
  return Math.max(28, elements.imageCanvas.width * .025);
}

function nearestMarker(point) {
  const markers = [
    ...state.baseline.map((marker, index) => ({ kind: 'baseline', index, marker }))
  ];
  return markers.reduce((closest, candidate) => {
    const distance = Math.hypot(candidate.marker.x - point.x, candidate.marker.y - point.y);
    return distance < closest.distance ? { ...candidate, distance } : closest;
  }, { distance: Infinity });
}

function moveMarker(target, point) {
  if (target.kind === 'baseline') state.baseline[target.index] = point;
}

function clearResult() {
  state.result = null;
  state.detectedEdge = [];
  elements.resultGrid.hidden = true;
  elements.assessment.hidden = true;
  elements.saveRecordButton.disabled = true;
}

function addBaselinePoint(point) {
  if (state.baseline.length >= 2) state.baseline = [];
  state.baseline.push(point);
  if (state.baseline.length === 2) {
    state.tool = null;
    setInstruction('Kaksi vertailupistettä on asetettu. Tunnistan palkin alareunan niiden välistä…');
    calculate();
  } else {
    setInstruction('Merkitse seuraavaksi palkin sama alareuna vastakkaisen kiinnityskohdan läheltä.');
  }
}

function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  elements.cameraVideo.hidden = true;
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    elements.cameraStatus.textContent = 'Kamera vaatii suojatun yhteyden (HTTPS tai localhost) ja selaimen kameratuen.';
    return;
  }
  try {
    stopCamera();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    state.stream = stream;
    elements.cameraVideo.srcObject = stream;
    elements.cameraVideo.hidden = false;
    elements.imageCanvas.hidden = true;
    elements.overlayCanvas.hidden = true;
    elements.emptyView.hidden = true;
    state.imageLoaded = true;
    state.frozen = false;
    state.interactionMode = 'pan';
    resetView();
    resetMarks();
    elements.cameraStatus.textContent = 'Kamera on auki. Kohdista palkki mahdollisimman kohtisuoraan ja pysäytä kuva.';
    setInstruction('Pysäytä kuva, kun palkin kiinnityskohdat ja sama palkin reuna näkyvät selkeästi.');
  } catch (error) {
    elements.cameraStatus.textContent = `Kameraa ei voitu avata: ${error.message}`;
  }
}

function freezeFrame() {
  const video = elements.cameraVideo;
  if (!video.videoWidth) return;
  setImageDimensions(video.videoWidth, video.videoHeight);
  ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
  stopCamera();
  state.frozen = true;
  state.interactionMode = 'pan';
  resetView();
  resetMarks();
  elements.cameraStatus.textContent = 'Kuva pysäytetty. Merkitse palkin alareuna kahdesta kiinnityskohdasta.';
  setInstruction('Lähennä tarvittaessa +/−-painikkeilla ja vedä kuvaa sormella. Valitse “Aseta merkinnät”, kun palkin kiinnityskohdat ovat kohdallaan.');
  updateControls();
}

function loadImage(file) {
  if (!file) return;
  const image = new Image();
  image.onload = () => {
    const maxDimension = 2200;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.round(image.naturalWidth * scale);
    const height = Math.round(image.naturalHeight * scale);
    setImageDimensions(width, height);
    ctx.drawImage(image, 0, 0, width, height);
    stopCamera();
    state.imageLoaded = true;
    state.frozen = true;
    state.interactionMode = 'pan';
    resetView();
    resetMarks();
    elements.cameraStatus.textContent = 'Kuva ladattu. Säädä kuvaa ensin ja merkitse sitten palkin alareuna kahdesta kiinnityskohdasta.';
    setInstruction('Lähennä tarvittaessa +/−-painikkeilla ja vedä kuvaa sormella. Valitse “Aseta merkinnät”, kun palkin kiinnityskohdat ovat kohdallaan.');
    updateControls();
    URL.revokeObjectURL(image.src);
  };
  image.src = URL.createObjectURL(file);
}

function projectOntoLine(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  return { x: a.x + t * dx, y: a.y + t * dy, t };
}

function pointDistanceToLine(point, a, b) {
  const projection = projectOntoLine(point, a, b);
  return Math.hypot(point.x - projection.x, point.y - projection.y);
}

function isBeamColour(r, g, b) {
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  return r > 72 && r > g * 1.18 && r > b * 1.25 && maximum - minimum > 32;
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function detectBeamEdge(a, b) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 80) return [];
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const nx = -uy;
  const ny = ux;
  const pixels = ctx.getImageData(0, 0, elements.imageCanvas.width, elements.imageCanvas.height).data;
  const width = elements.imageCanvas.width;
  const height = elements.imageCanvas.height;
  const sampleCount = Math.max(32, Math.min(100, Math.round(length / 12)));
  const search = Math.max(28, Math.min(110, Math.round(length * .075)));
  const candidates = [];

  for (let i = 2; i < sampleCount - 2; i += 1) {
    const t = i / (sampleCount - 1);
    const cx = a.x + (b.x - a.x) * t;
    const cy = a.y + (b.y - a.y) * t;
    const runs = [];
    let run = null;
    for (let s = -search; s <= search; s += 1) {
      const x = Math.round(cx + nx * s);
      const y = Math.round(cy + ny * s);
      const idx = (y * width + x) * 4;
      const painted = x >= 0 && x < width && y >= 0 && y < height && isBeamColour(pixels[idx], pixels[idx + 1], pixels[idx + 2]);
      if (painted) {
        if (!run) run = { start: s, end: s };
        else run.end = s;
      } else if (run) {
        if (run.end - run.start >= 2) runs.push(run);
        run = null;
      }
    }
    if (run && run.end - run.start >= 2) runs.push(run);
    if (!runs.length) continue;
    const best = runs.reduce((winner, item) => {
      const winnerScore = Math.abs(winner.end) + 10 / (winner.end - winner.start + 1);
      const itemScore = Math.abs(item.end) + 10 / (item.end - item.start + 1);
      return itemScore < winnerScore ? item : winner;
    });
    candidates.push({ t, offset: best.end });
  }

  if (candidates.length < 14) return [];
  const centre = median(candidates.map((item) => item.offset));
  const filtered = candidates.filter((item) => Math.abs(item.offset - centre) <= Math.max(16, search * .45));
  if (filtered.length < 12) return [];
  return filtered.map((item, index, all) => {
    const nearby = all.slice(Math.max(0, index - 2), Math.min(all.length, index + 3)).map((entry) => entry.offset);
    const offset = median(nearby);
    return { x: a.x + (b.x - a.x) * item.t + nx * offset, y: a.y + (b.y - a.y) * item.t + ny * offset };
  });
}

function calculate() {
  const [a, b] = state.baseline;
  const baselinePixels = Math.hypot(b.x - a.x, b.y - a.y);
  if (!baselinePixels) return;
  state.detectedEdge = detectBeamEdge(a, b);
  if (state.detectedEdge.length < 12) {
    clearResult();
    setInstruction('Palkin alareunaa ei voitu tunnistaa riittävän luotettavasti. Lähennä kuvaa, siirrä se palkin kohdalle ja aseta kaksi sinistä pistettä tarkemmin alareunaan.');
    redraw();
    return;
  }
  const distances = state.detectedEdge.map((point) => ({ point, px: pointDistanceToLine(point, a, b) }));
  const maximum = distances.reduce((winner, item) => item.px > winner.px ? item : winner);
  const estimate = maximum.px / baselinePixels * spanMm();
  const limit = thresholdMm();
  const percentage = estimate / limit * 100;
  state.result = { estimate, limit, percentage, maxPoint: maximum.point, baselinePixels };
  elements.deflectionValue.textContent = asMillimetres(estimate);
  elements.limitValue.textContent = asMillimetres(limit);
  elements.ratioValue.textContent = `${percentage.toLocaleString('fi-FI', { maximumFractionDigits: 0 })} %`;
  elements.resultGrid.hidden = false;
  elements.assessment.hidden = false;
  elements.assessment.className = 'assessment';
  const warningPoint = Math.min(100, Math.max(50, Number(elements.warningPercent.value) || 75));
  if (percentage >= 100) {
    elements.assessment.classList.add('danger');
    elements.assessment.textContent = 'Arvio ylittää L/200-vertailuarvon. Mittaa taipuma erikseen, tarkista kuormitustilanne ja noudata valmistajan ohjeita ennen jatkotoimia.';
  } else if (percentage >= warningPoint) {
    elements.assessment.classList.add('warning');
    elements.assessment.textContent = 'Arvio on lähellä L/200-vertailuarvoa. Mittaa taipuma erikseen ja varmista kuormitustilanne ennen johtopäätöksiä.';
  } else {
    elements.assessment.classList.add('good');
    elements.assessment.textContent = 'Arvio jää alle asetetun tarkistuskehotuksen rajan. Tulos on silti vain kamerakuvaan perustuva suuntaa-antava arvio.';
  }
  elements.saveRecordButton.disabled = false;
  elements.downloadImageButton.disabled = false;
  setInstruction('Palkin alareuna on tunnistettu keltaisena viivana. Punainen viiva näyttää suurimman havaitun poikkeaman.');
  redraw();
}

function saveRecord() {
  if (!state.result) return;
  const record = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    createdAt: new Date().toISOString(),
    spanMm: spanMm(),
    estimateMm: Number(state.result.estimate.toFixed(1)),
    limitMm: Number(state.result.limit.toFixed(1)),
    percentage: Number(state.result.percentage.toFixed(0)),
    warningAt: Number(elements.warningPercent.value),
    note: 'Kamerakuvaan perustuva suuntaa-antava arvio; erillinen mittaus tarvittaessa.'
  };
  const records = getRecords();
  records.unshift(record);
  localStorage.setItem('taipuma-arvio-records', JSON.stringify(records.slice(0, 50)));
  renderRecords();
  elements.cameraStatus.textContent = 'Taipuma-arvio tallennettu tälle laitteelle.';
}

function getRecords() {
  try { return JSON.parse(localStorage.getItem('taipuma-arvio-records')) || []; } catch { return []; }
}

function renderRecords() {
  const records = getRecords();
  elements.records.textContent = '';
  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-records';
    empty.textContent = 'Ei tallennettuja taipuma-arvioita tällä laitteella.';
    elements.records.append(empty);
    return;
  }
  records.forEach((record) => {
    const row = document.createElement('article');
    row.className = 'record';
    const text = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = `${asMillimetres(record.estimateMm)} / L/200 ${asMillimetres(record.limitMm)}`;
    const detail = document.createElement('p');
    detail.textContent = `${new Date(record.createdAt).toLocaleString('fi-FI')} · jänneväli ${record.spanMm} mm · ${record.percentage} %`;
    text.append(heading, detail);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Poista';
    remove.addEventListener('click', () => {
      localStorage.setItem('taipuma-arvio-records', JSON.stringify(getRecords().filter((item) => item.id !== record.id)));
      renderRecords();
    });
    row.append(text, remove);
    elements.records.append(row);
  });
}

function downloadMarkedImage() {
  if (!state.imageLoaded) return;
  const output = document.createElement('canvas');
  output.width = elements.imageCanvas.width;
  output.height = elements.imageCanvas.height;
  const outputCtx = output.getContext('2d');
  outputCtx.drawImage(elements.imageCanvas, 0, 0);
  outputCtx.drawImage(elements.overlayCanvas, 0, 0);
  const link = document.createElement('a');
  link.href = output.toDataURL('image/jpeg', .92);
  link.download = `taipuma-arvio-${new Date().toISOString().slice(0, 10)}.jpg`;
  link.click();
}

function handlePointerDown(event) {
  if (!state.frozen) return;
  elements.overlayCanvas.setPointerCapture?.(event.pointerId);
  if (state.interactionMode === 'pan') {
    state.pointer = { mode: 'pan', clientX: event.clientX, clientY: event.clientY, panX: state.panX, panY: state.panY };
    return;
  }
  const point = scaledPoint(event);
  const nearest = nearestMarker(point);
  state.pointer = { start: point, target: nearest.distance <= markerRadius() ? nearest : null };
  if (state.pointer.target) {
    setInstruction('Valittu merkki on suurennettu. Vedä se ristikkoon oikeaan kohtaan ja vapauta sormi.');
    return;
  }
}

function handlePointerMove(event) {
  if (!state.pointer || !state.frozen) return;
  if (state.pointer.mode === 'pan') {
    state.panX = state.pointer.panX + event.clientX - state.pointer.clientX;
    state.panY = state.pointer.panY + event.clientY - state.pointer.clientY;
    updateZoom();
    return;
  }
  const point = scaledPoint(event);
  if (state.pointer.target) {
    moveMarker(state.pointer.target, point);
    clearResult();
    redraw();
    return;
  }
}

function handlePointerUp(event) {
  if (!state.pointer || !state.frozen) return;
  if (state.pointer.mode === 'pan') {
    state.pointer = null;
    updateZoom();
    return;
  }
  const point = scaledPoint(event);
  if (state.pointer.target) {
    moveMarker(state.pointer.target, point);
    clearResult();
    setInstruction('Merkki siirretty. Voit vetää myös muita merkkejä tai laskea arvion, kun palkin reuna on piirretty.');
  } else if (state.tool === 'baseline') {
    clearResult();
    addBaselinePoint(point);
  }
  state.pointer = null;
  updateControls();
  redraw();
}

elements.spanPreset.addEventListener('change', () => {
  if (elements.spanPreset.value !== 'custom') elements.spanInput.value = elements.spanPreset.value;
  elements.spanInput.focus();
  updateLimit();
});
elements.spanInput.addEventListener('input', () => { elements.spanPreset.value = 'custom'; updateLimit(); });
elements.warningPercent.addEventListener('input', () => { if (state.result) calculate(); });
elements.openCameraButton.addEventListener('click', openCamera);
elements.freezeButton.addEventListener('click', freezeFrame);
elements.imageUpload.addEventListener('change', (event) => loadImage(event.target.files?.[0]));
elements.baselineButton.addEventListener('click', () => { state.interactionMode = 'mark'; state.tool = 'baseline'; setInstruction('Napauta palkin alareunaa ensin vasemman ja sitten oikean kiinnityskohdan läheltä. Voit vetää siniset merkit myöhemmin tarkkaan kohtaan.'); updateControls(); });
elements.undoButton.addEventListener('click', () => { state.baseline.pop(); state.detectedEdge = []; clearResult(); updateControls(); redraw(); });
elements.resetButton.addEventListener('click', resetMarks);
elements.calculateButton.addEventListener('click', calculate);
elements.saveRecordButton.addEventListener('click', saveRecord);
elements.downloadImageButton.addEventListener('click', downloadMarkedImage);
elements.overlayCanvas.addEventListener('pointerdown', handlePointerDown);
elements.overlayCanvas.addEventListener('pointermove', handlePointerMove);
elements.overlayCanvas.addEventListener('pointerup', handlePointerUp);
elements.overlayCanvas.addEventListener('pointercancel', () => { state.pointer = null; });
elements.panModeButton.addEventListener('click', () => setInteractionMode('pan'));
elements.markModeButton.addEventListener('click', () => setInteractionMode('mark'));
elements.zoomInButton.addEventListener('click', () => { state.zoom = Math.min(3, Number((state.zoom + .5).toFixed(1))); updateZoom(); });
elements.zoomOutButton.addEventListener('click', () => { state.zoom = Math.max(1, Number((state.zoom - .5).toFixed(1))); updateZoom(); });
elements.resetZoomButton.addEventListener('click', resetView);

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.deferredPrompt = event;
  elements.installButton.hidden = false;
});
elements.installButton.addEventListener('click', async () => {
  if (!state.deferredPrompt) return;
  state.deferredPrompt.prompt();
  await state.deferredPrompt.userChoice;
  state.deferredPrompt = null;
  elements.installButton.hidden = true;
});

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
updateLimit();
updateZoom();
renderRecords();
