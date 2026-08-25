import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { JsonSessionStore, type SessionPointer } from "./session-store.ts";

async function withStore(
  run: (store: JsonSessionStore, filePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-store-"));
  const filePath = join(directory, "pointers.json");
  try {
    await run(new JsonSessionStore({ filePath }), filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const pointer = (workspace: string, overrides: Partial<SessionPointer> = {}): SessionPointer => ({
  workspace,
  sessionFile: `/home/pi/.pi/agent/sessions/${workspace}`,
  sessionId: `session-${workspace}`,
  lastEntryId: "entry-9",
  leafId: "entry-8",
  ...overrides,
});

test("save then load round-trips a workspace pointer", async () => {
  await withStore(async (store, filePath) => {
    await store.save(pointer("Ubuntu:/home/pi"));
    const loaded = await store.load("Ubuntu:/home/pi");
    assert.deepEqual(loaded, {
      workspace: "Ubuntu:/home/pi",
      sessionFile: "/home/pi/.pi/agent/sessions/Ubuntu:/home/pi",
      sessionId: "session-Ubuntu:/home/pi",
      lastEntryId: "entry-9",
      leafId: "entry-8",
    });

    const content = await readFile(filePath, "utf8");
    assert.match(content, /"Ubuntu:\/home\/pi"/);
    assert.equal(content.endsWith("\n"), true);
  });
});

test("save is atomic: no temporary file survives the rename", async () => {
  await withStore(async (store, filePath) => {
    await store.save(pointer("ws-a"));
    assert.equal(existsSync(filePath), true);
    const leftovers = (await readdir(dirname(filePath))).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});

test("load tolerates a missing pointer file", async () => {
  await withStore(async (store) => {
    assert.equal(await store.load("Ubuntu:/home/pi"), null);
  });
});

test("load tolerates corrupt JSON", async () => {
  await withStore(async (store, filePath) => {
    await writeFile(filePath, "{ not json", "utf8");
    assert.equal(await store.load("Ubuntu:/home/pi"), null);
  });
});

test("load rejects invalid pointer records", async () => {
  await withStore(async (store, filePath) => {
    await writeFile(filePath, JSON.stringify({ "ws-a": { sessionFile: 42, sessionId: 42, lastEntryId: [] } }), "utf8");
    assert.equal(await store.load("ws-a"), null);
  });
});

test("load treats a pointer with neither sessionFile nor sessionId as absent", async () => {
  await withStore(async (store, filePath) => {
    await writeFile(filePath, JSON.stringify({ "ws-a": { lastEntryId: "entry-1" } }), "utf8");
    assert.equal(await store.load("ws-a"), null);
  });
});

test("workspaces do not clobber each other", async () => {
  await withStore(async (store) => {
    await store.save(pointer("ws-a"));
    await store.save(pointer("ws-b", { sessionId: "session-b" }));
    assert.equal((await store.load("ws-a"))?.lastEntryId, "entry-9");
    assert.equal((await store.load("ws-b"))?.sessionId, "session-b");
  });
});

test("a corrupt index is replaced by a fresh one on save", async () => {
  await withStore(async (store, filePath) => {
    await writeFile(filePath, "]", "utf8");
    await store.save(pointer("ws-c"));
    assert.equal((await store.load("ws-c"))?.sessionFile, "/home/pi/.pi/agent/sessions/ws-c");
  });
});

test("save validates the workspace key and normalizes identity fields", async () => {
  await withStore(async (store) => {
    await assert.rejects(store.save(pointer("  ")), TypeError);
    await assert.rejects(store.load(""), TypeError);
    await store.save({ ...pointer("ws-a"), sessionFile: 7 } as unknown as SessionPointer);
    assert.equal((await store.load("ws-a"))?.sessionFile, null);
  });
});

test("concurrent saves serialize so no workspace write is lost", async () => {
  await withStore(async (store) => {
    await Promise.all([
      store.save(pointer("ws-a", { sessionId: "session-a", lastEntryId: "entry-1" })),
      store.save(pointer("ws-b", { sessionId: "session-b", lastEntryId: "entry-2" })),
      store.save(pointer("ws-c", { sessionId: "session-c", lastEntryId: "entry-3" })),
    ]);
    assert.equal((await store.load("ws-a"))?.lastEntryId, "entry-1");
    assert.equal((await store.load("ws-b"))?.lastEntryId, "entry-2");
    assert.equal((await store.load("ws-c"))?.lastEntryId, "entry-3");
  });
});

test("concurrent saves with overlapping reads still keep every workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-store-"));
  const filePath = join(directory, "pointers.json");
  // Seed the index so the race is about merging, not first creation.
  await writeFile(
    filePath,
    JSON.stringify({ "ws-existing": pointer("ws-existing") }),
    "utf8",
  );

  // Park the first rename until the second save has read the index, or until
  // the test releases it. With serialized saves only one save ever runs, so
  // the test releases the parked rename explicitly; without serialization the
  // second save's read (enqueued before the parked rename can resume) forces
  // both saves to merge the same pre-write index. No wall-clock timing is
  // involved: every step awaits a real signal (rename call, save completion).
  // Executor-form promises: `Promise.withResolvers` needs lib ES2024, but the
  // project targets ES2022.
  let markFirstRenameCalled!: () => void;
  let markSecondReadStarted!: () => void;
  let release!: () => void;
  const firstRenameCalled = new Promise<void>((resolve) => {
    markFirstRenameCalled = resolve;
  });
  const secondReadStarted = new Promise<void>((resolve) => {
    markSecondReadStarted = resolve;
  });
  const releaseFirstRename = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let renameCalls = 0;
  try {
    const store = new JsonSessionStore({
      filePath,
      readFile: async (path) => {
        reads += 1;
        if (reads >= 2) markSecondReadStarted();
        return readFile(path, "utf8");
      },
      rename: async (fromPath, toPath) => {
        renameCalls += 1;
        if (renameCalls === 1) {
          markFirstRenameCalled();
          await Promise.race([secondReadStarted, releaseFirstRename]);
        }
        await rename(fromPath, toPath);
      },
    });
    const saves = Promise.all([store.save(pointer("ws-b")), store.save(pointer("ws-c"))]);
    await firstRenameCalled;
    release();
    await saves;

    assert.equal((await store.load("ws-existing"))?.sessionId, "session-ws-existing");
    assert.equal((await store.load("ws-b"))?.sessionId, "session-ws-b");
    assert.equal((await store.load("ws-c"))?.sessionId, "session-ws-c");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prototype-like workspace keys are stored as plain data, never on a prototype", async () => {
  await withStore(async (store, filePath) => {
    await store.save(pointer("__proto__", { sessionId: "session-proto" }));
    await store.save(pointer("constructor", { sessionId: "session-ctor" }));
    await store.save(pointer("toString", { sessionId: "session-tostring" }));

    assert.equal((await store.load("__proto__"))?.sessionId, "session-proto");
    assert.equal((await store.load("constructor"))?.sessionId, "session-ctor");
    assert.equal((await store.load("toString"))?.sessionId, "session-tostring");

    // The persisted index keeps them as own keys; no prototype was polluted.
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ["__proto__", "constructor", "toString"]);
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
    assert.equal((Object.prototype as { sessionId?: unknown }).sessionId, undefined);
  });
});

test("a failed save removes its unique temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-store-"));
  const filePath = join(directory, "pointers.json");
  try {
    const store = new JsonSessionStore({
      filePath,
      writeFile: async (path) => {
        if (path !== filePath) throw new Error("disk full");
        await writeFile(path, "{}", "utf8");
      },
    });
    await assert.rejects(store.save(pointer("ws-a")), /disk full/);
    assert.equal(existsSync(filePath), false);
    const leftovers = (await readdir(directory)).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pointer data is written with restrictive permissions where supported", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file modes are not enforced on Windows");
    return;
  }
  await withStore(async (store, filePath) => {
    await store.save(pointer("ws-a"));
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  });
});

