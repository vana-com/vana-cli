import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryOwnerIdentity } from "../../src/cli/identity.js";
import {
  getAuthFilePath,
  saveCredentials,
  type VanaCredentials,
} from "../../src/cli/auth.js";

const address = "0x1234567890abcdef1234567890abcdef12345678";
const credentials: VanaCredentials = {
  account: {
    address,
    session_token: "private-session",
    expires_at: "2999-01-01T00:00:00Z",
  },
  personal_server: null,
};

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "vana-identity-cache-"));
  vi.stubEnv("VANA_HOME", home);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("owner profile identity", () => {
  it("reports a server-only session without claiming Account authentication", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const serverOnly = {
      account: { ...credentials.account, session_token: "" },
      personal_server: {
        url: "https://self-hosted.example.test",
        session_token: "private-server-session",
        expires_at: "2999-01-01T00:00:00Z",
      },
    };
    expect(await queryOwnerIdentity(serverOnly)).toMatchObject({
      authenticated: false,
      authentication: "personal_server",
      email: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a refreshed profile from cache without a status profile request", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        primary_wallet_address: address,
        email: "owner@example.com",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await queryOwnerIdentity(credentials);
    fetch.mockClear();
    expect(
      await queryOwnerIdentity(credentials, { refresh: false }),
    ).toMatchObject({
      email: "owner@example.com",
      profileStatus: "cached",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caches the supported Account user-id fallback when no wallet is reported", async () => {
    const account = {
      ...credentials,
      account: { ...credentials.account, address: "vana_user_example" },
    };
    const fetch = vi.fn(async () =>
      Response.json({
        vana_user_id: "vana_user_example",
        email: "owner@example.com",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await queryOwnerIdentity(account);
    fetch.mockClear();
    expect(await queryOwnerIdentity(account, { refresh: false })).toMatchObject(
      {
        email: "owner@example.com",
        profileStatus: "cached",
      },
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["session", "account", "deployment"])(
    "never reuses cached identity after a %s change",
    async (change) => {
      const fetch = vi.fn(async () =>
        Response.json({
          primary_wallet_address: address,
          email: "owner@example.com",
        }),
      );
      vi.stubGlobal("fetch", fetch);
      await queryOwnerIdentity(credentials);
      fetch.mockClear();
      const selected = structuredClone(credentials);
      if (change === "session")
        selected.account.session_token = "another-session";
      if (change === "account")
        selected.account.address = "0x9999999999999999999999999999999999999999";
      if (change === "deployment")
        vi.stubEnv("VANA_ACCOUNT_URL", "https://other-account.example.test");
      expect(
        await queryOwnerIdentity(selected, { refresh: false }),
      ).toMatchObject({ email: null });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("keeps a surviving server session identifiable after Account expiry", async () => {
    const expired: VanaCredentials = {
      account: { ...credentials.account, expires_at: "2000-01-01T00:00:00Z" },
      personal_server: {
        url: "https://self-hosted.example.test",
        session_token: "private-server-session",
        expires_at: "2999-01-01T00:00:00Z",
      },
    };
    await saveCredentials(expired);
    const before = await readFile(getAuthFilePath(), "utf8");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await queryOwnerIdentity(null, { refresh: false })).toMatchObject({
      authenticated: false,
      authentication: "personal_server",
      address,
      personalServerUrl: expired.personal_server!.url,
      email: null,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(getAuthFilePath(), "utf8")).toBe(before);
  });

  it("persists only restricted display metadata and preserves existing credentials", async () => {
    await saveCredentials(credentials);
    const before = await readFile(getAuthFilePath(), "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          primary_wallet_address: address,
          email: "owner@example.com",
          session_token: "profile-secret",
          private_key: "private-key",
        }),
      ),
    );
    await queryOwnerIdentity(credentials);
    const cacheDir = join(home, "identity-cache");
    const [file] = await readdir(cacheDir);
    const raw = await readFile(join(cacheDir, file!), "utf8");
    expect(raw).toContain("owner@example.com");
    for (const secret of ["private-session", "profile-secret", "private-key"]) {
      expect(raw).not.toContain(secret);
    }
    if (process.platform !== "win32") {
      expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(cacheDir, file!))).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(getAuthFilePath(), "utf8")).toBe(before);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await queryOwnerIdentity(credentials)).toMatchObject({
      authenticated: true,
      email: "owner@example.com",
      profileStatus: "cached",
    });
    expect(await readFile(getAuthFilePath(), "utf8")).toBe(before);
  });

  it.each(["malformed", "binding"])(
    "ignores a %s display cache",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            primary_wallet_address: address,
            email: "owner@example.com",
          }),
        ),
      );
      await queryOwnerIdentity(credentials);
      const cacheDir = join(home, "identity-cache");
      const [file] = await readdir(cacheDir);
      const cacheFile = join(cacheDir, file!);
      const data = JSON.parse(await readFile(cacheFile, "utf8"));
      if (failure === "binding")
        data.binding.address = "0x9999999999999999999999999999999999999999";
      await writeFile(
        cacheFile,
        failure === "malformed" ? "{broken" : JSON.stringify(data),
      );
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      expect(
        await queryOwnerIdentity(credentials, { refresh: false }),
      ).toMatchObject({
        authenticated: true,
        email: null,
        profileStatus: "not_requested",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps a live login usable when its display cache cannot be written", async () => {
    const blockedHome = join(home, "a-file");
    await writeFile(blockedHome, "existing file");
    vi.stubEnv("VANA_HOME", blockedHome);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          primary_wallet_address: address,
          email: "owner@example.com",
        }),
      ),
    );
    expect(await queryOwnerIdentity(credentials)).toMatchObject({
      authenticated: true,
      email: "owner@example.com",
      profileStatus: "available",
    });
  });

  it("does not persist profile metadata for an unknown environment identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ email: "owner@example.com" })),
    );
    await queryOwnerIdentity({
      ...credentials,
      account: { ...credentials.account, address: "env" },
    });
    expect(await readdir(home)).toEqual([]);
  });

  it("does not label a wallet with another account's profile", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          primary_wallet_address: "0x9999999999999999999999999999999999999999",
          email: "someone-else@example.com",
          amr: ["wallet"],
        }),
      ),
    );
    expect(await queryOwnerIdentity(credentials)).toMatchObject({
      address,
      email: null,
      loginMethod: null,
      profileStatus: "unavailable",
    });
  });

  it("reports an explicit authentication method without guessing from profile email", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          primary_wallet_address: address.toUpperCase(),
          email: "owner@example.com",
          amr: ["wallet"],
        }),
      ),
    );
    expect(await queryOwnerIdentity(credentials)).toMatchObject({
      email: "owner@example.com",
      loginMethod: "wallet",
      profileStatus: "available",
    });
  });

  it.each(["offline", "unauthorized", "malformed"])(
    "retains the local wallet when the profile is %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "offline") throw new Error("offline");
          if (failure === "unauthorized")
            return new Response(null, { status: 401 });
          return Response.json(["not a profile"]);
        }),
      );
      expect(await queryOwnerIdentity(credentials)).toMatchObject({
        authenticated: true,
        address,
        email: null,
        profileStatus: "unavailable",
      });
    },
  );

  it.each([
    null,
    {
      ...credentials,
      account: { ...credentials.account, expires_at: "2000-01-01T00:00:00Z" },
    },
  ])(
    "does not use a missing or expired login to fetch a profile",
    async (login) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      expect(await queryOwnerIdentity(login)).toMatchObject({
        authenticated: false,
        address: null,
        email: null,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
