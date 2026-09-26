import { test, expect, mock } from "claude-code/testing";

const PANE = {
  plugin: "braintone",
  surface: "terminal",
  component: "Pane",
  requestId: "braintone",
  props: {
    title: "BrainTone",
    isFocused: true,
    bodyColumns: 80,
    placement: "inline",
    scroll: { top: 0 },
    view: {},
  },
} as const;

const LABELS: Record<string, string> = {
  "quick-math": "they call me kalkulator",
  "newton-physics": "remember your friend Newton",
  poetry: "discover your inner Neruda",
  sat: "revive the good old SAT days",
};

// Each theme's challenges, in order. `right` is what the fake server accepts as correct.
const CHALLENGES: Record<string, any[]> = {
  "quick-math": [
    { challenge_id: "math-0001", format: "line", prompt: "What is 6 x 7?", options: null, max_lines: 1, right: "42" },
    {
      challenge_id: "math-0002", format: "choice", prompt: "What is the derivative of x^2 * sin(x)?",
      options: ["2x cos(x)", "2x sin(x) + x^2 cos(x)", "x^2 cos(x)"], max_lines: 1, right: "2",
    },
  ],
  "newton-physics": [
    { challenge_id: "newton-0001", format: "line", prompt: "Find the distance traveled during the 4th second.", options: null, max_lines: 1, right: "3.04 m" },
  ],
  poetry: [
    { challenge_id: "poetry-0001", format: "paragraph", prompt: "Write a short poem about the room you are sitting in.", options: null, max_lines: 3 },
  ],
  // More than one page, for "see more".
  sat: Array.from({ length: 7 }, (_, i) => ({
    challenge_id: `sat-000${i + 1}`, format: "line", prompt: `SAT question ${i + 1}`, options: null, max_lines: 1, right: "yes",
  })),
};

const find = (id: string) => {
  for (const [theme, list] of Object.entries(CHALLENGES)) {
    const c = list.find((x) => x.challenge_id === id);
    if (c) return { theme, c };
  }
  return undefined;
};

type Reply = { status: number; body: any };
const ok = (body: any): Reply => ({ status: 200, body });

// A fake /v1 server beneath the plugin. It records every request, remembers what was done,
// and lets a test override how answers are judged. Each challenge solved earns 3 points, once;
// `bestDay` is the best earlier day to beat, and `noTally` plays a server that sends no points.
function fakeServer(
  on: any,
  opts: { answer?: (body: any) => Reply; down?: boolean; bestDay?: number; noTally?: boolean; token?: string } = {},
) {
  const log: { method: string; path: string; body?: any; auth?: string }[] = [];
  const done = new Set<string>();
  let today = 0;
  const bestBefore = opts.bestDay ?? 0;
  const tally = () => (opts.noTally ? undefined : { total: today, today, best_day: Math.max(bestBefore, today), best_day_date: null });
  on("http.fetch", (_$: any, e: any) => {
    const url = new URL(e.url);
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined;
    const auth = e.init?.headers?.authorization;
    log.push({ method: e.init?.method ?? "GET", path: url.pathname + url.search, body, auth });
    const reply = ((): Reply => {
      if (opts.down) return { status: 503, body: {} };
      if (opts.token !== undefined && auth !== `Bearer ${opts.token}`) {
        return { status: 401, body: { error: { code: "unauthorized", message: "BrainTone needs an invite." } } };
      }
      if (url.pathname === "/v1/menu") {
        return ok({
          welcome: "which brainersize machine do you want to use today?",
          tally: tally(),
          themes: Object.entries(CHALLENGES).map(([theme, list]) => ({
            theme, label: LABELS[theme], total: list.length, done: list.filter((c) => done.has(c.challenge_id)).length,
          })),
        });
      }
      if (url.pathname === "/v1/challenges") {
        const theme = url.searchParams.get("theme")!;
        return ok({
          theme, theme_label: LABELS[theme],
          challenges: CHALLENGES[theme]!.map((c) => ({
            challenge_id: c.challenge_id, title: c.prompt, format: c.format, done: done.has(c.challenge_id),
          })),
        });
      }
      if (url.pathname === "/v1/challenges/open") {
        const { theme, c } = find(body.challenge_id)!;
        const { right: _right, ...pub } = c;
        return ok({ ...pub, theme, theme_label: LABELS[theme], done: done.has(c.challenge_id) });
      }
      if (url.pathname === "/v1/answers") {
        if (body.skipped) return ok({ kind: "outcome", outcome: "skipped", feedback: "Skipped." });
        const reply = opts.answer
          ? opts.answer(body)
          : ok(
              find(body.challenge_id)!.c.right === body.answer
                ? { kind: "outcome", outcome: "correct", feedback: "Nicely done." }
                : { kind: "outcome", outcome: "incorrect", feedback: "Have another go." },
            );
        if (reply.status === 200 && (reply.body.outcome === "correct" || reply.body.kind === "score")) {
          const earned = done.has(body.challenge_id) ? 0 : 3;
          const was = today;
          done.add(body.challenge_id);
          today += earned;
          if (opts.noTally) return reply;
          const best = bestBefore > 0 && was <= bestBefore && bestBefore < today ? { new_best_day: true } : {};
          return { ...reply, body: { ...reply.body, earned, tally: tally(), ...best } };
        }
        return opts.noTally || reply.status !== 200 ? reply : { ...reply, body: { ...reply.body, earned: 0, tally: tally() } };
      }
      return { status: 404, body: { error: { code: "not_found", message: "No such endpoint." } } };
    })();
    return { value: { status: reply.status, ok: reply.status < 400, headers: {}, text: JSON.stringify(reply.body) } };
  });
  return log;
}

