import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PersonalServer } from "@/lib/db/neon";

// Which source the runner put in the snapshot:
//   fixed         the routes under review
//   legacy-create the create route before the create-side fix (a55d0a0)
//   legacy-delete the delete route before the conditional delete (a55d0a0)
//   guarded       the routes under review plus a scratch 409 on DELETE while provisioning
type Route = "fixed" | "legacy-create" | "legacy-delete" | "guarded";
// Where the schedule holds things before it lets the create finish:
//   reservation  the create's row insert has returned, the provider is not yet called
//   provider     provision() is pending
//   delete-read  provision() is pending and DELETE has read the row but not yet
//                removed it, so DELETE holds a snapshot with no provider handles
type Schedule = "reservation" | "provider" | "delete-read";

const route = (process.env.VANA_HOSTED_REPLAY ?? "fixed") as Route;
const handles = { tunnelId: "fixture-tunnel", dnsRecordId: "fixture-dns" };

const ports = vi.hoisted(() => ({
  holdAt: "provider" as Schedule,
  row: null as PersonalServer | null,
  resources: new Set<string>(),
  tokens: [] as string[],
  started: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  deleteRead: Promise.withResolvers<void>(),
  deleteReadRelease: Promise.withResolvers<void>(),
  deprovision: vi.fn(),
}));

vi.mock("@/lib/db/neon", () => ({
  findServerByUserId: async (userId: string) =>
    ports.row?.user_id === userId ? ports.row : null,
  insertServerIfNotExists: async (identity: Partial<PersonalServer>) => {
    ports.row = {
      ...identity,
      provider_id: null,
      control_plane_token: null,
      vm_ip: null,
      url: null,
      disk_id: null,
      disk_expires: null,
      tunnel_id: null,
      dns_record_id: null,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    } as PersonalServer;
    const inserted = ports.row;
    if (ports.holdAt === "reservation") {
      ports.started.resolve();
      await ports.release.promise;
    }
    return inserted;
  },
  findServerById: async (id: string) => {
    const found = ports.row?.id === id ? ports.row : null;
    if (found && ports.holdAt === "delete-read") {
      ports.deleteRead.resolve();
      await ports.deleteReadRelease.promise;
    }
    return found;
  },
  deleteServer: async (id: string) => {
    if (ports.row?.id === id) ports.row = null;
  },
  deleteServerIfNoProviderHandles: async (id: string) => {
    const row = ports.row;
    if (row?.id !== id) return false;
    if (row.provider_id || row.tunnel_id || row.dns_record_id) return false;
    ports.row = null;
    return true;
  },
  updateServer: async (id: string, fields: Partial<PersonalServer>) => {
    if (ports.row?.id !== id) return null;
    ports.row = { ...ports.row, ...fields };
    return ports.row;
  },
  updateServerControlPlaneToken: async (_id: string, token: string) => {
    ports.tokens.push(token);
  },
}));

vi.mock("@/lib/server-provider", () => ({
  getServerProvider: () => ({
    provision: async () => {
      if (ports.holdAt !== "reservation") {
        ports.started.resolve();
        await ports.release.promise;
      }
      ports.resources.add("fixture-vm");
      return {
        serverId: "fixture-vm",
        url: "https://fixture.example",
        ...handles,
      };
    },
    deprovision: ports.deprovision,
  }),
}));

import { GET, POST } from "./route";
import { DELETE } from "./[id]/route";

afterEach(() => vi.unstubAllGlobals());

const cleanedUp = {
  delete: 200,
  create: 409,
  deprovision: [["fixture-vm", { ...handles, deadline: expect.any(Number) }]],
  resources: [],
  tokens: 0,
  listed: [],
};
const orphaned = {
  delete: 200,
  create: 201,
  deprovision: [],
  resources: ["fixture-vm"],
  tokens: 1,
  listed: [],
};
// DELETE read the row before the handles were saved, found them on the
// re-read and deprovisioned them.
const lateHandles = {
  delete: 200,
  create: 201,
  deprovision: [["fixture-vm", { ...handles, deadline: expect.any(Number) }]],
  resources: [],
  tokens: 1,
  listed: [],
};
const guarded = {
  delete: 409,
  create: 201,
  deprovision: [],
  resources: ["fixture-vm"],
  tokens: 1,
  listed: ["fixture-vm"],
};

// What the replay must observe for each source and schedule. The fixed create
// route removes what it made after its row was deleted. The fixed delete route
// deprovisions handles saved after it read the row. Each legacy source leaves
// its own window open and the other closed.
const expected: Record<Route, Record<Schedule, typeof cleanedUp>> = {
  fixed: {
    reservation: cleanedUp,
    provider: cleanedUp,
    "delete-read": lateHandles,
  },
  "legacy-create": {
    reservation: orphaned,
    provider: orphaned,
    "delete-read": lateHandles,
  },
  "legacy-delete": {
    reservation: cleanedUp,
    provider: cleanedUp,
    "delete-read": orphaned,
  },
  guarded: {
    reservation: guarded,
    provider: guarded,
    "delete-read": guarded,
  },
};

it.each<Schedule>(["reservation", "provider", "delete-read"])(
  `replays authenticated DELETE against the ${route} route, held at %s`,
  async (holdAt) => {
    ports.row = null;
    ports.holdAt = holdAt;
    ports.started = Promise.withResolvers<void>();
    ports.release = Promise.withResolvers<void>();
    ports.deleteRead = Promise.withResolvers<void>();
    ports.deleteReadRelease = Promise.withResolvers<void>();
    ports.resources.clear();
    ports.tokens = [];
    ports.deprovision.mockReset().mockImplementation(async (id: string) => {
      ports.resources.delete(id);
    });
    vi.stubGlobal("fetch", () => {
      throw new Error("External I/O disabled");
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const signature = await account.signMessage({
      message: "vana-master-key-v1",
    });
    const headers = { authorization: `Bearer ${signature}` };
    const collection = "https://fixture.example/api/servers";
    const creating = POST(
      new NextRequest(collection, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ masterKeySignature: signature }),
      }),
    );

    let deleted: Response;
    let created: Response;
    try {
      await ports.started.promise;
      const listed = await GET(new NextRequest(collection, { headers }));
      const {
        data: [entry],
      } = await listed.json();
      expect(entry).toMatchObject({ state: "provisioning", provider_id: null });

      const deleting = DELETE(
        new NextRequest(`${collection}/${entry.id}`, {
          method: "DELETE",
          headers,
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );
      if (holdAt === "delete-read") {
        // DELETE now holds a row snapshot with no provider handles. Let the
        // create finish and save its handles, then let DELETE continue.
        await ports.deleteRead.promise;
        ports.release.resolve();
        created = await creating;
        ports.deleteReadRelease.resolve();
        deleted = await deleting;
      } else {
        deleted = await deleting;
        ports.release.resolve();
        created = await creating;
      }
    } finally {
      ports.release.resolve();
      ports.deleteReadRelease.resolve();
    }

    const inventory = await (
      await GET(new NextRequest(collection, { headers }))
    ).json();
    expect({
      delete: deleted.status,
      create: created.status,
      deprovision: ports.deprovision.mock.calls,
      resources: [...ports.resources],
      tokens: ports.tokens.length,
      listed: inventory.data.map((e: PersonalServer) => e.provider_id),
    }).toEqual(expected[route][holdAt]);
  },
);
