/**
 * Offline checks for the WeChat → workspace router against a stubbed host:
 * session creation, title pin, delivery, reply capture, steering, and the
 * queue that keeps a GUI-started turn untouched.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.CLAWBOT_STATE_DIR = mkdtempSync(join(tmpdir(), "clawbot-ws-live-"));

const { WorkspaceSessions, loadRoutes, routeLogFile, readRoutes, splitForWechat } = await import("../lib/workspace-sessions.js");

const WOHOME = "/Users/x/wohome";

/** A host just real enough: workspace list, sessionTitle, agent create/get. */
function stubHost() {
  const agents = new Map();
  const catalog = new Map();
  /** The workspace's session projection, as the host maintains it. */
  const sessionIds = [];
  const attached = [];
  const workspaces = [{ id: "w1", title: "wohome", path: WOHOME, sessionIds }];
  const created = [];
  const renamed = [];
  const turns = new Map();

  /** Pre-seed a session the host knows about but does not hold live. */
  function seed(id, cwd, title) {
    catalog.set(id, { cwd, title });
    if (title === "微信助理" && !sessionIds.includes(id)) sessionIds.unshift(id);
  }

  function makeAgent(sessionId, cwd) {
    const state = { seq: 0, events: [], waiters: [], running: false, inputs: [] };
    const session = {
      id: sessionId,
      header: { cwd },
      get seq() {
        return state.seq;
      },
      snapshotEvents: () => state.events,
    };
    const registeredTools = [];
    const agent = {
      session,
      ctx: { tools: { register: (definition) => registeredTools.push(definition) } },
      registeredTools,
      get status() {
        return state.running ? "running" : "idle";
      },
      followup(message) {
        state.inputs.push({ kind: "followup", message });
        state.running = true;
        state.seq += 1;
        state.events.push({ type: "user/message", seq: state.seq, data: {} });
      },
      steer(message) {
        state.inputs.push({ kind: "steer", message });
      },
      whenIdle() {
        return new Promise((resolve) => {
          if (!state.running) resolve();
          else state.waiters.push(resolve);
        });
      },
    };
    return { agent, state };
  }

  const ctx = {
    get(name) {
      if (name === "workspaceRegistry") {
        return {
          list: () => workspaces,
          resolveByPath: async (p) => {
            const owner = workspaces.find((entry) => entry.path === p);
            if (owner === undefined) return undefined;
            return {
              attachSession: async (id) => {
                attached.push(id);
                if (!owner.sessionIds.includes(id)) owner.sessionIds.unshift(id);
              },
            };
          },
        };
      }
      if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "p", model: "m" }) };
      if (name === "sessionQuery") {
        return {
          listSessions: async () => [...new Set([...catalog.keys(), ...agents.keys()])].map((id) => ({
            header: { id, cwd: catalog.get(id)?.cwd, createdAt: 0 },
            live: agents.has(id),
            persisted: true,
          })),
          readTitleSnapshots: async (ids) => ids.map((id) => (catalog.has(id) || agents.has(id)
            ? { status: "fulfilled", value: { title: { title: catalog.get(id)?.title } } }
            : { status: "rejected", reason: "unknown session" })),
        };
      }
      if (name === "sessionController") {
        return {
          async resolveAgent(id) {
            const key = String(id);
            if (agents.has(key)) return { agent: agents.get(key) };
            const entry = catalog.get(key);
            if (entry === undefined) return { error: "no such session" };
            const made = makeAgent(key, entry.cwd);
            agents.set(key, made.agent);
            turns.set(key, made);
            return { agent: made.agent };
          },
        };
      }
      if (name === "sessionTitle") {
        return {
          rename(session, title) {
            renamed.push({ sessionId: session.id, title });
            session.title = title;
          },
        };
      }
      return undefined;
    },
    agents: {
      get: (id) => agents.get(String(id)),
      list: () => [...agents.values()],
      async create({ sessionId, meta, agentOptions, setup }) {
        const record = { sessionId: String(sessionId), meta, agentOptions };
        created.push(record);
        const made = makeAgent(String(sessionId), meta.cwd);
        // The host hands setup the agent-scoped ctx: services plus the agent's
        // own tool registry.
        await setup?.({
          get: (name) => (name === "agentPresets" ? { mount: async () => {} } : undefined),
          tools: made.agent.ctx.tools,
        });
        agents.set(String(sessionId), made.agent);
        catalog.set(String(sessionId), { cwd: meta.cwd, title: undefined });
        turns.set(String(sessionId), made);
        return { agent: made.agent };
      },
    },
  };
  return { ctx, created, renamed, agents, turns, seed, attached, workspaces };
}