const text = (ui: any, pattern: RegExp) => ui.find({ type: "Text", text: pattern });

// A theme's list comes in a random order, so tests pick a challenge by its title.
const LIST_KEYS = Array.from({ length: 10 }, (_, i) => `ch-${i}`);
async function listed(ui: any): Promise<string[]> {
  const out: string[] = [];
  for (const key of LIST_KEYS) {
    const item = await ui.find({ key });
    if (!item) break;
    out.push(String(item.props.label));
  }
  return out;
}
async function pick(ui: any, title: RegExp) {
  const at = (await listed(ui)).findIndex((label) => title.test(label));
  if (at < 0) throw new Error(`no challenge titled ${title} on the list`);
  await ui.press({ key: `ch-${at}` });
}

test("menu comes from the server, with done counts and a player id sent every time", async ($, on) => {
  mock.store(on);
  const log = fakeServer(on);
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);

  expect(await text(ui, /brainersize machine/)).toBeDefined();
  expect(await ui.find({ key: "theme-0" })).toBeDefined();
  expect(await ui.find({ key: "theme-2" })).toBeDefined();

  const menuCall = log.find((r) => r.path.startsWith("/v1/menu"))!;
  const id = new URL(`http://x${menuCall.path}`).searchParams.get("player_id")!;
  expect(id).toMatch(/^p_/);

  await ui.press({ key: "theme-0" });
  expect(log.at(-1)!.path).toBe(`/v1/challenges?player_id=${encodeURIComponent(id)}&theme=quick-math`);
  await pick(ui, /derivative/);
  expect(log.at(-1)!.body).toEqual({ player_id: id, challenge_id: "math-0002" });
  await ui.unmount();
});

