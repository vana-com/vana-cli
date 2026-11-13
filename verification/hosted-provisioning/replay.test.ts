import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PersonalServer } from "@/lib/db/neon";

type HoldAt = "reservation" | "provider";

const ports = vi.hoisted(() => ({
  holdAt: "provider" as HoldAt,
  row: null as PersonalServer | null,
  resources: new Set<string>(),
  started: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
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
  findServerById: async (id: string) =>
    ports.row?.id === id ? ports.row : null,
  deleteServer: async (id: string) => {
    if (ports.row?.id === id) ports.row = null;
  },
  updateServer: async (id: string, fields: Partial<PersonalServer>) => {
    if (ports.row?.id !== id) return null;
    ports.row = { ...ports.row, ...fields };
    return ports.row;
  },
  updateServerControlPlaneToken: async () => {},
}));

vi.mock("@/lib/server-provider", () => ({
  getServerProvider: () => ({
    provision: async () => {
      if (ports.holdAt === "provider") {
        ports.started.resolve();
        await ports.release.promise;
      }
      ports.resources.add("fixture-vm");
      return { serverId: "fixture-vm", url: "https://fixture.example" };
    },
    deprovision: ports.deprovision,
  }),
}));

import { GET, POST } from "./route";
import { DELETE } from "./[id]/route";

afterEach(() => vi.unstubAllGlobals());

it.each<HoldAt>(["reservation", "provider"])(
  "replays authenticated DELETE during a held %s response",
  async (holdAt) => {
    ports.row = null;
    ports.holdAt = holdAt;
    ports.started = Promise.withResolvers<void>();
    ports.release = Promise.withResolvers<void>();
    ports.resources.clear();
    ports.deprovision.mockClear();
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
    try {
      await ports.started.promise;
      const listed = await GET(new NextRequest(collection, { headers }));
      const {
        data: [entry],
      } = await listed.json();
      expect(entry).toMatchObject({ state: "provisioning", provider_id: null });

      deleted = await DELETE(
        new NextRequest(`${collection}/${entry.id}`, {
          method: "DELETE",
          headers,
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );
    } finally {
      ports.release.resolve();
    }

    const created = await creating;
    const inventory = await (
      await GET(new NextRequest(collection, { headers }))
    ).json();
    expect(created.status).toBe(201);
    expect(ports.deprovision).not.toHaveBeenCalled();
    expect([...ports.resources]).toEqual(["fixture-vm"]);

    if (process.env.VANA_HOSTED_REPLAY_GUARD === "1") {
      expect(deleted.status).toBe(409);
      expect(inventory.data).toMatchObject([{ provider_id: "fixture-vm" }]);
      return;
    }

    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: true });
    expect(inventory).toMatchObject({ data: [] });
  },
);