test("a stored append cursor and leaf round-trip both values; the leaf never displaces the cursor", async () => {
  await withStore(async (store, filePath) => {
    // Pi's get_entries distinguishes the current active leaf (`leafId`) from
    // the append cursor (the last entry id observed in append order). A
    // stored `{lastSeenEntryId, leafId}` record must restore both values as
    // independent fields: the leaf is never mistaken for the catch-up
    // cursor, which stays the durable append cursor.
    await writeFile(
      filePath,
      JSON.stringify({
        "ws-leaf": {
          sessionFile: "/home/pi/.pi/agent/sessions/ws-leaf",
          sessionId: "session-ws-leaf",
          lastSeenEntryId: "entry-2",
          leafId: "entry-1",
        },
      }),
      "utf8",
    );

    const loaded = await store.load("ws-leaf");
    assert.deepEqual(loaded, {
      workspace: "ws-leaf",
      sessionFile: "/home/pi/.pi/agent/sessions/ws-leaf",
      sessionId: "session-ws-leaf",
      lastEntryId: "entry-2",
      leafId: "entry-1",
    });
  });
});

test("legacy pointer records migrate lastEntryId into the durable append cursor", async () => {
  await withStore(async (store, filePath) => {
    // A file written by an older version persists the append cursor under
    // the legacy `lastEntryId` key with no `lastSeenEntryId` and no
    // `leafId`. Loading it must preserve that cursor as the durable append
    // cursor and degrade the absent leaf to null.
    await writeFile(
      filePath,
      JSON.stringify({
        "ws-legacy": {
          sessionFile: "/home/pi/.pi/agent/sessions/ws-legacy",
          sessionId: "session-ws-legacy",
          lastEntryId: "entry-9",
        },
      }),
      "utf8",
    );

    const loaded = await store.load("ws-legacy");
    assert.deepEqual(loaded, {
      workspace: "ws-legacy",
      sessionFile: "/home/pi/.pi/agent/sessions/ws-legacy",
      sessionId: "session-ws-legacy",
      lastEntryId: "entry-9",
      leafId: null,
    });
  });
});