test("a theme lists its challenges; a right answer marks it DONE, and it can be redone", async ($, on) => {
  mock.store(on);
  const log = fakeServer(on);
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);

  await ui.press({ key: "theme-0" });
  expect(await text(ui, /they call me kalkulator/)).toBeDefined();
  expect(await ui.find({ key: "ch-0" })).toBeDefined();
  expect(await ui.find({ key: "ch-1" })).toBeDefined();

  // wrong: trying again comes first
  await pick(ui, /derivative/);
  expect(await text(ui, /derivative of x\^2/)).toBeDefined();
  expect(await text(ui, /· [12]\/2/)).toBeDefined();
  await ui.press({ key: "opt-0" });
  expect(log.at(-1)!.body).toMatchObject({ challenge_id: "math-0002", answer: "1", skipped: false });
  expect(await text(ui, /Not quite\./)).toBeDefined();
  expect(await ui.find({ key: "again" })).toMatchObject({ props: { hotkey: "1" } });

  // right: the next challenge comes first, and trying again goes last
  await ui.press({ key: "again" });
  await ui.press({ key: "opt-1" });
  expect(await text(ui, /Correct\./)).toBeDefined();
  expect(await ui.find({ key: "next" })).toMatchObject({ props: { hotkey: "1" } });
  expect(await ui.find({ key: "list" })).toMatchObject({ props: { hotkey: "2" } });
  expect(await ui.find({ key: "again" })).toMatchObject({ props: { hotkey: "3" } });

  // back on the list, it says DONE, and opening it again works
  await ui.press({ key: "list" });
  const titles = await listed(ui);
  expect(titles.find((t) => /derivative/.test(t))).toMatch(/DONE/);
  expect(titles.find((t) => /6 x 7/.test(t))).not.toMatch(/DONE/);
  await pick(ui, /derivative/);
  expect(await text(ui, /DONE/)).toBeDefined();
  expect(await text(ui, /derivative of x\^2/)).toBeDefined();

  await ui.press({ key: "skip" });
  await ui.press({ key: "menu" });
  expect(await ui.find({ key: "theme-0", text: /1\/2 done/ })).toBeDefined();
  await ui.unmount();
});

test("line: Enter sends the one line; next challenge opens one not done yet", async ($, on) => {
  mock.store(on);
  const log = fakeServer(on);
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);

  await ui.press({ key: "theme-0" });
  await pick(ui, /6 x 7/);
  await ui.input({ key: "answer", text: "  42 ", kind: "submit" });
  const sent = log.at(-1)!.body;
  expect(sent).toMatchObject({ challenge_id: "math-0001", answer: "42", skipped: false });
  expect(typeof sent.answer_ms).toBe("number");
  expect(await text(ui, /Correct\./)).toBeDefined();

  await ui.press({ key: "next" });
  expect(log.at(-1)!.body).toMatchObject({ challenge_id: "math-0002" });
  expect(await text(ui, /derivative of x\^2/)).toBeDefined();
  await ui.unmount();
});

test("paragraph: Enter adds lines, DONE (any case) sends, the score is shown", async ($, on) => {
  mock.store(on);
  const log = fakeServer(on, {
    answer: () => ok({ kind: "score", score: 8, feedback: "Strong imagery; the ending rushes." }),
  });
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);

  await ui.press({ key: "theme-2" });
  await ui.press({ key: "ch-0" });
  await ui.input({ key: "line-1", text: "The lamp hums low,", kind: "submit" });
  await ui.input({ key: "line-2", text: "", kind: "submit" }); // a blank line between stanzas is kept
  expect(await ui.find({ key: "edit-1" })).toMatchObject({ props: { value: "The lamp hums low," } });
  expect(await text(ui, /3\/3 lines · type DONE to send/)).toBeDefined();
  await ui.input({ key: "line-3", text: "done", kind: "submit" });

  expect(log.at(-1)!.body).toMatchObject({ challenge_id: "poetry-0001", answer: "The lamp hums low," });
  expect(await text(ui, /8 \/ 10/)).toBeDefined();
  expect(await text(ui, /Strong imagery/)).toBeDefined();
  await ui.unmount();
});

