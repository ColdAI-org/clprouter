// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { relayPlan } from "../src/relay.js";

describe("test-only relay plan", () => {
  it("carries the messages the destination has not received", () => {
    expect(relayPlan({ nextMessageId: 5n, receivedMessageId: 0n }, { receivedMessageId: 2n, ackedMessageId: 0n })).toEqual({ from: 3n, count: 2n, needed: true, partial: false });
  });

  it("relays an acknowledgement alone when there are no new messages", () => {
    expect(relayPlan({ nextMessageId: 3n, receivedMessageId: 4n }, { receivedMessageId: 2n, ackedMessageId: 3n })).toEqual({ from: 3n, count: 0n, needed: true, partial: false });
  });

  it("does nothing when both sides are in sync", () => {
    expect(relayPlan({ nextMessageId: 3n, receivedMessageId: 4n }, { receivedMessageId: 2n, ackedMessageId: 4n }).needed).toBe(false);
  });

  it("caps a bundle and marks it partial", () => {
    expect(relayPlan({ nextMessageId: 21n, receivedMessageId: 0n }, { receivedMessageId: 0n, ackedMessageId: 0n }, 12n)).toEqual({ from: 1n, count: 12n, needed: true, partial: true });
    expect(relayPlan({ nextMessageId: 21n, receivedMessageId: 0n }, { receivedMessageId: 12n, ackedMessageId: 0n }, 12n)).toEqual({ from: 13n, count: 8n, needed: true, partial: false });
  });
});
