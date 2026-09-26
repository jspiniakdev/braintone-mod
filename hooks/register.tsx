// BrainTone Mod: /braintone opens a small pane with the day's challenges while Claude works.
// Esc closes it, from any screen. The Mod is a thin client: the welcome line, the theme labels,
// the challenges, the feedback and the day's limit all come from the server (braintone-server/).
//
//   GET  <server_url>/v1/menu?player_id=…
//   GET  <server_url>/v1/challenges?player_id=…&theme=…   a theme's challenges, in order
//   POST <server_url>/v1/challenges/open   { player_id, challenge_id }
//   POST <server_url>/v1/answers           { player_id, challenge_id, answer, answer_ms, skipped }
//
// No daily limit: the player picks any challenge in a theme and can redo the ones marked DONE.
// A theme's list is shown in a random order, PAGE at a time; "see more" turns to the next page.
//
// See the Terminal UI spec for the screens drawn here.

import type { Register, EngineInterface } from "claude-code";

const PANE = "braintone";
const PLAYER_KEY = "playerId";
const TOKEN_KEY = "token"; // this install's token, from swapping the invite (POST /v1/register)
const RESUME_KEY = "resume"; // where the player was, so a new Claude session can go back there
const MAX_LINES = 20;
const TIMEOUT_MS = 30_000; // grading can take a few seconds (Backend spec: wait up to 30 s)
const UNREACHABLE = "Couldn't reach BrainTone just now.";
const PAGE = 5; // challenges shown per theme before "see more"

type Theme = { theme: string; label: string; done: number; total: number };
// The player's points: the running score, what today added, and the best day so far.
type Tally = { total: number; today: number; bestDay: number };
type Menu = { welcome: string; themes: Theme[]; tally: Tally | null };
type Item = { id: string; title: string; done: boolean };
type List = { theme: string; label: string; items: Item[] };
type Format = "choice" | "line" | "paragraph";
type Challenge = {
  id: string;
  label: string;
  done: boolean;
  format: Format;
  prompt: string;
  options: string[];
  maxLines: number;
};
type Points = { earned: number | null; tally: Tally | null; newBest: boolean };
type Result = (
  | { kind: "outcome"; outcome: string; feedback: string }
  | { kind: "score"; score: number; feedback: string }
) & Points;

type Screen =
  | { kind: "idle" } // nothing loaded yet; the next draw fetches the menu
  | { kind: "loading" }
  | { kind: "menu"; menu: Menu }
  | { kind: "list" }
  | { kind: "challenge" }
  | { kind: "waiting" }
  | { kind: "result"; result: Result }
  | { kind: "error"; message: string; retry: Retry };

// What "try again" on an error does.
// What is saved to resume from, in the plugin's store.
type Resume =
  | { view: "menu" }
  | { view: "list"; theme: string }
  | { view: "challenge"; theme: string; challengeId: string; lines: string[]; draft: string };

type Retry =
  | { to: "menu" }
  | { to: "list"; theme: string }
  | { to: "challenge"; id: string }
  | { to: "answer" }
  | { to: "skip" };

class ServerError extends Error {}

// ---- reading the server's replies ----

// A server that doesn't send points yet leaves them null, and the lines are simply left out.
function parseTally(data: any): Tally | null {
  if (!data || typeof data !== "object") return null;
  const total = Number(data.total);
  const today = Number(data.today);
  const bestDay = Number(data.best_day);
  if (![total, today, bestDay].every(Number.isFinite)) return null;
  return { total, today, bestDay };
}

function parseMenu(data: any): Menu {
  const themes: Theme[] = (Array.isArray(data.themes) ? data.themes : [])
    .filter((t: any) => t && typeof t.theme === "string" && typeof t.label === "string")
    .slice(0, 9)
    .map((t: any) => ({ theme: t.theme, label: t.label, done: Number(t.done) || 0, total: Number(t.total) || 0 }));
  if (typeof data.welcome !== "string" || themes.length === 0) throw new ServerError(UNREACHABLE);
  return { welcome: data.welcome, themes, tally: parseTally(data.tally) };
}

