/** Offline checks for `@助理-<workspace>` parsing and the address map. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.CLAWBOT_STATE_DIR = mkdtempSync(join(tmpdir(), "clawbot-ws-"));

const {
  loadRoutes,
  matchWorkspace,
  parseRoute,
  routeNames,
  routesFile,
  saveRoutes,
} = await import("../lib/workspace-sessions.js");

const workspaces = [
  { id: "w1", title: "wohome", path: "/Users/x/wohome" },
  { id: "w2", title: "wohome-old", path: "/Users/x/wohome-old" },
  { id: "w3", title: "助理", path: "/Users/x/助理" },
];

test("names are titles plus directory names, longest first", () => {
  assert.deepEqual(routeNames(workspaces), ["wohome-old", "wohome", "助理"]);
  assert.deepEqual(routeNames([{ id: "w", title: "名字", path: "/a/b/c" }]), ["名字", "c"]);
});

test("the prefix parses with and without a space", () => {
  const names = routeNames(workspaces);
  assert.deepEqual(parseRoute("@助理-wohome 跑一下测试", names), { name: "wohome", text: "跑一下测试" });
  assert.deepEqual(parseRoute("@助理-wohome跑测试", names), { name: "wohome", text: "跑测试" });
  assert.deepEqual(parseRoute("@助理-wohome", names), { name: "wohome", text: "" });
  assert.deepEqual(parseRoute("  @助理-wohome  hi", names), { name: "wohome", text: "hi" });
});

test("the longest known name wins and case is ignored", () => {
  const names = routeNames(workspaces);
  assert.deepEqual(parseRoute("@助理-wohome-old 好", names), { name: "wohome-old", text: "好" });
  assert.deepEqual(parseRoute("@助理-WOHOME hi", names), { name: "wohome", text: "hi" });
});

test("only a leading prefix routes; an unknown name keeps its token", () => {
  const names = routeNames(workspaces);
  assert.equal(parseRoute("你好", names), undefined);
  assert.equal(parseRoute("你好 @助理-wohome", names), undefined);
  assert.deepEqual(parseRoute("@助理-nope 在吗", names), { name: "nope", text: "在吗" });
});

test("a workspace resolves by title or by directory name", () => {
  assert.equal(matchWorkspace(workspaces, "wohome")?.id, "w1");
  assert.equal(matchWorkspace(workspaces, "WOHOME")?.id, "w1");
  assert.equal(matchWorkspace(workspaces, "wohome-old")?.id, "w2");
  assert.equal(matchWorkspace([{ id: "w", title: "别的名字", path: "/a/b/c" }], "c")?.id, "w");
  assert.equal(matchWorkspace(workspaces, "nope"), undefined);
  assert.equal(matchWorkspace(workspaces, "  "), undefined);
});

test("the address map survives a round trip and a broken file", () => {
  const empty = loadRoutes();
  assert.deepEqual(empty.workspaces, {});
  const record = { sessionId: "session-x", title: "wohome", path: "/Users/x/wohome", updatedAt: 1 };
  saveRoutes({ version: 1, workspaces: { w1: record } });
  assert.deepEqual(loadRoutes().workspaces.w1, record);
  writeFileSync(routesFile(), "{ not json");
  assert.deepEqual(loadRoutes().workspaces, {});
});
