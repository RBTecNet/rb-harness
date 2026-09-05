import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RALPH_EVENT_SCHEMA,
  RalphEventStore,
  eventFileName,
  nodeRalphRuntimeFileSystem,
  commitRalphEvent,
  createInitialRuntimeState,
  readStateSnapshot,
  createRalphEvent,
  type EventPayloadMap,
  type RalphEvent,
  type RalphEventType,
  type UnsignedRalphEvent,
  canonicalJson,
  sha256,
} from "../../src/vnext/ralph-runtime/index.js";

function makeEvent<TType extends RalphEventType>(sequence: number, eventType: TType, payload: EventPayloadMap[TType], previousEventHash: string | null, runId = "run-1"): RalphEvent {
  return createRalphEvent({
    eventId: `event-${sequence}-${runId}`,
    eventType,
    schemaVersion: RALPH_EVENT_SCHEMA,
    runId,
    sequence,
    occurredAt: `2026-09-05T01:00:${String(sequence).padStart(2, "0")}.000Z`,
    recordedAt: `2026-09-05T01:00:${String(sequence).padStart(2, "0")}.100Z`,
    entity: { kind: "run", id: runId },
    actor: "CORE",
    causationId: null,
    correlationId: "c1",
    payload,
    previousEventHash,
  } as UnsignedRalphEvent<TType>) as RalphEvent;
}

async function storeFixture() {
  const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-event-store-"));
  return { root, store: new RalphEventStore({ projectRoot: root, runId: "run-1" }) };
}

