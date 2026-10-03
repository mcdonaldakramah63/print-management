// ---------------------------------------------------------------
// Printer doctor
//
// Turns what the agent reports about a printer into a short answer for a
// cashier: is it ready, what's wrong, and what to press to fix it.
//
// Three sources describe the same printer and they often disagree or lag:
//   * the printer itself over SNMP (error bits, its screen text, trays,
//     covers) — the most direct, but only for network printers;
//   * Windows' view of the printer (Win32_Printer error state, the queue's
//     status flags, "use printer offline");
//   * the queue over time (from the snapshot history).
// Each source's findings are normalised to the same signal names and merged,
// so a paper jam reported by both the printer and Windows is one issue
// ("confirmed by 2 sources"), and every issue carries the remote fixes that
// apply to it (bring online, resume, restart / cancel the stuck job).
//
// A queue is "stuck" when its first job hasn't printed a page for 3 minutes
// while nothing physical explains it. Print speed is learned per printer from
// the history (median pages per minute while a job was printing) and used
// for queue wait times.
// ---------------------------------------------------------------

const STALE_MS = 2 * 60 * 1000;
const STUCK_MS = 3 * 60 * 1000;
const DEFAULT_PPM = 20;

// Win32_Printer.DetectedErrorState
const WIN_ERROR = { 3: 'low_paper', 4: 'no_paper', 5: 'low_toner', 6: 'no_toner', 7: 'door_open', 8: 'jammed', 9: 'offline', 10: 'service_requested', 11: 'output_full' };
// Get-Printer PrinterStatus flag names
const WIN_STATE = {
  Paused: 'paused', PaperJam: 'jammed', PaperOut: 'no_paper', Offline: 'offline', DoorOpen: 'door_open', NoToner: 'no_toner',
  TonerLow: 'low_toner', OutputBinFull: 'output_full', UserIntervention: 'service_requested', PaperProblem: 'paper_problem',
  NotAvailable: 'not_available', OutOfMemory: 'out_of_memory', Error: 'error'
};

const flags = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const hasFlag = (s, f) => flags(s).includes(f);
const listNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Pages per minute while printing, learned from consecutive snapshots. */
function learnSpeed(history) {
  const rates = [];
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1];
    const b = history[i];
    const minutes = (Date.parse(b.at) - Date.parse(a.at)) / 60000;
    if (!(minutes > 0.02) || minutes > 10) continue;
    let pages = 0;
    for (const jb of b.jobs || []) {
      const ja = (a.jobs || []).find((j) => j.id === jb.id && j.document === jb.document);
      if (ja && jb.pages_printed > ja.pages_printed) pages += jb.pages_printed - ja.pages_printed;
    }
    if (pages > 0) rates.push(pages / minutes);
  }
  const m = median(rates.slice(-30));
  return m ? { ppm: Math.max(1, Math.min(150, Math.round(m))), source: 'learned', samples: rates.length } : { ppm: DEFAULT_PPM, source: 'default', samples: 0 };
}

function orderedJobs(jobs) {
  return [...(jobs || [])].sort((a, b) => (a.position || 0) - (b.position || 0) || (a.id - b.id));
}

/** How long the first job has gone without printing a page (ms), from the history. */
function headStallMs(head, history, nowMs) {
  if (!head) return 0;
  let since = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const first = orderedJobs(h.jobs)[0];
    if (!first || first.id !== head.id || first.document !== head.document || first.pages_printed !== head.pages_printed) break;
    since = Date.parse(h.at);
  }
  return since === null ? 0 : nowMs - since;
}

/**
 * state: one printer from the agent's snapshot; meta: { updated_at, now };
 * history: [{ at, jobs }] oldest first. Returns the diagnosis.
 */