function parseList(data: any, theme: string): List {
  const items: Item[] = (Array.isArray(data.challenges) ? data.challenges : [])
    .filter((c: any) => c && typeof c.challenge_id === "string")
    .map((c: any) => ({
      id: c.challenge_id,
      title: typeof c.title === "string" && c.title ? c.title : c.challenge_id,
      done: c.done === true,
    }));
  if (items.length === 0) throw new ServerError(UNREACHABLE);
  return { theme, label: typeof data.theme_label === "string" ? data.theme_label : theme, items };
}

function parseChallenge(data: any): Challenge {
  const format = data.format as Format;
  if (typeof data.challenge_id !== "string" || typeof data.prompt !== "string") throw new ServerError(UNREACHABLE);
  if (!["choice", "line", "paragraph"].includes(format)) throw new ServerError(UNREACHABLE);
  const options = Array.isArray(data.options) ? data.options.slice(0, 9).map(String) : [];
  if (format === "choice" && options.length < 2) throw new ServerError(UNREACHABLE);
  const maxLines = format === "paragraph" ? Math.min(MAX_LINES, Math.max(1, Number(data.max_lines) || MAX_LINES)) : 1;
  return {
    id: data.challenge_id,
    label: typeof data.theme_label === "string" ? data.theme_label : String(data.theme ?? ""),
    done: data.done === true,
    format,
    prompt: data.prompt,
    options,
    maxLines,
  };
}

function parseResult(data: any): Result {
  const feedback = typeof data.feedback === "string" ? data.feedback : "";
  const points: Points = {
    earned: Number.isFinite(Number(data.earned)) && data.earned !== null ? Number(data.earned) : null,
    tally: parseTally(data.tally),
    newBest: data.new_best_day === true,
  };
  if (data.kind === "score" && typeof data.score === "number") return { kind: "score", score: data.score, feedback, ...points };
  if (data.kind === "outcome" && typeof data.outcome === "string") return { kind: "outcome", outcome: data.outcome, feedback, ...points };
  throw new ServerError(UNREACHABLE);
}

function headline(result: Result): string {
  if (result.kind === "score") return `${result.score} / 10`;
  if (result.outcome === "correct") return "Correct.";
  if (result.outcome === "incorrect") return "Not quite.";
  return result.outcome;
}

function menuTally(t: Tally): string {
  return `score ${t.total} · today +${t.today} · best day ${t.bestDay}`;
}

// Under a result: what this answer added, then the running totals.
function resultTally(r: Result): string | null {
  if (!r.tally) return null;
  const gained = r.earned ? `+${r.earned} · ` : "";
  return `${gained}today ${r.tally.today} · score ${r.tally.total}`;
}