test("canonical lastSeenEntryId wins over a legacy lastEntryId key", async () => {
  await withStore(async (store, filePath) => {
    await writeFile(
      filePath,
      JSON.stringify({
        "ws-canonical": {
          sessionFile: "/home/pi/.pi/agent/sessions/ws-canonical",
          sessionId: "session-ws-canonical",
          lastSeenEntryId: "entry-3",
          lastEntryId: "entry-2",
        },
      }),
      "utf8",
    );

    const loaded = await store.load("ws-canonical");
    assert.equal(loaded?.lastEntryId, "entry-3");
  });
});

test("save persists the append cursor and the active leaf as separate keys", async () => {
  await withStore(async (store, filePath) => {
    await store.save({
      workspace: "ws-save",
      sessionFile: "/home/pi/.pi/agent/sessions/ws-save",
      sessionId: "session-ws-save",
      lastEntryId: "entry-5",
      leafId: "entry-4",
    });

    // The file records the durable append cursor under the canonical
    // `lastSeenEntryId` key plus the transient `leafId`; the legacy
    // `lastEntryId` key is no longer written.
    const content = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    const record = content["ws-save"] as Record<string, unknown>;
    assert.equal(record.lastSeenEntryId, "entry-5");
    assert.equal(record.leafId, "entry-4");
    assert.equal(record.lastEntryId, undefined);

    // Loading returns the compact compat shape: the durable append cursor
    // under `lastEntryId` plus the active leaf restored as an independent
    // field.
    const loaded = await store.load("ws-save");
    assert.deepEqual(loaded, {
      workspace: "ws-save",
      sessionFile: "/home/pi/.pi/agent/sessions/ws-save",
      sessionId: "session-ws-save",
      lastEntryId: "entry-5",
      leafId: "entry-4",
    });
  });
});
