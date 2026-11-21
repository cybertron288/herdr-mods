// yt-music daemon: the one process that talks to Chrome, for every copy of the mod.
//
//   osascript -l JavaScript daemon.js <data dir>
//
// The mod starts it once as a herdr-core terminal named ytm-<hash of this file>, so there
// is never a second one, and it stays out of Herdr's screens. It keeps one Apple Events
// connection to Chrome open for its whole life instead of a new osascript per read.
//
// Every second it reads the YT Music tab (a cached tab; looked for again every 5 s when
// there is none) and writes <data dir>/state.json only when something changed: another
// track, play/pause, a seek. The mod watches that folder and moves the clock itself.
// The mod asks for actions by writing <data dir>/cmd.json { action, n }.
ObjC.import("Foundation");

const READ_JS = `(() => {
  const v = document.querySelector('video'), m = navigator.mediaSession.metadata
  if (!v || !m) return ''
  return JSON.stringify({ title: m.title, artist: m.artist, paused: v.paused, seconds: v.currentTime, duration: v.duration || 0 })
})()`;

// By class, not aria-label: the label follows the page language ("Siguiente", "Weiter").
const press = (cls, label) => `document.querySelector('ytmusic-player-bar .${cls}-button, ytmusic-wiz-player-controls [aria-label="${label}"], ytmusic-player-bar [aria-label="${label}"]')?.click()`;
const SEEK = 10;
const ACTIONS = {
  previous: press("previous", "Previous"),
  back: `(v => { v.currentTime = Math.max(0, v.currentTime - ${SEEK}) })(document.querySelector('video'))`,
  toggle: `(v => v.paused ? v.play() : v.pause())(document.querySelector('video'))`,
  forward: `(v => { v.currentTime = v.currentTime + ${SEEK} })(document.querySelector('video'))`,
  next: press("next", "Next"),
};

// Chromium browsers that take "execute javascript" over Apple Events, by bundle id. The
// first running one with a music.youtube.com tab wins.
const BROWSERS = [
  ["com.google.Chrome", "Chrome"],
  ["com.brave.Browser", "Brave"],
  ["com.microsoft.edgemac", "Edge"],
  ["com.vivaldi.Vivaldi", "Vivaldi"],
  ["org.chromium.Chromium", "Chromium"],
];

const TICK = 0.5; // s: how often cmd.json is looked at
const READ_EVERY = 2; // ticks between reads while a tab plays (1 s)
const LOOK_EVERY = 10; // ticks between looks for Chrome or the tab (5 s)

function run(argv) {
  const dir = argv[0];
  const STATE = `${dir}/state.json`, CMD = `${dir}/cmd.json`;
  const fm = $.NSFileManager.defaultManager;
  const readFile = (p) => {
    const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
    return s.isNil() ? null : ObjC.unwrap(s);
  };
  const writeFile = (p, text) => $(text).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null);

  // Only installed browsers: Application(id) throws for one that isn't, and it never
  // launches anything by itself.
  const browsers = BROWSERS.flatMap(([id, name]) => { try { return [{ id, name, app: Application(id) }]; } catch (_) { return []; } });
  let found = null; // the browser whose tab we last read
  let tab = null, last = null, written = "", tick = 0, lastCmd = null;

  const publish = (state) => {
    const text = JSON.stringify(state);
    if (text === written) return;
    written = text;
    writeFile(STATE, text);
  };

  // Runs js in the first music.youtube.com tab through AppleScript, which can bound the
  // wait: a Chrome that takes the Apple Event and never answers would hold this loop for the
  // default 2 minutes (JXA has no timeout setting), and every button press behind it.
  // After 3 s it gives up and the loop looks again. { out } | { none } | { off } | { gone }.
  const MARK_NONE = "\u0001none";
  const compiled = new Map();
  const exec = (js, b) => {
    const lit = js.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    const src = [
      "with timeout of 3 seconds",
      "tell application id \"" + b.id + "\"",
      "repeat with w in windows",
      "repeat with t in tabs of w",
      "if URL of t contains \"music.youtube.com\" then return execute t javascript \"" + lit + "\"",
      "end repeat",
      "end repeat",
      "return \"" + MARK_NONE + "\"",
      "end tell",
      "end timeout",
    ].join("\n");
    const err = Ref();
    // One compiled script per distinct js, kept: compiling a new NSAppleScript twice a second
    // piled up Objective-C objects until osascript crashed (signal 11) after about 50 s.
    let script = compiled.get(src);
    if (!script) { script = $.NSAppleScript.alloc.initWithSource(src); compiled.set(src, script); }
    const r = script.executeAndReturnError(err);
    if (r.isNil()) {
      const msg = String(ObjC.unwrap(err[0] && err[0].objectForKey ? err[0].objectForKey("NSAppleScriptErrorMessage") : "") ?? "");
      if (/turned off|Allow JavaScript/i.test(msg)) return { off: true };
      return { gone: true }; // timed out, or Chrome went away: look again
    }
    const out = ObjC.unwrap(r.stringValue);
    return out === MARK_NONE ? { none: true } : { out: out ?? "" };
  };

  // Asking a browser that isn't running would launch it.
  const up = () => browsers.filter((b) => b.app.running());

  // The browser that had the tab goes first; then the others that run.
  const readAny = () => {
    let running = up();
    if (running.includes(found)) running = [found, ...running.filter((b) => b !== found)];
    for (const b of running) {
      const r = exec(READ_JS, b);
      if (r.off) return { off: b.name };
      if (r.out) { found = b; return r; }
    }
    found = null;
    return {};
  };

  const read = () => {
    const r = readAny();
    tab = r.out ? true : null;
    if (r.off) { last = null; return publish({ error: "js-off", browser: r.off }); }
    if (!r.out) { last = null; return publish(null); }
    let t;
    try { t = JSON.parse(r.out); } catch (_) { return; }
    const now = Date.now();
    // The clock runs on in the mod; only a jump (a seek, a new track) is news.
    const expected = last ? last.seconds + (last.paused ? 0 : (now - last.at) / 1000) : null;
    const same = last && last.title === t.title && last.artist === t.artist && last.paused === t.paused
      && Math.abs(last.duration - t.duration) < 1 && Math.abs(expected - t.seconds) < 2;
    if (same) return;
    last = { ...t, at: now };
    publish(last);
  };

  for (;;) {
    const cmdText = readFile(CMD);
    if (cmdText && cmdText !== lastCmd) {
      lastCmd = cmdText;
      fm.removeItemAtPathError(CMD, null);
      let cmd = null;
      try { cmd = JSON.parse(cmdText); } catch (_) {}
      if (cmd?.action === "quit") { publish(null); return; }
      // A press left from before this daemon started (it was down) is not replayed.
      if (ACTIONS[cmd?.action] && Date.now() - (cmd.n || 0) < 5000) {
        // A press can come before the first read has found the tab.
        if (!found?.app.running()) readAny();
        if (found) exec(ACTIONS[cmd.action], found);
        last = null; // read it fresh now
        read();
      }
    }
    tick++;
    if (tick % (tab ? READ_EVERY : LOOK_EVERY) === 0) {
      try { read(); } catch (_) { tab = null; last = null; }
    }
    delay(TICK);
  }
}