describe("Ralph Runtime V1 one-event-per-file ledger", () => {
  it("writes canonical padded files, chains hashes, and treats identical duplicates as idempotent", async () => {
    const { root, store } = await storeFixture();
    try {
      const first = makeEvent(1, "run.created", { phaseIds: [], taskIds: [] }, null);
      expect((await store.append(first)).committed).toBe(true);
      const duplicate = await store.append(first);
      expect(duplicate.committed).toBe(false);
      const second = makeEvent(2, "run.started", {}, first.eventHash);
      await store.append(second);
      expect(await readdir(store.eventsDirectory)).toEqual(["000000000001.json", "000000000002.json"]);
      const bytes = await readFile(resolve(store.eventsDirectory, eventFileName(1)), "utf8");
      expect(bytes.endsWith("\n")).toBe(false);
      expect(JSON.parse(bytes)).toEqual(first);
      expect((await store.inspect()).lastEventHash).toBe(second.eventHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects different bytes for a duplicate sequence and gaps", async () => {
    const { root, store } = await storeFixture();
    try {
      const first = makeEvent(1, "run.created", { phaseIds: [], taskIds: [] }, null);
      await store.append(first);
      const different = makeEvent(1, "run.created", { phaseIds: ["different"], taskIds: [] }, null);
      await expect(store.append(different)).rejects.toThrow("RALPH_EVENT_SEQUENCE_FORK");
      const gap = makeEvent(3, "run.started", {}, first.eventHash);
      await expect(store.append(gap)).rejects.toThrow("RALPH_EVENT_SEQUENCE_NOT_NEXT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores but quarantines temporary files", async () => {
    const { root, store } = await storeFixture();
    try {
      await store.ensureLayout();
      await writeFile(resolve(store.eventsDirectory, ".000000000001.json.tmp-crash"), "partial");
      expect((await store.inspect()).events).toHaveLength(0);
      const moved = await store.quarantineTemporaryFiles();
      expect(moved).toHaveLength(1);
      expect(await readdir(store.eventsDirectory)).toEqual([]);
      expect(await readdir(store.quarantineDirectory)).toEqual(["event-000000000001.json.tmp-crash"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a committed event authoritative when snapshot/projection work fails afterward", async () => {
    const { root, store } = await storeFixture();
    try {
      const first = makeEvent(1, "run.created", { phaseIds: [], taskIds: [] }, null);
      await store.append(first);
      const failingFs = {
        ...nodeRalphRuntimeFileSystem,
        fsyncDirectory: async () => { throw new Error("injected crash after rename"); },
      };
      const failingStore = new RalphEventStore({ projectRoot: root, runId: "run-1", fs: failingFs });
      const second = makeEvent(2, "run.started", {}, first.eventHash);
      await expect(failingStore.append(second)).rejects.toThrow("injected crash after rename");
      expect((await store.inspect()).lastSequence).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves no committed transition when the crash occurs before or during temp-event durability", async () => {
    const { root, store } = await storeFixture();
    try {
      const first = makeEvent(1, "run.created", { phaseIds: [], taskIds: [] }, null);
      const beforeWrite = new RalphEventStore({
        projectRoot: root,
        runId: "run-1",
        fs: { ...nodeRalphRuntimeFileSystem, writeFile: async () => { throw new Error("crash before temp"); } },
      });
      await expect(beforeWrite.append(first)).rejects.toThrow("crash before temp");
      expect((await store.inspect()).lastSequence).toBe(0);

      const duringTemp = new RalphEventStore({
        projectRoot: root,
        runId: "run-1",
        fs: { ...nodeRalphRuntimeFileSystem, fsyncFile: async () => { throw new Error("crash during temp"); } },
      });
      await expect(duringTemp.append(first)).rejects.toThrow("crash during temp");
      expect((await store.inspect()).lastSequence).toBe(0);
      expect((await store.quarantineTemporaryFiles()).length).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces the V1 event capacity without rollover", () => {
    expect(() => eventFileName(100000)).not.toThrow();
    expect(() => eventFileName(100001)).toThrow("RALPH_INVALID_EVENT_SEQUENCE");
  });

  it("coordinates event durability, reducer application, and snapshot advancement in that order", async () => {
    const { root, store } = await storeFixture();
    try {
      const genesis = createInitialRuntimeState({ runId: "run-1", phases: [], tasks: [] });
      const first = makeEvent(1, "run.created", { phaseIds: [], taskIds: [] }, null);
      const committedFirst = await commitRalphEvent({ store, state: genesis, event: first, writtenAt: "2026-09-05T01:04:00.000Z", fs: nodeRalphRuntimeFileSystem, nonce: "commit-1" });
      expect(committedFirst.eventCommitted).toBe(true);
      expect(committedFirst.state.lastSequence).toBe(1);
      expect((await readStateSnapshot(store))?.lastSequence).toBe(1);

      const second = makeEvent(2, "run.started", {}, first.eventHash);
      const failingFs = { ...nodeRalphRuntimeFileSystem, fsyncFile: async () => { throw new Error("snapshot durability failure"); } };
      await expect(commitRalphEvent({ store, state: committedFirst.state, event: second, writtenAt: "2026-09-05T01:04:01.000Z", fs: failingFs, nonce: "commit-2" })).rejects.toThrow("snapshot durability failure");
      expect((await store.inspect()).lastSequence).toBe(2);
      expect((await readStateSnapshot(store))?.lastSequence).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes competing different payloads with one exclusive winner and one typed fork", async () => {
    const { root } = await storeFixture();
    try {
      const storeA = new RalphEventStore({ projectRoot: root, runId: "run-1" });
      const storeB = new RalphEventStore({ projectRoot: root, runId: "run-1" });
      const first = makeEvent(1, "run.created", { phaseIds: [], taskIds: [] }, null);
      const different = makeEvent(1, "run.created", { phaseIds: ["different"], taskIds: [] }, null);
      const results = await Promise.allSettled([storeA.append(first), storeB.append(different)]);
      expect(results.filter((result) => result.status === "fulfilled" && result.value.committed)).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")?.reason.message).toContain("RALPH_EVENT_SEQUENCE_FORK");
      expect((await readdir(storeA.eventsDirectory)).filter((name) => /^\d{12}\.json$/.test(name))).toEqual(["000000000001.json"]);
      expect([first, different]).toContainEqual(JSON.parse(await readFile(resolve(storeA.eventsDirectory, "000000000001.json"), "utf8")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes competing identical payloads once and treats the loser as idempotent", async () => {
    const { root } = await storeFixture();
    try {
      const storeA = new RalphEventStore({ projectRoot: root, runId: "run-1" });
      const storeB = new RalphEventStore({ projectRoot: root, runId: "run-1" });
      const first = makeEvent(1, "run.created", { phaseIds: [], taskIds: [] }, null);
      const results = await Promise.all([storeA.append(first), storeB.append(first)]);
      expect(results.filter((result) => result.committed)).toHaveLength(1);
      expect(results.filter((result) => !result.committed)).toHaveLength(1);
      expect(JSON.parse(await readFile(resolve(storeA.eventsDirectory, "000000000001.json"), "utf8"))).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the production filesystem lacks exclusive publish capability", async () => {
    const { root } = await storeFixture();
    try {
      const fs = { ...nodeRalphRuntimeFileSystem, capabilities: { ...nodeRalphRuntimeFileSystem.capabilities, exclusiveAtomicPublish: false } };
      const store = new RalphEventStore({ projectRoot: root, runId: "run-1", fs });
      await expect(store.append(makeEvent(1, "run.created", { phaseIds: [], taskIds: [] }, null))).rejects.toThrow("RALPH_STORAGE_DURABILITY_UNSUPPORTED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives storage only below the runtime ownership boundary and rejects unsafe run identities", async () => {
    const { root } = await storeFixture();
    try {
      expect(() => new RalphEventStore({ projectRoot: root, runId: "../.rb" })).toThrow("RALPH_INVALID_RUN_ID");
      expect(() => new RalphEventStore({ projectRoot: root, runId: "/tmp/foreign" })).toThrow("RALPH_INVALID_RUN_ID");
      const store = new RalphEventStore({ projectRoot: root, runId: "safe-run" });
      expect(store.runDirectory).toBe(resolve(root, ".rb-harness", "ralph", "runs", "safe-run"));
      expect(store.runDirectory.startsWith(resolve(root, ".rb-harness", "ralph") + "/")).toBe(true);
      await store.ensureLayout();

      const outside = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-storage-outside-"));
      try {
        await rm(resolve(root, ".rb-harness"), { recursive: true, force: true });
        await mkdir(resolve(root, ".rb-harness"), { recursive: true });
        await symlink(outside, resolve(root, ".rb-harness", "ralph"));
        await expect(store.ensureLayout()).rejects.toThrow("RALPH_RUNTIME_PATH_SYMLINK_ESCAPE");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a verified cursor instead of inspecting event contents on every append", async () => {
    const { root } = await storeFixture();
    try {
      let readdirCount = 0;
      let eventReadCount = 0;
      const fs = {
        ...nodeRalphRuntimeFileSystem,
        readdir: async (path: string) => { readdirCount += 1; return nodeRalphRuntimeFileSystem.readdir(path); },
        readFile: async (path: string) => { if (path.includes("/events/")) eventReadCount += 1; return nodeRalphRuntimeFileSystem.readFile(path); },
      };
      const store = new RalphEventStore({ projectRoot: root, runId: "run-1", fs });
      let previous: string | null = null;
      for (let sequence = 1; sequence <= 8; sequence += 1) {
        const current: RalphEvent = sequence === 1
          ? makeEvent(sequence, "run.created", { phaseIds: [], taskIds: [] }, previous)
          : makeEvent(sequence, "run.started", {}, previous);
        await store.append(current);
        previous = current.eventHash;
      }
      expect(readdirCount).toBe(1);
      expect(eventReadCount).toBe(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a validly rehashed fork in the chain and a foreign run on replay", async () => {
    const { root, store } = await storeFixture();
    try {
      const first = makeEvent(1, "run.created", { phaseIds: [], taskIds: [] }, null);
      const second = makeEvent(2, "run.started", {}, first.eventHash);
      await store.append(first);
      await store.append(second);
      const mutatedUnsigned = { ...second, previousEventHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" };
      const { eventHash: _ignored, ...withoutHash } = mutatedUnsigned;
      await writeFile(resolve(store.eventsDirectory, "000000000002.json"), JSON.stringify({ ...withoutHash, eventHash: sha256(canonicalJson(withoutHash)) }));
      await expect(store.inspect()).rejects.toThrow("RALPH_EVENT_LEDGER_HASH_CHAIN_MISMATCH");

      await rm(resolve(store.eventsDirectory, "000000000002.json"));
      const foreignUnsigned = { ...second, runId: "run-B" };
      const { eventHash: _foreignHash, ...foreignWithoutHash } = foreignUnsigned;
      await writeFile(resolve(store.eventsDirectory, "000000000002.json"), JSON.stringify({ ...foreignWithoutHash, eventHash: sha256(canonicalJson(foreignWithoutHash)) }));
      await expect(store.inspect()).rejects.toThrow("RALPH_EVENT_LEDGER_FOREIGN_RUN");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown envelope and discriminated payload fields even when their hash is valid", async () => {
    const { root, store } = await storeFixture();
    try {
      const first = makeEvent(1, "run.created", { phaseIds: [], taskIds: [] }, null);
      const { eventHash: _ignored, ...unsigned } = first;
      const withUnknownEnvelope = { ...unsigned, surprise: "value", eventHash: sha256(canonicalJson({ ...unsigned, surprise: "value" })) };
      await writeFile(resolve(root, ".rb-harness", "ralph", "runs", "run-1", "events", "000000000001.json"), JSON.stringify(withUnknownEnvelope)).catch(async () => {
        await store.ensureLayout();
        await writeFile(resolve(store.eventsDirectory, "000000000001.json"), JSON.stringify(withUnknownEnvelope));
      });
      await expect(store.inspect()).rejects.toThrow("RALPH_EVENT_UNKNOWN_FIELD");

      await rm(resolve(store.eventsDirectory, "000000000001.json"));
      const payload = { phaseIds: [], taskIds: [], surprise: "value" };
      const withoutPayloadHash = { ...unsigned, payload };
      await writeFile(resolve(store.eventsDirectory, "000000000001.json"), JSON.stringify({ ...withoutPayloadHash, eventHash: sha256(canonicalJson(withoutPayloadHash)) }));
      await expect(store.inspect()).rejects.toThrow("RALPH_EVENT_UNKNOWN_PAYLOAD_FIELD");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
