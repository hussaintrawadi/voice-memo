import { describe, expect, it } from "vitest";
import { planChanges, type Reconciliation } from "../worker/pipeline/reconcile";

type Item = Parameters<typeof planChanges>[1]["open"][number];

const NOW = Date.UTC(2026, 8, 23, 5, 0); // Wed 23 Sep 2026, 10:30 in Kolkata
const ctx = { timezone: "Asia/Kolkata", thoughtId: "th-new", now: NOW };

function item(handle: string, type: Item["type"], text: string, extra: Partial<Item> = {}): Item {
  return {
    handle,
    type,
    id: `${handle.toLowerCase()}-id`,
    isNew: handle.startsWith("N"),
    text,
    projectId: "p1",
    project: "Lumina",
    status: type === "decision" ? "active" : type === "question" ? "open" : "pending",
    due: null,
    remindAt: null,
    at: NOW - 2 * 86_400_000,
    ...extra,
  };
}

// Monday said orange and XYZ; this memo says yellow and ABC.
const items = {
  created: [
    item("ND1", "decision", "Use yellow as the app's main colour"),
    item("NT1", "task", "Build the ABC flow", { status: "suggested" }),
    item("NT2", "task", "Call Priya about pricing", { status: "suggested" }),
    item("NR1", "reminder", "Send the deck", { status: "suggested" }),
  ],
  open: [
    item("T1", "task", "Build the XYZ flow", { status: "accepted", due: "2026-09-24" }),
    item("T2", "task", "Call Priya about pricing", { status: "accepted" }),
    item("T3", "task", "Update the pricing page", { status: "accepted" }),
    item("D1", "decision", "Use orange as the app's main colour"),
    item("R1", "reminder", "Send the deck", { remindAt: NOW + 86_400_000 }),
    item("R2", "reminder", "Book the venue", { remindAt: NOW + 86_400_000 }),
    item("Q1", "question", "Usage-based or fixed pricing?"),
  ],
};

const change = (c: Partial<Reconciliation["changes"][number]>): Reconciliation["changes"][number] => ({
  target: "",
  action: "cancel",
  replaced_by: null,
  new_due_date: null,
  new_remind_at: null,
  new_title: null,
  answer: null,
  evidence: "because I said so",
  ...c,
});
const plan = (...changes: Partial<Reconciliation["changes"][number]>[]) =>
  planChanges({ changes: changes.map(change) }, items, ctx);

describe("planChanges", () => {
  it("replaces an old decision with the new one (orange → yellow)", () => {
    const [p] = plan({ target: "D1", action: "replace", replaced_by: "ND1" });
    expect(p.set).toEqual({ status: "superseded", superseded_by: "nd1-id" });
    expect(p.summary).toBe("Replaced “Use orange as the app's main colour” with “Use yellow as the app's main colour”");
  });

  it("drops a decision when nothing valid replaces it", () => {
    expect(plan({ target: "D1", action: "replace", replaced_by: "D1" })[0].set).toEqual({ status: "reversed" });
    expect(plan({ target: "D1", action: "cancel" })[0].set).toEqual({ status: "reversed" });
  });

  it("swaps an old task for the new one (XYZ → ABC)", () => {
    const [p] = plan({ target: "T1", action: "replace", replaced_by: "NT1" });
    expect(p.set).toEqual({ status: "dismissed" });
    expect(p.summary).toBe("Swapped “Build the XYZ flow” for “Build the ABC flow”");
  });

  it("completes, reschedules and renames tasks", () => {
    expect(plan({ target: "T3", action: "complete" })[0].set).toEqual({
      status: "done",
      completed_at: NOW,
      completed_by_thought_id: "th-new",
    });
    expect(plan({ target: "T1", action: "reschedule", new_due_date: "2026-09-28" })[0].set).toEqual({ due_date: "2026-09-28" });
    expect(plan({ target: "T3", action: "rename", new_title: "Rewrite the pricing page" })[0].set).toEqual({
      title: "Rewrite the pricing page",
    });
  });

  it("ignores malformed or no-op task edits", () => {
    expect(plan({ target: "T1", action: "reschedule", new_due_date: "next friday" })).toEqual([]);
    expect(plan({ target: "T1", action: "reschedule", new_due_date: "2026-09-24" })).toEqual([]); // same date
    expect(plan({ target: "T3", action: "rename", new_title: "  " })).toEqual([]);
  });

  it("cancels and moves reminders, but never into the past", () => {
    expect(plan({ target: "R2", action: "cancel" })[0].set).toEqual({ status: "cancelled" });
    const [moved] = plan({ target: "R1", action: "reschedule", new_remind_at: "2026-09-25T18:00" });
    expect(moved.set).toEqual({ remind_at: Date.UTC(2026, 8, 25, 12, 30), status: "pending", sent_at: null });
    expect(plan({ target: "R1", action: "reschedule", new_remind_at: "2026-09-20T18:00" })).toEqual([]);
  });

  it("answers an open question", () => {
    const [p] = plan({ target: "Q1", action: "answer", answer: "Usage-based, tiered by restaurant size." });
    expect(p.set).toMatchObject({ status: "resolved", resolution: "Usage-based, tiered by restaurant size.", resolved_at: NOW });
  });

  it("drops a task or reminder the memo repeated, keeping the one already open", () => {
    expect(plan({ target: "NT2", action: "duplicate", replaced_by: "T2" })[0].set).toEqual({ status: "dismissed" });
    expect(plan({ target: "NR1", action: "duplicate", replaced_by: "R1" })[0].set).toEqual({ status: "cancelled" });
  });

  it("refuses anything that doesn't fit", () => {
    expect(plan({ target: "T9", action: "cancel" })).toEqual([]); // unknown item
    expect(plan({ target: "D1", action: "complete" })).toEqual([]); // wrong action for a decision
    expect(plan({ target: "Q1", action: "cancel" })).toEqual([]); // questions can only be answered
    expect(plan({ target: "NT1", action: "cancel" })).toEqual([]); // a memo can't cancel its own new items
    expect(plan({ target: "NT2", action: "duplicate", replaced_by: "D1" })).toEqual([]); // duplicate of another kind
  });

  it("changes each item once, and caps the total", () => {
    const twice = plan({ target: "T1", action: "cancel" }, { target: "t1", action: "complete" });
    expect(twice).toHaveLength(1);
    expect(twice[0].action).toBe("cancel");
  });
});
