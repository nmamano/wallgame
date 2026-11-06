import { beforeEach, describe, expect, it } from "bun:test";
import {
  bgsPoolRefusal,
  clearAll,
  createBgs,
  endBgs,
  getBgsCount,
  MAX_SESSIONS,
  MAX_SESSIONS_PER_COMMUNITY_CLIENT,
  MAX_SESSIONS_PER_EVAL_SOURCE,
  OFFICIAL_GAME_RESERVE,
  type BgsOwner,
} from "../../server/games/bgs-store";
import { buildStandardInitialState } from "../../shared/domain/standard-setup";

/**
 * The engine session pool (bgs-store.ts) with its real limits. A guest with an
 * own bot client, or a viewer opening eval bars, used to be able to take all
 * 256 sessions, and then every official bot game forfeited at its start.
 */

const config = {
  variant: "standard" as const,
  boardWidth: 5,
  boardHeight: 5,
  initialState: buildStandardInitialState(5, 5),
};

let nextId = 0;
const create = (owner: BgsOwner) => {
  const id = `pool-${nextId++}`;
  return createBgs(id, "client:bot", id, config, owner);
};

const official: BgsOwner = { kind: "official-game" };
const community = (clientId: string): BgsOwner => ({
  kind: "community-game",
  clientId,
});
const evalFrom = (source: string): BgsOwner => ({ kind: "eval", source });

/** Fills the non-reserved share with community and eval sessions. */
const fillUnreservedShare = () => {
  const share = MAX_SESSIONS - OFFICIAL_GAME_RESERVE;
  for (let i = 0; i < share; i++) {
    const owner =
      i % 2 === 0
        ? community(
            `client-${Math.floor(i / MAX_SESSIONS_PER_COMMUNITY_CLIENT)}`,
          )
        : evalFrom(`10.0.${Math.floor(i / MAX_SESSIONS_PER_EVAL_SOURCE)}.1`);
    expect(create(owner).ok).toBe(true);
  }
  expect(getBgsCount()).toBe(share);
};

describe("engine session pool", () => {
  beforeEach(() => {
    clearAll();
  });

  it("limits each community bot client and each eval source", () => {
    for (let i = 0; i < MAX_SESSIONS_PER_COMMUNITY_CLIENT; i++) {
      expect(create(community("a")).ok).toBe(true);
    }
    expect(create(community("a"))).toEqual({
      ok: false,
      reason: "over-quota",
    });
    expect(create(community("b")).ok).toBe(true);

    for (let i = 0; i < MAX_SESSIONS_PER_EVAL_SOURCE; i++) {
      expect(create(evalFrom("10.0.0.1")).ok).toBe(true);
    }
    expect(bgsPoolRefusal(evalFrom("10.0.0.1"))).toBe("over-quota");
    expect(create(evalFrom("10.0.0.2")).ok).toBe(true);
  });

  it("frees a slot of an owner when one of its sessions ends", () => {
    const first = create(community("a"));
    for (let i = 1; i < MAX_SESSIONS_PER_COMMUNITY_CLIENT; i++) {
      create(community("a"));
    }
    expect(bgsPoolRefusal(community("a"))).toBe("over-quota");
    if (!first.ok) throw new Error("unreachable");
    endBgs(first.session.bgsId);
    expect(create(community("a")).ok).toBe(true);
  });

  it("keeps the reserve for official games when the rest of the pool is full", () => {
    fillUnreservedShare();
    expect(bgsPoolRefusal(community("fresh"))).toBe("at-capacity");
    expect(bgsPoolRefusal(evalFrom("10.9.9.9"))).toBe("at-capacity");

    for (let i = 0; i < OFFICIAL_GAME_RESERVE; i++) {
      expect(create(official).ok).toBe(true);
    }
    expect(getBgsCount()).toBe(MAX_SESSIONS);
    expect(create(official)).toEqual({ ok: false, reason: "at-capacity" });
  });

  it("lets official games use the free part of the whole pool", () => {
    for (let i = 0; i < MAX_SESSIONS; i++) {
      expect(create(official).ok).toBe(true);
    }
    expect(create(official)).toEqual({ ok: false, reason: "at-capacity" });
  });

  it("refuses a duplicate id as its own reason", () => {
    expect(createBgs("same", "client:bot", "same", config, official).ok).toBe(
      true,
    );
    expect(createBgs("same", "client:bot", "same", config, official)).toEqual({
      ok: false,
      reason: "duplicate-id",
    });
  });
});
