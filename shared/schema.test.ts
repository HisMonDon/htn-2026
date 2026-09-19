import { describe, expect, it } from "vitest";
import { parseCase, safeParseCase } from "./validate";

const gptzero = {
  provider: "gptzero",
  ai_probability: 0.92,
  label: "ai",
  checked_at: "2023-06-01T00:00:00Z",
  flagged_passages: ["Varghese v. China Southern Airlines"],
};

function baseCase(): any {
  return {
    id: "case-1",
    title: "Fabricated case citations",
    falsehood: {
      claim: "Varghese v. China Southern Airlines is a real case",
      why_false: "No such decision exists in any reporter",
      independent_evidence_urls: ["https://example.com/court-order"],
    },
    chain: [
      {
        id: "n1",
        url: "https://example.com/bard",
        publisher: "Google Bard",
        timestamp: "2023-01-01T00:00:00Z",
        excerpt: "Generated citation",
        ai_evidence: gptzero,
        edge: null,
      },
      {
        id: "n2",
        url: "https://example.com/cohen",
        publisher: "Michael Cohen",
        timestamp: "2023-02-01T00:00:00Z",
        excerpt: "Passed citation on",
        ai_evidence: null,
        edge: {
          parent_id: "n1",
          type: "propagation",
          confidence: 0.9,
          basis: "documented",
        },
      },
    ],
    correction: {
      route_type: "form",
      route_url: "https://example.com/correct",
      policy_summary: "Corrections accepted via form",
      draft_fields: { subject: "Correction", body: "Please correct" },
      draft_ready: true,
    },
    approval: { status: "pending", decided_at: null },
    action_log: [],
    verification: { status: "not_started", checked_at: null, observed_change: null },
  };
}

function log(step: string, status: string) {
  return {
    step,
    status,
    timestamp: "2026-01-01T00:00:00Z",
    replay_url: null,
  };
}

function withApproval(status: string) {
  const value = baseCase();
  value.approval = {
    status,
    decided_at: status === "pending" ? null : "2026-01-01T00:00:00Z",
  };
  return value;
}

describe("Case schema basics", () => {
  it("accepts a valid case", () => {
    expect(() => parseCase(baseCase())).not.toThrow();
  });

  it("rejects confidence above 1", () => {
    const value = baseCase();
    value.chain[1].edge.confidence = 1.2;
    expect(safeParseCase(value).success).toBe(false);
  });

  it("rejects confidence below 0", () => {
    const value = baseCase();
    value.chain[1].edge.confidence = -0.1;
    expect(safeParseCase(value).success).toBe(false);
  });

  it("rejects an unknown edge type", () => {
    const value = baseCase();
    value.chain[1].edge.type = "citation";
    expect(safeParseCase(value).success).toBe(false);
  });

  it("rejects duplicate node ids", () => {
    const value = baseCase();
    value.chain[1].id = "n1";
    value.chain[1].edge.parent_id = "n1";
    expect(safeParseCase(value).success).toBe(false);
  });

  it("requires the first node edge to be null", () => {
    const value = baseCase();
    value.chain[0].edge = {
      parent_id: "n0",
      type: "propagation",
      confidence: 0.5,
      basis: "documented",
    };
    expect(safeParseCase(value).success).toBe(false);
  });

  it("requires later edges to point at the previous node", () => {
    const value = baseCase();
    value.chain[1].edge.parent_id = "elsewhere";
    expect(safeParseCase(value).success).toBe(false);
  });

  it("requires an edge on non-first nodes", () => {
    const value = baseCase();
    value.chain[1].edge = null;
    expect(safeParseCase(value).success).toBe(false);
  });
});

describe("falsehood evidence", () => {
  it("fails when only ai_evidence exists and independent evidence is empty", () => {
    const value = baseCase();
    value.falsehood.independent_evidence_urls = [];
    expect(value.chain[0].ai_evidence).not.toBeNull();
    expect(safeParseCase(value).success).toBe(false);
  });

  it("fails when independent evidence is missing entirely", () => {
    const value = baseCase();
    delete value.falsehood.independent_evidence_urls;
    expect(safeParseCase(value).success).toBe(false);
  });

  it("accepts a case with no ai_evidence when independent evidence exists", () => {
    const value = baseCase();
    value.chain[0].ai_evidence = null;
    expect(safeParseCase(value).success).toBe(true);
  });
});

describe("correction rules", () => {
  it('requires empty draft_fields when route_type is "none"', () => {
    const value = baseCase();
    value.correction.route_type = "none";
    value.correction.route_url = null;
    value.correction.draft_ready = false;
    expect(safeParseCase(value).success).toBe(false);
  });

  it('accepts route_type "none" with empty draft_fields', () => {
    const value = baseCase();
    value.correction.route_type = "none";
    value.correction.route_url = null;
    value.correction.draft_ready = false;
    value.correction.draft_fields = { subject: "", body: "" };
    expect(safeParseCase(value).success).toBe(true);
  });

  it("allows draft_ready while approval is pending", () => {
    const value = baseCase();
    value.correction.draft_ready = true;
    value.approval = { status: "pending", decided_at: null };
    expect(safeParseCase(value).success).toBe(true);
  });

  it("rejects the old submit_ready field name being required", () => {
    const value = baseCase();
    delete value.correction.draft_ready;
    value.correction.submit_ready = true;
    expect(safeParseCase(value).success).toBe(false);
  });
});

describe("submit gating", () => {
  for (const status of ["attempted", "completed", "failed"]) {
    it(`rejects a submit step with status ${status} while approval is pending`, () => {
      const value = withApproval("pending");
      value.action_log = [log("submit", status)];
      expect(safeParseCase(value).success).toBe(false);
    });

    it(`rejects a submit step with status ${status} when approval is rejected`, () => {
      const value = withApproval("rejected");
      value.action_log = [log("submit", status)];
      expect(safeParseCase(value).success).toBe(false);
    });
  }

  it("allows a pending submit step while approval is pending", () => {
    const value = withApproval("pending");
    value.action_log = [log("submit", "pending")];
    expect(safeParseCase(value).success).toBe(true);
  });

  it("allows attempted and completed submit steps when approved", () => {
    const value = withApproval("approved");
    value.action_log = [log("submit", "attempted"), log("submit", "completed")];
    expect(safeParseCase(value).success).toBe(true);
  });
});

describe("verify gating", () => {
  it("rejects verify with no submit step", () => {
    const value = withApproval("approved");
    value.action_log = [log("verify", "completed")];
    expect(safeParseCase(value).success).toBe(false);
  });

  it("rejects verify after a failed submit", () => {
    const value = withApproval("approved");
    value.action_log = [log("submit", "failed"), log("verify", "completed")];
    expect(safeParseCase(value).success).toBe(false);
  });

  it("rejects verify after only an attempted submit", () => {
    const value = withApproval("approved");
    value.action_log = [log("submit", "attempted"), log("verify", "completed")];
    expect(safeParseCase(value).success).toBe(false);
  });

  it("rejects verify that comes before the completed submit", () => {
    const value = withApproval("approved");
    value.action_log = [log("verify", "completed"), log("submit", "completed")];
    expect(safeParseCase(value).success).toBe(false);
  });

  it("accepts verify after a completed submit", () => {
    const value = withApproval("approved");
    value.action_log = [
      log("open_source", "completed"),
      log("await_approval", "completed"),
      log("submit", "completed"),
      log("verify", "completed"),
    ];
    expect(safeParseCase(value).success).toBe(true);
  });
});