function diagnose(state, meta, history = []) {
  const nowMs = meta.now ?? Date.now();
  const device = state.device || null;
  const jobs = orderedJobs(state.jobs);
  const head = jobs[0] || null;
  const waiting = jobs.length > 0;

  // ---- 1. Merge signals from every source
  const signals = new Map(); // name -> Set(sources)
  const add = (name, source) => {
    if (!signals.has(name)) signals.set(name, new Set());
    signals.get(name).add(source);
  };
  if (device && device.reachable) for (const e of device.errors || []) add(e === 'input_tray_empty' ? 'no_paper' : e, 'printer');
  if (device && device.reachable && device.device_status === 'down') add('down', 'printer');
  if (WIN_ERROR[state.detected_error_state]) add(WIN_ERROR[state.detected_error_state], 'windows');
  for (const f of flags(state.state)) if (WIN_STATE[f]) add(WIN_STATE[f], 'windows');
  if (state.printer_status === 7) add('offline', 'windows');
  if (state.work_offline) add('windows_offline', 'windows');
  if (device && device.reachable === false) add('unreachable', 'network');
  // A printer that answers on the network isn't "offline", whatever Windows thinks.
  if (signals.has('unreachable') && signals.has('offline')) signals.delete('offline');
  if (device && device.reachable && signals.has('offline') && !(device.errors || []).includes('offline')) signals.delete('offline');

  const trays = (device && device.trays) || [];
  const emptyTrays = trays.filter((t) => t.empty).map((t) => t.name);
  const lowTrays = trays.filter((t) => t.percent !== null && t.percent > 0 && t.percent <= 15).map((t) => `${t.name} (${t.percent}%)`);
  const openCovers = ((device && device.covers) || []).filter((c) => c.status === 'open').map((c) => c.name);
  if (openCovers.length) add('door_open', 'printer');
  // Trays: every tray with a known level empty means out of paper; one empty
  // tray while another still has paper is only worth a heads-up.
  const knownTrays = trays.filter((t) => t.level !== null && t.level !== -2);
  const someEmptyTray = emptyTrays.length > 0 && !signals.has('no_paper');
  if (someEmptyTray && knownTrays.every((t) => t.empty)) add('no_paper', 'printer');
  // "Use printer offline" makes Windows report the printer offline too: one cause, one issue.
  if (signals.has('windows_offline') && signals.has('offline') && [...signals.get('offline')].every((src) => src === 'windows')) signals.delete('offline');
  const screen = ((device && device.display) || []).join(' · ');

  // ---- 2. Issues
  const issues = [];
  const issue = (key, severity, title, detail, steps = [], fixes = []) => {
    const sources = signals.get(key);
    issues.push({ key, severity, title, detail, steps, fixes, sources: sources ? [...sources] : [] });
  };
  const jobFixes = (job, ...actions) => (job ? actions.map((a) => ({
    action: a,
    label: { restart_job: `Restart "${job.document}"`, cancel_job: `Cancel "${job.document}"`, resume_job: `Release "${job.document}"` }[a],
    params: { job_id: job.id, document: job.document }
  })) : []);
  const queueNote = waiting ? ` ${jobs.length} job${jobs.length === 1 ? ' is' : 's are'} waiting.` : '';

  const updatedMs = Date.parse(meta.updated_at);
  const stale = !Number.isFinite(updatedMs) || nowMs - updatedMs > STALE_MS;
  if (stale) {
    issue('agent_offline', 'critical', "The PC with this printer isn't reporting",
      'Status below is from the last report. The print agent on that PC may be stopped, or the PC is off or offline. Actions will wait until it reports again (and expire after a few minutes).',
      ['Check the PC is on and connected', 'Make sure the print agent (PrintMonitorAgent) is running on it']);
  }
  if (signals.has('windows_offline')) {
    issue('windows_offline', 'critical', 'Windows is set to use this printer offline',
      `Jobs stay in the queue until it's back online.${queueNote}`, [], [{ action: 'set_online', label: 'Bring online' }]);
  }
  if (signals.has('unreachable')) {
    issue('unreachable', waiting ? 'critical' : 'warning', "The printer isn't answering on the network",
      `No reply from ${state.host || 'its network address'}.${queueNote}`,
      ['Check the printer is switched on and awake', 'Check its network cable or Wi-Fi', "If its IP address changed, update the printer's port on the PC"]);
  }
  if (signals.has('down')) issue('down', 'critical', 'The printer reports it has stopped', screen ? `Its screen says: ${screen}` : 'It needs attention at the device.', ['Look at the printer screen', 'Switch it off and on again if it stays stopped']);
  if (signals.has('offline')) {
    issue('offline', 'critical', 'The printer is offline', `It won't take jobs.${queueNote}`,
      ['Press the Online / Ready button on the printer if it has one', 'Check the power and the cable']);
  }
  if (signals.has('jammed')) {
    issue('jammed', 'critical', 'Paper jam', screen ? `The printer says: ${screen}` : 'Paper is stuck inside the printer.',
      [`Open ${openCovers.length ? listNames(openCovers) : 'the front door'} and gently pull the paper out`, 'Close every door', head ? `If "${head.document}" came out incomplete, restart it` : 'Print again if anything came out incomplete'],
      jobFixes(head, 'restart_job'));
  }
  if (signals.has('door_open')) {
    issue('door_open', 'critical', `${openCovers.length ? listNames(openCovers) : 'A door or cover'} ${openCovers.length > 1 ? 'are' : 'is'} open`,
      'The printer stops until it is closed.', ['Close it firmly until it clicks']);
  }
  if (signals.has('no_paper')) {
    const media = trays.find((t) => t.empty && t.media);
    issue('no_paper', waiting ? 'critical' : 'warning', `Out of paper${emptyTrays.length ? ` in ${listNames(emptyTrays)}` : ''}`,
      `${media ? `Load ${media.media} paper.` : 'Load paper.'}${queueNote}`,
      [`Load paper in ${emptyTrays.length ? listNames(emptyTrays) : 'the tray'}`, 'Printing continues on its own once paper is in']);
  } else if (someEmptyTray) {
    issue('tray_empty', 'warning', `${listNames(emptyTrays)} ${emptyTrays.length > 1 ? 'are' : 'is'} empty`,
      'The printer can still use its other trays, but jobs that need this one will wait.', [`Load paper in ${listNames(emptyTrays)}`]);
  } else if (signals.has('low_paper') || lowTrays.length) {
    issue('low_paper', 'warning', `Paper running low${lowTrays.length ? `: ${listNames(lowTrays)}` : ''}`, 'Top it up before the next big job.', []);
  }
  if (signals.has('no_toner')) issue('no_toner', 'critical', 'Toner or ink is empty', 'Replace the cartridge to keep printing.', ['Replace the empty cartridge']);
  else if (signals.has('low_toner')) issue('low_toner', 'warning', 'Toner or ink is low', 'Have a replacement ready.', []);
  if (signals.has('output_full')) issue('output_full', 'critical', 'The output tray is full', 'The printer stops until it is emptied.', ['Take the printed pages out of the output tray']);
  else if (signals.has('output_near_full')) issue('output_near_full', 'warning', 'The output tray is nearly full', '', ['Take the printed pages out']);
  for (const [key, label] of [['marker_supply_missing', 'A cartridge is missing or not seated'], ['input_tray_missing', 'A paper tray is missing or not pushed in'], ['output_tray_missing', 'The output tray is missing']]) {
    if (signals.has(key)) issue(key, 'critical', label, '', ['Check every cartridge and tray is pushed fully in']);
  }
  if (signals.has('paper_problem')) issue('paper_problem', 'warning', 'Paper problem', screen || 'Wrong paper size or type for this job.', ['Check the paper size and type loaded match the job']);
  if (signals.has('out_of_memory')) issue('out_of_memory', 'warning', 'The printer ran out of memory', 'Large or complex jobs may not print.', [], jobFixes(head, 'restart_job', 'cancel_job'));
  if (signals.has('service_requested')) issue('service_requested', 'warning', 'The printer needs attention', screen ? `Its screen says: ${screen}` : 'Check the message on the printer.', []);
  if (signals.has('overdue_maintenance')) issue('overdue_maintenance', 'info', 'Maintenance is due', 'Book a service when convenient.', []);
  if (signals.has('paused')) {
    issue('paused', waiting ? 'warning' : 'info', 'Printing is paused', `Someone paused this printer in Windows.${queueNote}`, [], [{ action: 'resume_printer', label: 'Resume printing' }]);
  }

  // ---- 3. The queue itself
  const physical = issues.some((i) => i.severity === 'critical');
  for (const job of jobs) {
    if (hasFlag(job.status, 'Error') || hasFlag(job.status, 'Blocked')) {
      issues.push({ key: `job_error:${job.id}`, severity: physical ? 'warning' : 'critical', title: `"${job.document}" hit an error`,
        detail: physical ? 'Probably because of the problem above; restart it once that is fixed.' : 'Restart it, or cancel it so the jobs behind it can print.',
        steps: [], fixes: jobFixes(job, 'restart_job', 'cancel_job'), sources: ['windows'] });
    } else if (hasFlag(job.status, 'Paused')) {
      issues.push({ key: `job_paused:${job.id}`, severity: 'info', title: `"${job.document}" is on hold`, detail: 'It will not print until released.', steps: [], fixes: jobFixes(job, 'resume_job', 'cancel_job'), sources: ['windows'] });
    }
  }
  const stallMs = headStallMs(head, history, nowMs);
  const headHeld = head && (hasFlag(head.status, 'Paused') || hasFlag(head.status, 'Error'));
  const stuck = head && !stale && !physical && !signals.has('paused') && !headHeld && stallMs >= STUCK_MS;
  if (stuck) {
    issues.push({ key: 'queue_stuck', severity: 'warning', title: `"${head.document}" hasn't moved for ${Math.round(stallMs / 60000)} min`,
      detail: `Nothing is reported wrong with the printer, but the queue isn't moving.${jobs.length > 1 ? ` ${jobs.length - 1} job${jobs.length === 2 ? ' is' : 's are'} stuck behind it.` : ''}`,
      steps: ['Restart the job; if it sticks again, cancel it and print it again'], fixes: jobFixes(head, 'restart_job', 'cancel_job'), sources: ['queue'] });
  }

  // ---- 4. Wait times
  const speed = learnSpeed(history);
  const blocked = physical || signals.has('paused') || stale;
  let cumulative = 0;
  const queue = jobs.map((j) => {
    const total = j.total_pages > 0 ? j.total_pages : null;
    const remaining = total ? Math.max(total - (j.pages_printed || 0), 0) : 1;
    cumulative += remaining;
    return {
      ...j,
      progress: total ? Math.min(1, (j.pages_printed || 0) / total) : null,
      eta_min: blocked || ['Paused', 'Error', 'Blocked'].some((f) => hasFlag(j.status, f)) ? null : Math.max(1, Math.round(cumulative / speed.ppm))
    };
  });

  const rank = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  for (const i of issues) if (i.sources.length > 1) i.confirmed = true;

  let health = 'ready';
  if (stale) health = 'offline';
  else if (issues.some((i) => i.severity === 'critical')) health = 'error';
  else if (issues.some((i) => i.severity === 'warning')) health = 'warning';
  else if (waiting) health = 'busy';
  const last = queue[queue.length - 1];
  const headline = issues.length && issues[0].severity !== 'info' ? issues[0].title
    : waiting ? `Printing · ${jobs.length} job${jobs.length === 1 ? '' : 's'}${last && last.eta_min ? ` · about ${last.eta_min} min` : ''}` : 'Ready';

  return { health, headline, issues, queue, speed, stalled_job_id: stuck ? head.id : null, screen: (device && device.display) || [] };
}

module.exports = { diagnose, learnSpeed, headStallMs, STALE_MS, STUCK_MS };
