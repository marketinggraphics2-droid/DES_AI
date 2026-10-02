// Imported FIRST by server.js, before the database opens, so a stop request that arrives during startup
// (Ctrl+C, dev-runner reload, runner gone, npm run stop) is never lost: it is held and run as a clean shutdown
// as soon as the server registers its shutdown function.
let handler = null, pending = null;
const request = (why, code = 0) => { if (handler) handler(why, code); else pending ??= [why, code]; };

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => request(sig));
process.on('message', (m) => { if (m === 'shutdown') request('dev reload'); });       // from scripts/dev.js
process.on('disconnect', () => request('dev runner exited'));                          // runner closed or crashed
for (const s of [process.stdout, process.stderr]) s.on('error', () => { });            // EPIPE once the runner's console is gone

export function onStop(fn) { handler = fn; if (pending) fn(...pending); }
export const requestStop = request;