function newPlayerId(): string {
  const uuid = (globalThis as any).crypto?.randomUUID?.();
  return `p_${uuid ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`}`;
}

// A new random order: Fisher-Yates.
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// Puts a freshly fetched list in the order the player has been seeing. Challenges no longer
// on the server drop out, and new ones join the end in a random order.
function arrange(items: Item[], keep: string[]): Item[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const kept = keep.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const known = new Set(keep);
  return [...kept, ...shuffled(items.filter((item) => !known.has(item.id)))];
}

function completed(result: Result): boolean {
  return result.kind === "score" || result.outcome === "correct";
}

// ---- state ----
// It lives as long as the plugin is loaded, so reopening in the same session returns to the same
// place. Where the player was is also saved to the store, so a new session can go back there.
let screen: Screen = { kind: "idle" };
let resumed = false; // whether this session has looked for a saved place yet
let playerId: string | undefined;
let list: List | null = null; // the theme being played, in the order shown
let page = 0; // which PAGE of the list is on screen
let challenge: Challenge | null = null;
let lines: string[] = []; // a paragraph answer so far
let draft = ""; // a one-line answer that failed to send, put back in the field
let shownAt = 0;

const DEFAULT_SERVER = "https://api.braintone.ai";
let serverUrl = DEFAULT_SERVER;
let invite = ""; // the invite code from the install command; empty for a server without invites
let token: string | undefined;

function redraw($: EngineInterface) {
  $.ui.invalidate("ui.render");
}

function go($: EngineInterface, next: Screen) {
  screen = next;
  redraw($);
  save($);
  focusMain($);
}

// The element that should hold the keyboard on the current screen. The pane applies `autoFocus`
// only when it first opens, so every later screen moves the focus itself.
function mainKey(): string | undefined {
  switch (screen.kind) {
    case "menu":
      return "theme-0";
    case "list":
      return "ch-0";
    case "result":
      return completed(screen.result) && nextInList() ? "next" : "again";
    case "error":
      return "retry";
    case "challenge":
      if (!challenge) return undefined;
      if (challenge.format === "choice") return "opt-0";
      if (challenge.format === "line") return "answer";
      return lines.length >= challenge.maxLines ? "send" : `line-${lines.length + 1}`;
    default:
      return undefined;
  }
}

// Waits for the element to be drawn, then moves the keyboard onto it. A refusal (the pane is
// closed, or the screen moved on meanwhile) is harmless, so it is dropped.
function focusMain($: EngineInterface) {
  const key = mainKey();
  if (key === undefined) return;
  Promise.resolve()
    .then(() => $.ui.focus({ requestId: PANE, key }))
    .catch(() => undefined);
}

function snapshot(): Resume | undefined {
  switch (screen.kind) {
    case "menu":
      return { view: "menu" };
    case "list":
      return list ? { view: "list", theme: list.theme } : undefined;
    case "challenge":
    case "waiting":
    case "result":
      return list && challenge
        ? { view: "challenge", theme: list.theme, challengeId: challenge.id, lines: [...lines], draft }
        : undefined;
    default:
      return undefined; // loading and errors are passing states: keep the last place
  }
}

function save($: EngineInterface) {
  const place = snapshot();
  if (place === undefined) return;
  Promise.resolve()
    .then(() => $.store.set(RESUME_KEY, place))
    .catch(() => undefined);
}

// First /braintone in a session: go back to where the player was last time, typed text included.
async function resume($: EngineInterface) {
  let place: any;
  try {
    place = await $.store.get(RESUME_KEY);
  } catch {
    place = undefined;
  }
  if (place?.view === "challenge" && typeof place.theme === "string" && typeof place.challengeId === "string") {
    await openTheme($, place.theme, { quiet: true });
    if (!list) return;
    const saved = {
      lines: Array.isArray(place.lines) ? place.lines.map(String) : [],
      draft: typeof place.draft === "string" ? place.draft : "",
    };
    await openChallenge($, place.challengeId, saved);
  } else if (place?.view === "list" && typeof place.theme === "string") {
    await openTheme($, place.theme);
  } else {
    await loadMenu($);
  }
}

async function player($: EngineInterface): Promise<string> {
  if (playerId) return playerId;
  const saved = await $.store.get(PLAYER_KEY);
  if (typeof saved === "string" && saved) return (playerId = saved);
  playerId = newPlayerId();
  await $.store.set(PLAYER_KEY, playerId);
  return playerId;
}

// The token this install plays with: saved, or got once by swapping the invite for one.
async function authToken($: EngineInterface): Promise<string | undefined> {
  if (token) return token;
  const saved = await $.store.get(TOKEN_KEY);
  if (typeof saved === "string" && saved) return (token = saved);
  if (!invite) return undefined;
  const data = await call($, "/v1/register", { invite });
  if (typeof data.token !== "string" || !data.token) throw new ServerError(UNREACHABLE);
  token = data.token;
  await $.store.set(TOKEN_KEY, token);
  return token;
}

async function call($: EngineInterface, path: string, body?: object): Promise<any> {
  const bearer = path === "/v1/register" ? undefined : await authToken($);
  const headers: Record<string, string> = { accept: "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const init =
    body === undefined
      ? { headers }
      : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ServerError(UNREACHABLE)), TIMEOUT_MS);
  });
  let res: { ok: boolean; status?: number; text: string };
  try {
    res = await Promise.race([$.http.fetch(`${serverUrl}${path}`, init), timeout]);
  } catch {
    throw new ServerError(UNREACHABLE);
  } finally {
    clearTimeout(timer);
  }
  let data: any;
  try {
    data = JSON.parse(res.text);
  } catch {
    data = undefined;
  }
  // A refused token is forgotten, so the next call swaps the invite again (a new invite, after a reinstall).
  if (res.status === 401 && bearer) {
    token = undefined;
    await $.store.set(TOKEN_KEY, "");
  }
  // Errors come as { error: { code, message } }; the message is written for the player.
  if (!res.ok) throw new ServerError(typeof data?.error?.message === "string" ? data.error.message : UNREACHABLE);
  if (!data || typeof data !== "object") throw new ServerError(UNREACHABLE);
  return data;
}

function messageOf(err: unknown): string {
  return err instanceof ServerError ? err.message : UNREACHABLE;
}

async function loadMenu($: EngineInterface) {
  go($, { kind: "loading" });
  try {
    const id = await player($);
    const menu = parseMenu(await call($, `/v1/menu?player_id=${encodeURIComponent(id)}`));
    go($, { kind: "menu", menu });
  } catch (err) {
    go($, { kind: "error", message: messageOf(err), retry: { to: "menu" } });
  }
}

function startAnswering() {
  lines = [];
  draft = "";
  shownAt = Date.now();
}

// `quiet` loads the list without showing it, when resuming straight into one of its challenges.
// `shuffle` deals a new random order; otherwise the order the player has been seeing is kept.
async function openTheme($: EngineInterface, theme: string, opts: { quiet?: boolean; shuffle?: boolean } = {}) {
  const keep = !opts.shuffle && list?.theme === theme ? list.items.map((item) => item.id) : [];
  go($, { kind: "loading" });
  try {
    const id = await player($);
    const data = await call($, `/v1/challenges?player_id=${encodeURIComponent(id)}&theme=${encodeURIComponent(theme)}`);
    const fetched = parseList(data, theme);
    list = { ...fetched, items: arrange(fetched.items, keep) };
    if (keep.length === 0) page = 0;
    challenge = null;
    if (!opts.quiet) go($, { kind: "list" });
  } catch (err) {
    go($, { kind: "error", message: messageOf(err), retry: { to: "list", theme } });
  }
}

// `saved` puts back what was typed, when resuming.
async function openChallenge($: EngineInterface, id: string, saved?: { lines: string[]; draft: string }) {
  go($, { kind: "loading" });
  try {
    const data = await call($, "/v1/challenges/open", { player_id: await player($), challenge_id: id });
    challenge = parseChallenge(data);
    startAnswering();
    if (saved) {
      lines = saved.lines.slice(0, challenge.maxLines);
      draft = saved.draft;
    }
    go($, { kind: "challenge" });
  } catch (err) {
    go($, { kind: "error", message: messageOf(err), retry: { to: "challenge", id } });
  }
}

// What "next challenge" opens: the first one not yet done after this one in the list's order,
// wrapping around to the start; if every other one is done, simply the one after this.
function nextInList(): Item | undefined {
  if (!list || !challenge) return undefined;
  const items = list.items;
  const at = items.findIndex((item) => item.id === challenge!.id);
  if (at < 0) return undefined;
  const rest = [...items.slice(at + 1), ...items.slice(0, at)];
  return rest.find((item) => !item.done) ?? items[at + 1];
}

// Opens the next challenge, and turns the list to its page for when the player goes back.
function openNext($: EngineInterface, item: Item) {
  const at = list ? list.items.findIndex((i) => i.id === item.id) : -1;
  if (at >= 0) page = Math.floor(at / PAGE);
  void openChallenge($, item.id);
}

// Where this challenge sits in its theme, for the challenge screen's title.
function position(): string {
  if (!list || !challenge) return "";
  const at = list.items.findIndex((item) => item.id === challenge!.id);
  return at >= 0 ? ` · ${at + 1}/${list.items.length}` : "";
}

// Sends an answer and waits for the verdict. If the pane is closed meanwhile, the answer
// still goes out and the result is here when /braintone is reopened.
async function send($: EngineInterface, answer: string) {
  const c = challenge;
  if (!c) return;
  go($, { kind: "waiting" });
  try {
    const data = await call($, "/v1/answers", {
      player_id: await player($),
      challenge_id: c.id,
      answer,
      answer_ms: Date.now() - shownAt,
      skipped: false,
    });
    go($, { kind: "result", result: parseResult(data) });
  } catch (err) {
    // Typed text is never lost: "try again" goes back to the answer area as it was.
    go($, { kind: "error", message: messageOf(err), retry: { to: "answer" } });
  }
}

async function skip($: EngineInterface) {
  const c = challenge;
  if (!c) return void backToList($);
  go($, { kind: "loading" });
  try {
    await call($, "/v1/answers", {
      player_id: await player($),
      challenge_id: c.id,
      answer: "",
      answer_ms: Date.now() - shownAt,
      skipped: true,
    });
    backToList($);
  } catch (err) {
    go($, { kind: "error", message: messageOf(err), retry: { to: "skip" } });
  }
}

// Back to the theme's list, fetched again so the DONE marks are current.
function backToList($: EngineInterface) {
  challenge = null;
  if (list) void openTheme($, list.theme);
  else void loadMenu($);
}

function backToMenu($: EngineInterface) {
  challenge = null;
  list = null;
  void loadMenu($);
}

function retry($: EngineInterface, r: Retry) {
  if (r.to === "menu") void loadMenu($);
  else if (r.to === "list") void openTheme($, r.theme);
  else if (r.to === "challenge") void openChallenge($, r.id);
  else if (r.to === "answer") go($, { kind: "challenge" });
  else void skip($);
}

// ---- the Mod ----
export const register: Register = (on, options) => {
  serverUrl = String(options.server_url || DEFAULT_SERVER).replace(/\/+$/, "");
  invite = String(options.invite ?? "").trim();

  // Declare /braintone. `immediate` lets it open while Claude is mid-turn, like /btw.
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "braintone",
      description: "BrainTone: a brain workout while Claude works (Esc closes)",
      immediate: true,
    });
    return next(e);
  });

  on("command.run", { command: "braintone" }, async ($) => {
    // The menu and a theme's list are fetched fresh each time, so the DONE marks are current.
    // Anything mid-challenge is kept as it was. The first time in a session, the place saved by
    // the last session is picked up instead.
    if (!resumed) {
      resumed = true;
      screen = { kind: "loading" };
      void resume($);
    } else if (screen.kind === "menu") {
      screen = { kind: "idle" };
    } else if (screen.kind === "list" && list) {
      void openTheme($, list.theme);
    }
    await $.ui.open({ id: PANE, title: "BrainTone", focus: true, closeOnEscape: true, holdToasts: true, rows: 14 });
    redraw($);
    return { text: "" };
  });

  // Draw the pane's body.
  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text, Button, Input } = $.ui.resolve(e) as any;

    if (screen.kind === "idle") void loadMenu($);

    switch (screen.kind) {
      case "idle":
      case "loading":
        return <Text dimColor>…</Text>;

      case "menu": {
        const { menu } = screen;
        return (
          <Box flexDirection="column">
            <Text wrap="wrap">{menu.welcome}</Text>
            {menu.tally ? <Text dimColor>{menuTally(menu.tally)}</Text> : null}
            <Box flexDirection="column" marginTop={1}>
              {menu.themes.map((t, i) => (
                <Button key={`theme-${i}`} label={t.total > 0 ? `${t.label}  (${t.done}/${t.total} done)` : t.label} hotkey={String(i + 1)} plain autoFocus={i === 0 ? true : undefined} onPress={() => void openTheme($, t.theme, { shuffle: true })} />
              ))}
            </Box>
            <Box marginTop={1}>
              <Text dimColor>Esc closes</Text>
            </Box>
          </Box>
        );
      }

      case "list": {
        const { label, items } = list!;
        const pages = Math.ceil(items.length / PAGE);
        if (page >= pages) page = 0; // the list got shorter since
        const from = page * PAGE;
        const after = items.length - from - PAGE; // on the pages after this one
        return (
          <Box flexDirection="column">
            <Text bold>{label}</Text>
            <Box flexDirection="column" marginTop={1}>
              {items.slice(from, from + PAGE).map((item, i) => (
                <Button key={`ch-${i}`} label={item.done ? `${item.title}  - DONE` : item.title} hotkey={i < 9 ? String(i + 1) : undefined} plain autoFocus={i === 0 ? true : undefined} onPress={() => void openChallenge($, item.id)} />
              ))}
            </Box>
            <Box marginTop={1} flexDirection="column">
              {pages > 1 ? (
                <Button
                  key="more"
                  label={after > 0 ? `see more  (${after} more)` : `back to the first ${PAGE}`}
                  hotkey="m"
                  plain
                  onPress={() => {
                    page = (page + 1) % pages;
                    redraw($);
                    focusMain($);
                  }}
                />
              ) : null}
              <Button key="menu" label="back to the menu" hotkey="b" plain dimColor onPress={() => backToMenu($)} />
              <Text dimColor>Esc closes</Text>
            </Box>
          </Box>
        );
      }

      case "challenge": {
        const c = challenge!;
        const title = <Text bold>{`${c.label}${position()}${c.done ? " - DONE" : ""}`}</Text>;
        const prompt = (
          <Box marginTop={1}>
            <Text wrap="wrap">{c.prompt}</Text>
          </Box>
        );

        if (c.format === "choice") {
          return (
            <Box flexDirection="column">
              {title}
              {prompt}
              <Box flexDirection="column" marginTop={1}>
                {c.options.map((opt, i) => (
                  <Button key={`opt-${i}`} label={opt} hotkey={String(i + 1)} plain autoFocus={i === 0 ? true : undefined} onPress={() => void send($, String(i + 1))} />
                ))}
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Button key="skip" label="skip" hotkey="s" plain dimColor onPress={() => void skip($)} />
                <Text dimColor>Esc closes</Text>
              </Box>
            </Box>
          );
        }

        // In the text formats the field has the keyboard, so `s` would be typed rather than
        // skip; skip is a button one Tab away instead.
        const skipButton = <Button key="skip" label="skip" plain dimColor onPress={() => void skip($)} />;

        if (c.format === "line") {
          return (
            <Box flexDirection="column">
              {title}
              {prompt}
              <Box marginTop={1}>
                <Input
                  key="answer"
                  label="answer ›"
                  value={draft}
                  submitLabel="send"
                  autoFocus
                  onInput={(value: string) => {
                    draft = value;
                    save($);
                  }}
                  onSubmit={(value: string) => {
                    const text = value.trim();
                    if (text === "") return;
                    draft = text;
                    void send($, text);
                  }}
                />
              </Box>
              <Box marginTop={1} flexDirection="column">
                {skipButton}
                <Text dimColor>Enter sends · Tab: skip · Esc closes</Text>
              </Box>
            </Box>
          );
        }

        // Paragraph: Enter adds a line, and DONE on a line of its own sends. Every line already
        // written stays an editable field, so Tab (or Shift+Tab) goes back to fix one. At the
        // last line a send button takes the field's place rather than sending on its own, so
        // earlier lines can still be fixed first.
        const max = c.maxLines;
        const full = lines.length >= max;
        const sendParagraph = () => void send($, lines.map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\s+$/, ""));
        const lineLabel = (i: number) => `${String(i + 1).padStart(4)} │`;
        return (
          <Box flexDirection="column">
            {title}
            {prompt}
            <Box flexDirection="column" marginTop={1}>
              {lines.map((l, i) => (
                <Input
                  key={`edit-${i + 1}`}
                  label={lineLabel(i)}
                  value={l}
                  submitLabel="keep"
                  onInput={(value: string) => {
                    lines[i] = value;
                    save($);
                  }}
                  onSubmit={(value: string) => {
                    lines = lines.map((old, j) => (j === i ? value : old));
                    redraw($);
                    save($);
                    focusMain($);
                  }}
                />
              ))}
              {full ? (
                <Button key="send" label="send answer" hotkey="1" plain autoFocus onPress={sendParagraph} />
              ) : (
                <Input
                  key={`line-${lines.length + 1}`}
                  label={lineLabel(lines.length)}
                  value=""
                  submitLabel="add line"
                  autoFocus
                  onSubmit={(value: string) => {
                    const text = value.replace(/\s+$/, "");
                    if (text.trim().toUpperCase() === "DONE") {
                      if (lines.some((l) => l.trim() !== "")) sendParagraph();
                      return;
                    }
                    lines = [...lines, text];
                    redraw($);
                    save($);
                    focusMain($);
                  }}
                />
              )}
            </Box>
            <Box marginTop={1} flexDirection="column">
              {skipButton}
              <Text dimColor>
                {full
                  ? `${max}/${max} lines · Tab: edit a line or skip · Esc closes`
                  : `${lines.length + 1}/${max} lines · type DONE to send · Tab: edit a line or skip · Esc closes`}
              </Text>
            </Box>
          </Box>
        );
      }

      case "waiting":
        return <Text dimColor>{challenge?.format === "paragraph" ? "grading…" : "checking…"}</Text>;

      case "result": {
        const { result } = screen;
        const following = nextInList();
        // Done: moving on comes first. Not yet: another go comes first.
        type Choice = { key: string; label: string; press: () => void };
        const again: Choice = { key: "again", label: "try again", press: () => { startAnswering(); go($, { kind: "challenge" }); } };
        const toList: Choice = { key: "list", label: "back to the list", press: () => backToList($) };
        const onward: Choice | null = following ? { key: "next", label: "next challenge", press: () => openNext($, following) } : null;
        const choices = (completed(result) ? [onward, toList, again] : [again, onward, toList]).filter((c): c is Choice => c !== null);
        return (
          <Box flexDirection="column">
            <Text bold>{headline(result)}</Text>
            {result.feedback ? (
              <Box marginTop={1}>
                <Text wrap="wrap">{result.feedback}</Text>
              </Box>
            ) : null}
            {resultTally(result) ? (
              <Box marginTop={1} flexDirection="column">
                <Text>{resultTally(result)}</Text>
                {result.newBest ? <Text bold color="green">new best day!</Text> : null}
              </Box>
            ) : null}
            <Box marginTop={1} flexDirection="column">
              {choices.map((c, i) => (
                <Button key={c.key} label={c.label} hotkey={String(i + 1)} plain autoFocus={i === 0 ? true : undefined} onPress={c.press} />
              ))}
            </Box>
          </Box>
        );
      }

      case "error": {
        const { message, retry: retry_ } = screen;
        return (
          <Box flexDirection="column">
            <Text color="red" wrap="wrap">{message}</Text>
            <Box marginTop={1} flexDirection="column">
              <Button key="retry" label="try again" hotkey="1" plain autoFocus onPress={() => retry($, retry_)} />
              {list ? (
                <Button key="list" label="back to the list" hotkey="2" plain onPress={() => backToList($)} />
              ) : (
                <Button key="menu" label="back to the menu" hotkey="2" plain onPress={() => backToMenu($)} />
              )}
            </Box>
          </Box>
        );
      }
    }
  });
};
