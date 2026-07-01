// bgtimer.worker.js — an unthrottled timer service.
//
// A backgrounded tab throttles setTimeout on the MAIN thread to ~1/min, but a Worker's timers keep
// firing on time, and the `message` it posts back is handled on the main thread unthrottled too. So
// the main thread arms a delay here and gets woken on schedule even while hidden. DOM-free, no
// imports. Protocol: {arm:{id,ms}} schedules; {cancel:id} clears; fires back {fire:id}.
const timers = new Map();   // id -> timeout handle

onmessage = (e) => {
    const m = e.data || {};
    if (m.arm) {
        const { id, ms } = m.arm;
        clearTimeout(timers.get(id));
        timers.set(id, setTimeout(() => { timers.delete(id); postMessage({ fire: id }); }, ms));
    } else if (m.cancel != null) {
        clearTimeout(timers.get(m.cancel));
        timers.delete(m.cancel);
    }
};
