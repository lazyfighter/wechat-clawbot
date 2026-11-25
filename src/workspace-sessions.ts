/**
 * WeChat → workspace sessions: an inbound message that starts with
 * `@助理-<workspace>` is routed into a DSH session whose cwd is that workspace
 * instead of the shared WeChat conversation. Every workspace has ONE default
 * WeChat-assistant session, titled `微信助理`: adopted when the workspace
 * already has one, created on first use otherwise, and remembered in a small
 * state file so a DSH restart keeps the same address.
 *
 * Phase 1 is narrow on purpose: text in, the turn's last text out, no
 * per-workspace permissions UI, no progress streaming. A message that arrives
 * while a turn started in the WEB UI is running is queued, never steered:
 * steering that turn would rewrite an answer the owner is watching in the GUI.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";

import { eventText, sendToDshSession, type DshSendResult } from "./dsh-sessions.js";
import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { logger } from "./ilink/util/logger.js";

/** Everything this feature listens for starts with this. */
export const ROUTE_PREFIX = "@助理-";
/** A message that is exactly this answers with the workspace list. */
export const LIST_COMMAND = "工作区";
/** Ask what has been routed lately. */
export const ROUTE_COMMAND = "路由";
/** Title of the one default WeChat-assistant session a workspace holds. */
export const SESSION_TITLE = "微信助理";
/**
 * `source.kind` on every message injected here. A distinct value keeps this
 * apart from the bridge's own WeChat turns and from the MCP route, so a reader
 * can tell who started a turn.
 */
export const ROUTE_KIND = "plugin:wechat-clawbot:workspace";
/** How much of one answer WeChat gets; the full text stays in the session. */
const REPLY_CAP = 1_500;
/** Report a turn still running after this long instead of waiting forever. */
const TURN_TIMEOUT_MS = 15 * 60 * 1_000;

/** The part of the host's workspace registry this feature reads. */
type WorkspaceLike = {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  /** This workspace's header-validated sessions, most recent first. */
  readonly sessionIds?: readonly string[];
};

type WorkspaceRegistryLike = {
  list(): readonly WorkspaceLike[];
  /** The workspace that owns `path`, if any. */
  resolveByPath(path: string): Promise<{ attachSession(sessionId: SessionId): Promise<void> } | undefined>;
};

/** The part of the host's `sessionQuery` service used to read titles. */
type SessionQueryLike = {
  listSessions(): Promise<readonly { header: { id: unknown } }[]>;
  readTitleSnapshots(ids: readonly string[]): Promise<readonly {
    status: string;
    value?: { title?: { title?: string } };
  }[]>;
};

/** The part of the host's `sessionTitle` service used to pin a name. */
type SessionTitleLike = {
  rename(session: unknown, title: string): unknown;
};

/** The part of the host's `agentPresets` service used to mount tools. */
type AgentPresetsLike = {
  mount(ctx: unknown, id?: string): Promise<unknown>;
};

/** One workspace's address, persisted across restarts. */
export type SessionRecord = {
  sessionId: string;
  /** Workspace directory when the session was made. */
  path: string;
  updatedAt: number;
};

export type RouteState = {
  version: 1;
  /** Workspace id → its session. Keyed by id, not title: titles are cosmetic. */
  workspaces: Record<string, SessionRecord>;
};

/** A parsed `@助理-<name> <text>`. */
export type ParsedRoute = { name: string; text: string };

/** Read one service without importing the package that augments the Context. */
function service<T>(ctx: Context, name: string): T | undefined {
  const get = (ctx as unknown as { get?: (key: string) => unknown }).get;
  if (typeof get !== "function") return undefined;
  try {
    return get.call(ctx, name) as T | undefined;
  } catch {
    return undefined;
  }
}

/**
 * One JSON line per routed message, in the plugin state dir. Plugin logs go to
 * the app's stderr, which the desktop build does not persist, so the only way
 * to see where a WeChat round trip spends its time is to write it down.
 */
export function recordTiming(line: Record<string, unknown>): void {
  try {
    const file = path.join(resolveStateDir(), "route-timing.jsonl");
    const stats = fs.statSync(file, { throwIfNoEntry: false }) as { size?: number } | undefined;
    if ((stats?.size ?? 0) > 512 * 1024) fs.writeFileSync(file, "");
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  } catch {
    // Diagnostics must never break routing.
  }
}

/** Where the routing history lives: one line per WeChat message handed to a workspace. */
export function routeLogFile(): string {
  return path.join(resolveStateDir(), "routes.jsonl");
}