test("paragraph: earlier lines can be edited before sending", async ($, on) => {
  mock.store(on);
  const log = fakeServer(on, { answer: () => ok({ kind: "score", score: 6, feedback: "" }) });
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);

  await ui.press({ key: "theme-2" });
  await ui.press({ key: "ch-0" });
  await ui.input({ key: "line-1", text: "The lamp hums lwo,", kind: "submit" });
  await ui.input({ key: "line-2", text: "the chair sits stil", kind: "submit" });
  expect(await ui.find({ key: "edit-1" })).toBeDefined();
  expect(await ui.find({ key: "edit-2" })).toBeDefined();

  // fixed with Enter, and fixed by typing then moving away without Enter
  await ui.input({ key: "edit-1", text: "The lamp hums low,", kind: "submit" });
  await ui.input({ key: "edit-2", text: "the chair sits still.", kind: "change" });
  await ui.input({ key: "line-3", text: "DONE", kind: "submit" });

  expect(log.at(-1)!.body).toMatchObject({ answer: "The lamp hums low,\nthe chair sits still." });
  await ui.unmount();
});

test("paragraph: at the last line a send button replaces the field, and lines stay editable", async ($, on) => {
  mock.store(on);
  const log = fakeServer(on, { answer: () => ok({ kind: "score", score: 6, feedback: "" }) });
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);

  await ui.press({ key: "theme-2" });
  await ui.press({ key: "ch-0" });
  await ui.input({ key: "line-1", text: "one", kind: "submit" });
  await ui.input({ key: "line-2", text: "two", kind: "submit" });
  await ui.input({ key: "line-3", text: "three", kind: "submit" });
  expect(log.filter((r) => r.path === "/v1/answers").length).toBe(0); // not sent on its own
  expect(await ui.find({ key: "line-4" })).toBeUndefined();

  await ui.input({ key: "edit-3", text: "three!", kind: "submit" });
  await ui.press({ key: "send" });
  expect(log.at(-1)!.body).toMatchObject({ answer: "one\ntwo\nthree!" });
  expect(await text(ui, /6 \/ 10/)).toBeDefined();
  await ui.unmount();
});

test("skip is reported and goes back to the theme's list", async ($, on) => {
  mock.store(on);
  const log = fakeServer(on);
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);

  await ui.press({ key: "theme-0" });
  await pick(ui, /derivative/);
  await ui.press({ key: "skip" });
  expect(log.find((r) => r.body?.skipped)).toMatchObject({ body: { challenge_id: "math-0002", answer: "", skipped: true } });
  expect(await ui.find({ key: "ch-0" })).toBeDefined();
  await ui.unmount();
});

test("a theme shows 5 challenges at random; see more turns to the next 5; the order holds", async ($, on) => {
  mock.store(on);
  fakeServer(on);
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);

  await ui.press({ key: "theme-3" });
  const first = await listed(ui);
  expect(first.length).toBe(5);
  expect(await ui.find({ key: "more", text: /2 more/ })).toBeDefined();

  // the next page holds the other 2, and "see more" there goes back to the start
  await ui.press({ key: "more" });
  const second = await listed(ui);
  expect(second.length).toBe(2);
  expect([...first, ...second].sort()).toEqual(CHALLENGES.sat!.map((c) => c.prompt).sort());
  expect(await ui.find({ key: "more", text: /back to the first 5/ })).toBeDefined();

  // into a challenge and back: same page, same order
  await ui.press({ key: "ch-1" });
  await ui.press({ key: "skip" });
  expect(await listed(ui)).toEqual(second);

  await ui.press({ key: "more" });
  expect(await listed(ui)).toEqual(first);

  // from the menu, a new deal each time, starting on the first page
  const deals = new Set<string>();
  for (let i = 0; i < 5; i++) {
    await ui.press({ key: "menu" });
    await ui.press({ key: "theme-3" });
    deals.add((await listed(ui)).join("|"));
  }
  expect(deals.size).toBeGreaterThan(1);
  await ui.unmount();
});