function makeInbox() {
  const sent = [];
  return { sent, sendText: async (to, text) => void sent.push({ to, text }) };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Finish the running turn with one assistant text and wait for the router to react. */
async function answer(turns, sessionId, text) {
  const { state } = turns.get(sessionId);
  state.running = false;
  state.seq += 1;
  state.events.push({ type: "assistant/message", seq: state.seq, data: { message: { content: [{ type: "text", text }] } } });
  for (const waiter of state.waiters.splice(0)) waiter();
  await settle();
}

test("a routed message creates a session, pins the title, and answers", async () => {
  const host = stubHost();
  const inbox = makeInbox();
  const instrumentation = [];
  const router = new WorkspaceSessions(host.ctx, inbox.sendText, (agentCtx) => {
    instrumentation.push(agentCtx);
    agentCtx.tools.register({ name: "ask_user_question" });
  });

  const handled = await router.tryHandle("owner", "@助理-wohome 你好");
  assert.equal(handled, true);

  assert.equal(host.created.length, 1);
  assert.equal(host.created[0].meta.cwd, "/Users/x/wohome");
  assert.deepEqual(host.created[0].agentOptions, { provider: "p", model: "m" });
  assert.equal(host.renamed[0].title, "微信助理");

  const sessionId = host.created[0].sessionId;
  // A workspace agent driven from WeChat has to ask through WeChat: the
  // global ask_user_question opens the web UI panel instead.
  assert.equal(instrumentation.length, 1);
  const agentCtx = instrumentation[0];
  const sessionAgent = host.agents.get(sessionId);
  assert.equal(agentCtx.tools, sessionAgent.ctx.tools);
  assert.deepEqual(sessionAgent.registeredTools.map((t) => t.name), ["ask_user_question"]);
  // The GUI groups sessions per workspace by membership: an unattached session
  // is invisible in the workspace it was made for.
  assert.deepEqual(host.attached, [sessionId]);
  assert.deepEqual(host.workspaces[0].sessionIds, [sessionId]);
  const record = loadRoutes().workspaces.w1;
  assert.equal(record.sessionId, sessionId);
  assert.equal(record.path, "/Users/x/wohome");

  const agent = host.agents.get(sessionId);
  assert.equal(agent.status, "running");
  assert.equal(agent.session.snapshotEvents().filter((e) => e.type === "user/message").length, 1);
  assert.deepEqual(inbox.sent.map((m) => m.text), ["已交给 助理-wohome。"]);

  await answer(host.turns, sessionId, "工作区里的回答");
  assert.deepEqual(inbox.sent.map((m) => m.text), ["已交给 助理-wohome。", "工作区里的回答"]);
});

test("a second message steers into the running turn and answers once", async () => {
  const host = stubHost();
  const inbox = makeInbox();
  const router = new WorkspaceSessions(host.ctx, inbox.sendText);
  await router.tryHandle("owner", "@助理-wohome 第一句");
  const sessionId = host.created[0].sessionId;

  await router.tryHandle("owner", "@助理-wohome 第二句");
  const { state } = host.turns.get(sessionId);
  assert.deepEqual(state.inputs.map((i) => i.kind), ["followup", "steer"]);
  assert.equal(state.events.filter((e) => e.type === "user/message").length, 1, "steering must not open a second turn");

  await answer(host.turns, sessionId, "两句一起答");
  assert.deepEqual(inbox.sent.map((m) => m.text), ["已交给 助理-wohome。", "已交给 助理-wohome。", "两句一起答"]);
});

test("a GUI-started turn is queued, never steered, and drained after it ends", async () => {
  const host = stubHost();
  const inbox = makeInbox();
  const router = new WorkspaceSessions(host.ctx, inbox.sendText);
  await router.tryHandle("owner", "@助理-wohome 建会话");
  const sessionId = host.created[0].sessionId;
  await answer(host.turns, sessionId, "建好了");

  // The owner types in the web UI: a turn this router does not drive.
  host.agents.get(sessionId).followup({ fake: true });
  await router.tryHandle("owner", "@助理-wohome 网页那一轮之后再说");
  const { state } = host.turns.get(sessionId);
  assert.deepEqual(state.inputs.map((i) => i.kind), ["followup", "followup"], "must not steer the GUI turn");
  assert.match(inbox.sent.at(-1).text, /正忙（那一轮不是微信发起的）/);

  await answer(host.turns, sessionId, "网页回答说完了");
  assert.match(inbox.sent.at(-1).text, /轮到 助理-wohome 了/);
  const delivered = state.events.filter((e) => e.type === "user/message").length;
  assert.equal(delivered, 3, "the queued text was delivered as its own turn");
  await answer(host.turns, sessionId, "排队那句的回答");
  assert.equal(inbox.sent.at(-1).text, "排队那句的回答");
});

test("an existing 微信助理 session in the workspace is adopted, not duplicated", async () => {
  const host = stubHost();
  host.seed("session-existing", "/Users/x/wohome", "微信助理");
  const inbox = makeInbox();
  const router = new WorkspaceSessions(host.ctx, inbox.sendText);

  await router.tryHandle("owner", "@助理-wohome 接着聊");
  assert.equal(host.created.length, 0, "an existing default assistant must not be shadowed");
  assert.equal(loadRoutes().workspaces.w1.sessionId, "session-existing");

  await answer(host.turns, "session-existing", "接管后的回答");
  assert.deepEqual(inbox.sent.map((m) => m.text), ["已交给 助理-wohome。", "接管后的回答"]);
});

test("the list command and an unknown workspace both answer without a session", async () => {
  const host = stubHost();
  const inbox = makeInbox();
  const router = new WorkspaceSessions(host.ctx, inbox.sendText);

  assert.equal(await router.tryHandle("owner", "工作区"), true);
  assert.equal(inbox.sent[0].text, [
    "工作区 1 个，直接 @ 就行：",
    "",
    "@助理-wohome",
    "",
    "用法：@助理-wohome 帮我看看构建失败",
    "查路由记录：/路由",
  ].join("\n"));

  assert.equal(await router.tryHandle("owner", "@助理-nope 在吗"), true);
  assert.match(inbox.sent[1].text, /没找到「nope」/);
  assert.equal(host.created.length, 0);

  assert.equal(await router.tryHandle("owner", "随便聊聊"), false);
});

test("a routed message is recorded and can be listed with /路由", async () => {
  writeFileSync(routeLogFile(), "");
  const host = stubHost();
  const inbox = makeInbox();
  const notes = [];
  const router = new WorkspaceSessions(host.ctx, inbox.sendText, undefined, (text) => notes.push(text));

  await router.tryHandle("owner", "@助理-wohome 看看构建为什么挂了");
  const sessionId = host.created[0].sessionId;
  await answer(host.turns, sessionId, "编译报错在 Foo.java");

  const routes = readRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0].label, "助理-wohome");
  assert.equal(routes[0].sessionId, sessionId);
  assert.equal(routes[0].delivered, "followup");
  assert.equal(routes[0].text, "看看构建为什么挂了");

  // The bot's own conversation gets one line about it, and is never woken for it.
  assert.equal(notes.length, 1);
  assert.match(notes[0], /路由记录/);
  assert.match(notes[0], /已转给 助理-wohome/);
  assert.match(notes[0], /看看构建为什么挂了/);

  await router.tryHandle("owner", "/路由");
  const listed = inbox.sent.at(-1).text;
  assert.match(listed, /最近 1 条路由/);
  assert.match(listed, /助理-wohome/);
  assert.match(listed, /看看构建为什么挂了/);
});