/** Append one routing record; bounded like the timing file. */
export function recordRoute(entry: Record<string, unknown>): void {
  try {
    const file = routeLogFile();
    const stats = fs.statSync(file, { throwIfNoEntry: false }) as { size?: number } | undefined;
    if ((stats?.size ?? 0) > 512 * 1024) fs.writeFileSync(file, "");
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // Diagnostics must never break routing.
  }
}

/** The recorded routes, oldest first; a broken line is skipped, not fatal. */
export function readRoutes(): Record<string, unknown>[] {
  try {
    return fs.readFileSync(routeLogFile(), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** What the bot's own conversation is told about one routed message. */
export function routeNote(label: string, text: string, sent: DshSendResult): string {
  const clipped = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  const outcome = !sent.ok
    ? `没送进 ${label}：${sent.message}`
    : sent.delivered === "steered"
      ? `续进了 ${label} 正在跑的那一轮`
      : `已转给 ${label}`;
  return `（路由记录，不用回应）微信收到「${clipped}」，${outcome}。`;
}

/** Where the workspace → session map lives (inside the plugin's state dir). */
export function routesFile(): string {
  return path.join(resolveStateDir(), "workspace-sessions.json");
}

export function loadRoutes(): RouteState {
  try {
    const raw = JSON.parse(fs.readFileSync(routesFile(), "utf-8")) as Partial<RouteState>;
    if (raw.version === 1 && typeof raw.workspaces === "object" && raw.workspaces !== null) {
      return { version: 1, workspaces: raw.workspaces };
    }
  } catch {
    // Missing or unreadable: start empty; the next route rewrites it.
  }
  return { version: 1, workspaces: {} };
}

export function saveRoutes(state: RouteState): void {
  const file = routesFile();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.warn(`workspace: 保存 ${file} 失败: ${String(err)}`);
  }
}

/** Names a message may use after the prefix: every title and directory name. */
export function routeNames(entries: readonly WorkspaceLike[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    const title = entry.title.trim();
    if (title !== "") names.add(title);
    const folder = path.basename(entry.path);
    if (folder !== "") names.add(folder);
  }
  // Longest first: "wohome-old" must win over "wohome".
  return [...names].sort((a, b) => b.length - a.length);
}

/**
 * Split `@助理-<name><space?><text>`. The name is matched against the known
 * names (longest first) so both `@助理-wohome 跑测试` and `@助理-wohome跑测试`
 * address the same workspace; an unknown name falls back to the first token so
 * the error can say what was not found.
 */
export function parseRoute(body: string, names: readonly string[]): ParsedRoute | undefined {
  const text = body.trimStart();
  if (!text.startsWith(ROUTE_PREFIX)) return undefined;
  const rest = text.slice(ROUTE_PREFIX.length);
  const lower = rest.toLowerCase();
  for (const name of names) {
    if (lower.startsWith(name.toLowerCase())) {
      return { name, text: rest.slice(name.length).trim() };
    }
  }
  const match = /^(\S*)\s*([\s\S]*)$/u.exec(rest);
  if (match === null) return { name: rest.trim(), text: "" };
  return { name: match[1] ?? "", text: (match[2] ?? "").trim() };
}

/** The workspace a name refers to: its title first, then its directory name. */
export function matchWorkspace(
  entries: readonly WorkspaceLike[],
  name: string,
): WorkspaceLike | undefined {
  const target = name.trim().toLowerCase();
  if (target === "") return undefined;
  return entries.find((entry) => entry.title.trim().toLowerCase() === target)
    ?? entries.find((entry) => path.basename(entry.path).toLowerCase() === target);
}

/** Where one routed message spent its time, in epoch ms. */
type RouteTiming = {
  inboundAt: number;
  matchedAt: number;
  sessionAt: number;
  ackAt: number;
  deliveredAt: number;
  woke: boolean;
  delivered: string;
};

export class WorkspaceSessions {
  /** Agents made here, held so their sessions stay live between turns. */
  private readonly handles = new Map<string, AgentHandle>();
  /** Sessions whose running turn this router drives (and watches). */
  private readonly busy = new Set<string>();
  /** Session ids whose agent already carries the WeChat question tool. */
  private readonly tools = new Set<string>();
  /** Messages held for a session because a GUI-started turn was running. */
  private readonly queue = new Map<string, Array<{ sender: string; label: string; text: string }>>();

  constructor(
    private readonly ctx: Context,
    private readonly sendText: (to: string, text: string) => Promise<void>,
    /**
     * Registers the WeChat `ask_user_question` override on one agent. Without
     * it a workspace agent asks through the web UI, where a WeChat user cannot
     * answer — the turn sits there until it times out.
     */
    private readonly registerTools?: (agentCtx: Context) => void,
    /** Records a routed message in the bot's own conversation (never wakes it). */
    private readonly notifyBot?: (text: string) => void,
  ) {}

  /**
   * Consume `body` when it addresses a workspace (or asks for the list).
   * @returns whether the message belonged here; false means "not ours".
   */
  async tryHandle(sender: string, body: string, extra = ""): Promise<boolean> {
    const trimmed = body.trim();
    if (trimmed === LIST_COMMAND || trimmed === `/${LIST_COMMAND}`) {
      await this.reply(sender, this.describe());
      return true;
    }
    if (trimmed === ROUTE_COMMAND || trimmed === `/${ROUTE_COMMAND}`) {
      await this.reply(sender, this.recentRoutes());
      return true;
    }
    const inboundAt = Date.now();
    const entries = this.workspaces();
    const parsed = parseRoute(body, routeNames(entries));
    if (parsed === undefined) return false;
    if (parsed.name === "") {
      await this.reply(sender, this.describe());
      return true;
    }
    const matchedAt = Date.now();
    const workspace = matchWorkspace(entries, parsed.name);
    if (workspace === undefined) {
      await this.reply(sender, `没找到「${parsed.name}」这个工作区。\n\n${this.describe()}`);
      return true;
    }
    let record: SessionRecord;
    try {
      record = await this.ensureSession(workspace);
    } catch (err) {
      logger.error(`workspace: 给 ${workspace.title} 建会话失败: ${String(err)}`);
      await this.reply(sender, `给「${workspace.title}」建会话失败：${String(err).slice(0, 200)}`);
      return true;
    }
    const label = `助理-${workspace.title}`;
    const text = [parsed.text, extra].filter((part) => part.trim() !== "").join("\n");
    if (text.trim() === "") {
      await this.reply(sender, `${label} 已就绪，直接说事。`);
      return true;
    }
    await this.deliver(sender, label, record.sessionId, text, {
      inboundAt,
      matchedAt,
      sessionAt: Date.now(),
      ackAt: 0,
      deliveredAt: 0,
      woke: false,
      delivered: "",
    });
    return true;
  }

  private workspaces(): readonly WorkspaceLike[] {
    const registry = service<WorkspaceRegistryLike>(this.ctx, "workspaceRegistry");
    if (registry === undefined) return [];
    try {
      return registry.list();
    } catch (err) {
      logger.warn(`workspace: 读工作区列表失败: ${String(err)}`);
      return [];
    }
  }

  /** The /路由 reply: the last few messages handed to a workspace. */
  private recentRoutes(): string {
    const routes = readRoutes();
    if (routes.length === 0) {
      return "还没有路由记录。发「@助理-工作区名 内容」就有了。";
    }
    const recent = routes.slice(-10).reverse();
    const lines = recent.map((entry) => {
      const at = String(entry.at ?? "");
      const time = at.length >= 16 ? at.slice(11, 16) : at;
      const state = entry.delivered === "failed"
        ? "没送进"
        : entry.delivered === "steered" ? "并入" : "已投递";
      return `${time} ${String(entry.label ?? "")} · ${state} · ${String(entry.chars ?? "")} 字\n  「${String(entry.text ?? "")}」`;
    });
    return `最近 ${recent.length} 条路由：\n\n${lines.join("\n")}`;
  }

  /**
   * The workspace list: one copyable `@助理-xxx` per line.
   *
   * WeChat has no tappable commands, so the only way to "use" this list is to
   * long-press one line and paste it. Anything else on that line (title,
   * markers) would be copied too.
   */
  private describe(): string {
    const entries = this.workspaces();
    if (entries.length === 0) return "这个 DSH 没有可用的工作区服务，或者工作区是空的。";
    const lines = [...entries]
      .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
      .map((entry) => `@助理-${entry.title}`);
    return `工作区 ${entries.length} 个，直接 @ 就行：\n\n${lines.join("\n")}\n\n用法：${lines[0] ?? "@助理-工作区名"} 帮我看看构建失败\n查路由记录：/路由`;
  }

  private async ensureSession(workspace: WorkspaceLike): Promise<SessionRecord> {
    const state = loadRoutes();
    const existing = state.workspaces[workspace.id];
    if (existing !== undefined && existing.path === workspace.path && await this.sessionExists(existing.sessionId)) {
      await this.attach(workspace, existing.sessionId);
      return existing;
    }
    if (existing !== undefined) {
      logger.warn(`workspace: ${workspace.title} 原来的会话 ${existing.sessionId} 不可用了，重新找一个`);
    }
    // One default assistant per workspace: a 微信助理 the owner already made
    // in this workspace is taken over instead of shadowed by a second one.
    const adopted = await this.defaultSession(workspace);
    const sessionId = adopted ?? `session-${randomUUID()}`;
    if (adopted === undefined) {
      await this.createSession(workspace, sessionId);
    } else {
      logger.info(`workspace: 接管 ${workspace.title} 已有的会话 ${adopted}`);
    }
    await this.attach(workspace, sessionId);
    const record: SessionRecord = { sessionId, path: workspace.path, updatedAt: Date.now() };
    saveRoutes({ version: 1, workspaces: { ...state.workspaces, [workspace.id]: record } });
    return record;
  }

  /**
   * The workspace's existing `微信助理` session, if it has one.
   *
   * Only the workspace's own session projection is read: listing every session
   * on the machine (312 of them here) to find one title cost ~5s before the
   * first WeChat message of a workspace could even be acknowledged.
   */
  private async defaultSession(workspace: WorkspaceLike): Promise<string | undefined> {
    const ids = (workspace.sessionIds ?? []).map(String);
    if (ids.length === 0) return undefined;
    const query = service<SessionQueryLike>(this.ctx, "sessionQuery");
    if (query === undefined) return undefined;
    try {
      const snapshots = await query.readTitleSnapshots(ids);
      for (let index = 0; index < ids.length; index += 1) {
        if (snapshots[index]?.status === "fulfilled"
          && snapshots[index]?.value?.title?.title === SESSION_TITLE) {
          return ids[index];
        }
      }
    } catch (err) {
      logger.warn(`workspace: 读 ${workspace.title} 的会话标题失败: ${String(err)}`);
    }
    return undefined;
  }

  /**
   * Make sure the workspace counts this session as a member.
   *
   * The GUI groups sessions per workspace by that membership, so a session
   * created here (`agents.create`, not the GUI's new-session command) stays
   * invisible in the workspace until it is attached.
   */
  private async attach(workspace: WorkspaceLike, sessionId: string): Promise<void> {
    if ((workspace.sessionIds ?? []).some((id) => String(id) === sessionId)) return;
    const registry = service<WorkspaceRegistryLike>(this.ctx, "workspaceRegistry");
    if (registry === undefined) return;
    try {
      const entity = await registry.resolveByPath(workspace.path);
      await entity?.attachSession(SessionId(sessionId));
      logger.info(`workspace: 会话 ${sessionId} 挂到 ${workspace.title} 名下`);
    } catch (err) {
      logger.warn(`workspace: 把会话挂到 ${workspace.title} 失败: ${String(err)}`);
    }
  }

  /**
   * Whether a mapped session still exists, live or only on disk. A live agent
   * is enough; otherwise ask `sessionQuery`. When the host cannot tell (no
   * such service), keep the address rather than silently orphaning a session.
   */
  private async sessionExists(sessionId: string): Promise<boolean> {
    if (this.ctx.agents.get(SessionId(sessionId)) !== undefined) return true;
    const query = service<SessionQueryLike>(this.ctx, "sessionQuery");
    if (query === undefined) return true;
    // One id, not the whole machine: probing the corpus for a single session is
    // cheap, listing every session is not (and this runs on the first message
    // after each DSH restart).
    try {
      const [probe] = await query.readTitleSnapshots([sessionId]);
      if (probe?.status === "fulfilled") return true;
    } catch {
      // fall through to the full list: a rejection cannot tell "gone" from an I/O error
    }
    try {
      const rows = await query.listSessions();
      return rows.some((row) => String(row.header.id) === sessionId);
    } catch (err) {
      logger.warn(`workspace: 读会话列表失败（保留原地址）: ${String(err)}`);
      return true;
    }
  }

  private async createSession(workspace: WorkspaceLike, sessionId: string): Promise<void> {
    const defaultModel = this.ctx.get("agentDefaultModel");
    const selection = defaultModel?.currentSelection();
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: workspace.path },
      agentOptions: selection === undefined
        ? undefined
        : { provider: selection.provider, model: selection.model },
      setup: async (agentCtx: Context) => {
        // Same tool layer the GUI session gets: without the preset mount the
        // agent has a model and no tools.
        const presets = service<AgentPresetsLike>(agentCtx, "agentPresets");
        if (presets === undefined) {
          logger.warn("workspace: 没有 agentPresets 服务，工作区会话将只有全局工具");
          return;
        }
        try {
          await presets.mount(agentCtx);
        } catch (err) {
          logger.warn(`workspace: 挂 preset 失败: ${String(err)}`);
        }
        // After the preset mount, like the WeChat agent: without this the
        // agent asks through the web UI and the turn waits for an answer
        // nobody can give from WeChat.
        this.ensureTools(agentCtx, sessionId);
      },
    });
    this.handles.set(sessionId, handle);
    // Nothing in WeChat can answer an approval prompt, and a session parked on
    // one would hold the queued messages behind it. Same choice the owner made
    // for the WeChat conversation itself.
    try {
      setApprovalPolicy(handle.agent.session, "never");
    } catch (err) {
      logger.warn(`workspace: 设置审批策略失败: ${String(err)}`);
    }
    const titles = service<SessionTitleLike>(this.ctx, "sessionTitle");
    if (titles !== undefined) {
      try {
        titles.rename(handle.agent.session, SESSION_TITLE);
      } catch (err) {
        logger.warn(`workspace: 设置标题失败: ${String(err)}`);
      }
    }
    logger.info(`workspace: 新建 ${sessionId} → ${SESSION_TITLE} (${workspace.path})`);
  }

  /** Give one agent the WeChat question tool, once per session. */
  private ensureTools(agentCtx: Context, sessionId: string): void {
    if (this.registerTools === undefined) return;
    if (this.tools.has(sessionId)) return;
    this.tools.add(sessionId);
    try {
      this.registerTools(agentCtx);
    } catch (err) {
      this.tools.delete(sessionId);
      logger.warn(`workspace: 给会话 ${sessionId} 装提问工具失败: ${String(err)}`);
    }
  }

  /**
   * The live agent for a session, waking it when dormant — the tools have to
   * be on the agent *before* the turn starts, not after it has already asked.
   */
  private async wake(sessionId: string): Promise<Agent | undefined> {
    const live = this.ctx.agents.get(SessionId(sessionId)) as Agent | undefined;
    if (live !== undefined) return live;
    const controller = service<{
      resolveAgent(id: unknown): Promise<{ agent?: Agent } | { error: unknown }>;
    }>(this.ctx, "sessionController");
    if (controller === undefined) return undefined;
    try {
      const resolved = await controller.resolveAgent(SessionId(sessionId));
      return "agent" in resolved ? resolved.agent : undefined;
    } catch (err) {
      logger.warn(`workspace: 唤醒 ${sessionId} 失败: ${String(err)}`);
      return undefined;
    }
  }

  private async deliver(
    sender: string,
    label: string,
    sessionId: string,
    text: string,
    timing: RouteTiming,
  ): Promise<void> {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    const ours = this.busy.has(sessionId);
    if (!ours && agent !== undefined && agent.status === "running") {
      // Started in the GUI: queue behind it, never steer into it.
      const list = this.queue.get(sessionId) ?? [];
      list.push({ sender, label, text });
      this.queue.set(sessionId, list);
      this.watchForeignTurn(sessionId);
      await this.reply(sender, `${label} 正忙（那一轮不是微信发起的），这条排上了，忙完就发。`);
      return;
    }
    if (!ours) this.busy.add(sessionId);
    await this.reply(sender, `已交给 ${label}。`);
    timing.ackAt = Date.now();
    // Wake first (a no-op when live) so the WeChat question tool is on the
    // agent before its turn builds the tool list.
    const live = await this.wake(sessionId);
    if (live !== undefined) this.ensureTools(live.ctx, sessionId);
    const sent = await sendToDshSession(this.ctx, sessionId, text, { kind: ROUTE_KIND, wake: true });
    timing.deliveredAt = Date.now();
    // Tell the bot's own conversation what happened (injected, never woken),
    // and keep a queryable record behind /路由.
    this.notifyBot?.(routeNote(label, text, sent));
    recordRoute({
      sender,
      label,
      sessionId,
      text: text.length > 200 ? `${text.slice(0, 200)}…` : text,
      chars: text.length,
      delivered: sent.ok ? sent.delivered : "failed",
    });
    if (!sent.ok) {
      if (!ours) this.busy.delete(sessionId);
      await this.reply(sender, `没送进 ${label}：${sent.message}`);
      return;
    }
    timing.woke = sent.woke;
    timing.delivered = sent.delivered;
    if (ours) return; // steered into the turn already being watched
    if (sent.delivered !== "followup") {
      // A turn nobody here started grabbed the message in the gap between the
      // status check and the send: never speak for that turn.
      this.busy.delete(sessionId);
      await this.reply(sender, `${label} 正有一轮在跑，这条并进去了，结果到网页里看。`);
      return;
    }
    void this.watch(sender, label, sessionId, sent.agent as unknown as Agent, sent.before, timing);
  }

  /** Wait for the turn to end, then send its last text to WeChat. */
  private async watch(
    sender: string,
    label: string,
    sessionId: string,
    agent: Agent,
    before: number,
    timing?: RouteTiming,
  ): Promise<void> {
    try {
      let timedOut = false;
      await Promise.race([
        agent.whenIdle(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, TURN_TIMEOUT_MS).unref?.();
        }),
      ]);
      if (timedOut) {
        await this.reply(sender, `${label} 跑了 15 分钟还没结束，先用网页看吧。`);
        return;
      }
      const answer = this.lastText(agent, before);
      const answeredAt = Date.now();
      await this.reply(sender, answer ?? `${label} 这一轮没有文字回复。`);
      if (timing !== undefined) {
        recordTiming({
          sessionId,
          woke: timing.woke,
          delivered: timing.delivered,
          chars: answer?.length ?? 0,
          matchMs: timing.matchedAt - timing.inboundAt,
          sessionMs: timing.sessionAt - timing.matchedAt,
          ackMs: timing.ackAt - timing.sessionAt,
          deliverMs: timing.deliveredAt - timing.ackAt,
          turnMs: answeredAt - timing.deliveredAt,
          replyMs: Date.now() - answeredAt,
          totalMs: Date.now() - timing.inboundAt,
        });
      }
    } catch (err) {
      logger.error(`workspace: 等待 ${sessionId} 的回复失败: ${String(err)}`);
    } finally {
      this.busy.delete(sessionId);
      void this.drain(sessionId);
    }
  }

  /** The last assistant text written after `before`, capped for WeChat. */
  private lastText(agent: Agent, before: number): string | undefined {
    let text: string | undefined;
    for (const event of agent.session.snapshotEvents()) {
      if (event.seq <= before) continue;
      if (event.type !== "assistant/message") continue;
      const body = eventText(event as { type: string; data?: unknown });
      if (body !== "") text = body;
    }
    if (text === undefined) return undefined;
    return text.length > REPLY_CAP
      ? `${text.slice(0, REPLY_CAP)}…\n（太长，完整回复在网页里）`
      : text;
  }

  /**
   * Drain a queue nobody here is watching: the running turn belongs to the
   * GUI, so the only signal its end offers is the agent going idle.
   */
  private watchForeignTurn(sessionId: string): void {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent === undefined) return;
    void agent.whenIdle().then(() => this.drain(sessionId)).catch((err: unknown) => {
      logger.warn(`workspace: 等待空闲失败: ${String(err)}`);
    });
  }

  /** Send the next queued message once the session is free again. */
  private async drain(sessionId: string): Promise<void> {
    if (this.busy.has(sessionId)) return;
    const list = this.queue.get(sessionId);
    if (list === undefined || list.length === 0) {
      this.queue.delete(sessionId);
      return;
    }
    const item = list.shift();
    if (item === undefined) return;
    if (list.length === 0) this.queue.delete(sessionId);
    this.busy.add(sessionId);
    await this.reply(item.sender, `轮到 ${item.label} 了。`);
    const live = await this.wake(sessionId);
    if (live !== undefined) this.ensureTools(live.ctx, sessionId);
    const sent = await sendToDshSession(this.ctx, sessionId, item.text, { kind: ROUTE_KIND, wake: true });
    if (!sent.ok) {
      this.busy.delete(sessionId);
      await this.reply(item.sender, `没送进 ${item.label}：${sent.message}`);
      return;
    }
    if (sent.delivered !== "followup") {
      this.busy.delete(sessionId);
      await this.reply(item.sender, `${item.label} 正有一轮在跑，这条并进去了，结果到网页里看。`);
      return;
    }
    void this.watch(item.sender, item.label, sessionId, sent.agent as unknown as Agent, sent.before);
  }

  private async reply(sender: string, text: string): Promise<void> {
    try {
      await this.sendText(sender, text);
    } catch (err) {
      logger.warn(`workspace: 回微信失败: ${String(err)}`);
    }
  }
}