test("next challenge skips ones already done, and turns the list's page", async ($, on) => {
  mock.store(on);
  const log = fakeServer(on);
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);

  await ui.press({ key: "theme-3" });
  const order = await listed(ui);
  const opened: string[] = [];
  for (let i = 0; i < 7; i++) {
    if (i === 0) await ui.press({ key: "ch-0" });
    else await ui.press({ key: "next" });
    opened.push(log.at(-1)!.body.challenge_id);
    await ui.input({ key: "answer", text: "yes", kind: "submit" });
    expect(await text(ui, /Correct\./)).toBeDefined();
  }
  // every one exactly once, starting in the order shown
  expect(new Set(opened).size).toBe(7);
  expect(opened.slice(0, 5).map((id) => `SAT question ${Number(id.slice(-1))}`)).toEqual(order);

  // all done now, so next simply goes on to the following one
  expect(await ui.find({ key: "next" })).toBeDefined();
  await ui.press({ key: "list" });
  expect((await listed(ui)).length).toBe(2); // on the second page, where the last one opened is
  await ui.unmount();
});

test("points: the menu shows score, today and best day; a result shows what it added", async ($, on) => {
  mock.store(on);
  fakeServer(on, { bestDay: 4 });
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);

  expect(await text(ui, /^score 0 · today \+0 · best day 4$/)).toBeDefined();
  await ui.press({ key: "theme-0" });
  await pick(ui, /6 x 7/);
  await ui.input({ key: "answer", text: "41", kind: "submit" });
  expect(await text(ui, /^today 0 · score 0$/)).toBeDefined(); // nothing earned: no "+"
  await ui.press({ key: "again" });
  await ui.input({ key: "answer", text: "42", kind: "submit" });
  expect(await text(ui, /^\+3 · today 3 · score 3$/)).toBeDefined();
  expect(await text(ui, /new best day/)).toBeUndefined(); // 3 hasn't passed 4

  await ui.press({ key: "next" });
  await ui.press({ key: "opt-1" });
  expect(await text(ui, /^\+3 · today 6 · score 6$/)).toBeDefined();
  expect(await text(ui, /new best day!/)).toBeDefined();

  await ui.press({ key: "list" });
  await ui.press({ key: "menu" });
  expect(await text(ui, /^score 6 · today \+6 · best day 6$/)).toBeDefined();
  await ui.unmount();
});

test("points: a server that sends none still works, without the lines", async ($, on) => {
  mock.store(on);
  fakeServer(on, { noTally: true });
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);

  expect(await text(ui, /brainersize machine/)).toBeDefined();
  expect(await text(ui, /^score /)).toBeUndefined();
  await ui.press({ key: "theme-0" });
  await pick(ui, /6 x 7/);
  await ui.input({ key: "answer", text: "42", kind: "submit" });
  expect(await text(ui, /Correct\./)).toBeDefined();
  expect(await text(ui, /today/)).toBeUndefined();
  await ui.unmount();
});

test("a saved token goes with every request", async ($, on) => {
  const store = new Map<string, unknown>([["token", "tok_saved"]]);
  on("store.get", (_$: any, e: any) => ({ value: store.get(e.key) }));
  on("store.set", (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined }; });
  const log = fakeServer(on, { token: "tok_saved" });
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);
  expect(await text(ui, /brainersize machine/)).toBeDefined();
  expect(log.every((r) => r.auth === "Bearer tok_saved")).toBe(true);
  await ui.unmount();
});

test("a refused token: the server's message, and the token is dropped", async ($, on) => {
  const store = new Map<string, unknown>([["token", "tok_revoked"]]);
  on("store.get", (_$: any, e: any) => ({ value: store.get(e.key) }));
  on("store.set", (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined }; });
  fakeServer(on, { token: "tok_live" });
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);
  expect(await text(ui, /needs an invite/)).toBeDefined();
  expect(store.get("token")).toBe("");
  await ui.unmount();
});

test("no invite and no token: requests go without one, as to a local server", async ($, on) => {
  mock.store(on);
  const log = fakeServer(on);
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);
  expect(await text(ui, /brainersize machine/)).toBeDefined();
  expect(log.some((r) => r.path === "/v1/register")).toBe(false);
  expect(log.every((r) => r.auth === undefined)).toBe(true);
  await ui.unmount();
});