test("/路由 without any record says so", async () => {
  writeFileSync(routeLogFile(), "");
  const host = stubHost();
  const inbox = makeInbox();
  const router = new WorkspaceSessions(host.ctx, inbox.sendText);
  assert.equal(await router.tryHandle("owner", "路由"), true);
  assert.match(inbox.sent[0].text, /还没有路由记录/);
});

test("a long answer is split, never cut: every character reaches WeChat", async () => {
  const host = stubHost();
  const inbox = makeInbox();
  const router = new WorkspaceSessions(host.ctx, inbox.sendText);

  await router.tryHandle("owner", "@助理-wohome 说详细点");
  const sessionId = host.created[0].sessionId;
  const long = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段：`.padEnd(40, "字")).join("\n\n");
  await answer(host.turns, sessionId, long);

  const tail = inbox.sent.slice(1).map((m) => m.text);
  assert.ok(tail.length > 1, `expected a split, got ${tail.length} message(s)`);
  assert.equal(tail.join("").replace(/\s+/g, ""), long.replace(/\s+/g, ""));
  assert.ok(tail.every((text) => text.length <= 1500));
  assert.ok(!tail.some((text) => /太长/.test(text)));
});

test("splitForWechat keeps short text whole and prefers paragraph breaks", () => {
  assert.deepEqual(splitForWechat("短回答"), ["短回答"]);
  const para = `${"a".repeat(1000)}\n\n${"b".repeat(1000)}`;
  const chunks = splitForWechat(para);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "a".repeat(1000));
  assert.equal(chunks[1], "b".repeat(1000));
});