test("server down: an error with try again", async ($, on) => {
  mock.store(on);
  fakeServer(on, { down: true });
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);
  expect(await text(ui, /Couldn't reach BrainTone just now/)).toBeDefined();
  expect(await ui.find({ key: "retry" })).toBeDefined();
  await ui.unmount();
});

test("a failed send keeps the typed lines, and shows the server's message", async ($, on) => {
  mock.store(on);
  let fail = true;
  const log = fakeServer(on, {
    answer: () =>
      fail
        ? { status: 503, body: { error: { code: "grading_unavailable", message: "Couldn't grade that just now. Try again." } } }
        : ok({ kind: "score", score: 9, feedback: "" }),
  });
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);

  await ui.press({ key: "theme-2" });
  await ui.press({ key: "ch-0" });
  await ui.input({ key: "line-1", text: "The lamp hums low,", kind: "submit" });
  await ui.input({ key: "line-2", text: "DONE", kind: "submit" });
  expect(await text(ui, /Couldn't grade that just now/)).toBeDefined();

  await ui.press({ key: "retry" });
  expect(await ui.find({ key: "edit-1" })).toMatchObject({ props: { value: "The lamp hums low," } });
  fail = false;
  await ui.input({ key: "line-2", text: "DONE", kind: "submit" });
  expect(log.filter((r) => r.path === "/v1/answers").at(-1)!.body).toMatchObject({ answer: "The lamp hums low," });
  expect(await text(ui, /9 \/ 10/)).toBeDefined();
  await ui.unmount();
});

// Moving the keyboard ($.ui.focus) can't be seen here: the engine only honours it for a pane
// that is really on screen, which the test kit doesn't draw. `claude plugin validate` shows the call.

test("a new session goes back to where the player was, typed lines included", async ($, on) => {
  // The store, held here so a "later session" can find what an earlier one saved.
  const store = new Map<string, unknown>([
    ["playerId", "p_saved"],
    ["resume", { view: "challenge", theme: "poetry", challengeId: "poetry-0001", lines: ["The lamp hums low,", ""], draft: "" }],
  ]);
  on("store.get", (_$: any, e: any) => ({ value: store.get(e.key) }));
  on("store.set", (_$: any, e: any) => { store.set(e.key, e.value); return { value: undefined }; });
  on("ui.open", () => ({ value: undefined }));
  on("ui.focus", () => ({ value: {} }));
  const log = fakeServer(on);

  await $.command.run({ command: "braintone" } as any);
  const ui = await $.ui.mount<"terminal", "Pane">(PANE as any);
  expect(await text(ui, /room you are sitting in/)).toBeDefined();
  expect(await ui.find({ key: "edit-1" })).toMatchObject({ props: { value: "The lamp hums low," } });
  expect(await ui.find({ key: "line-3" })).toBeDefined();
  expect(log.find((r) => r.path === "/v1/challenges/open")!.body).toEqual({ player_id: "p_saved", challenge_id: "poetry-0001" });

  // typing is saved as it happens
  await ui.input({ key: "line-3", text: "the chair sits still.", kind: "submit" });
  expect(store.get("resume")).toMatchObject({ lines: ["The lamp hums low,", "", "the chair sits still."] });
  await ui.unmount();
});

test("/braintone is registered (mid-turn) and opens a focused pane Esc can close", async ($, on) => {
  const registered: any[] = [];
  const opened: any[] = [];
  on("command.register", (_$: any, e: any) => { registered.push(e); return { value: { command: e.name } }; });
  on("ui.open", (_$: any, e: any) => { opened.push(e); return { value: undefined }; });
  on("ui.invalidate", () => ({ value: undefined }));
  on("session.start", (_$: any, e: any) => ({ cwd: e.cwd }));
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true } as any);
  expect(registered[0]).toMatchObject({ name: "braintone", immediate: true });
  await $.command.run({ command: "braintone" } as any);
  expect(opened[0]).toMatchObject({ id: "braintone", focus: true, closeOnEscape: true });
});
